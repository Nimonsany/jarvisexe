import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';

const CHATGPT_URL = 'https://chatgpt.com/';
// Prompt box: ChatGPT uses a contenteditable div#prompt-textarea (textarea historically).
// Logged-in ChatGPT uses div[contenteditable="true"]#prompt-textarea, but the id can vary;
// contenteditable div is the stable signal. textarea variants kept for older UIs.
const PROMPT_SELECTOR = 'div[contenteditable="true"], #prompt-textarea, textarea[data-testid="prompt-textarea"]';
const STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop"], button:has-text("Stop generating")';
const ASSISTANT_SELECTOR = '[data-content-search-unit-key*="assistant"], [data-chatgpt-search-unit-key*="assistant"], [data-message-author-role="assistant"]';

export class ChatGPTBrowser {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private profileDir: string, private headless = false, private channel = 'chrome') {}

  async launch(): Promise<void> {
    if (this.ctx) return;
    this.ctx = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      channel: this.channel,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
    this.page = null;
  }

  /** STOP/cancel: abort any in-flight automation. The in-flight ask() throws
   *  immediately (no retry) so callers can bail out fast. */
  async abort(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    try { await ctx?.close(); } catch { /* already closed */ }
  }

  /** Returns true once logged in; waits for the owner to sign in manually if needed. */
  async ensureLoggedIn(onWait: (msg: string) => void = console.log): Promise<void> {
    if (!this.page) throw new Error('browser not launched');
    await this.page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
      return;
    } catch {
      onWait('Please sign in to ChatGPT in the opened browser window. Waiting up to 5 minutes...');
      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 300_000 });
    }
  }

  private async newConversation(): Promise<void> {
    if (!this.page) throw new Error('browser not launched');
    await this.page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 30_000 });
  }

  /**
   * Send a prompt in a fresh conversation and return the full assistant response text.
   * Retries once on timeout.
   */
  async ask(prompt: string, timeoutMs = 900_000): Promise<string> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.askOnce(prompt, timeoutMs);
      } catch (e) {
        // abort/closure is not retryable — bail immediately (STOP semantics)
        const msg = String(e);
        if (msg.includes('Target closed') || msg.includes('browser has been closed') || msg.includes('Session closed')) throw e;
        if (attempt === 2) throw e;
        console.log(`  [chatgpt] ask attempt ${attempt} failed (${msg.slice(0, 120)}), retrying once...`);
      }
    }
    throw new Error('unreachable');
  }

  private async askOnce(prompt: string, timeoutMs: number): Promise<string> {
    await this.ensureLoggedIn();
    await this.newConversation();
    const page = this.page!;

    const before = await page.locator(ASSISTANT_SELECTOR).count();

    const promptBox = page.locator(PROMPT_SELECTOR).first();
    await promptBox.click();
    // contenteditable: set text + input event; fall back to sequential typing.
    try {
      await promptBox.evaluate((el, text) => {
        (el as HTMLElement).focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }, prompt);
    } catch {
      await promptBox.pressSequentially(prompt.slice(0, 4000), { delay: 1 });
    }
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');

    // Submit confirmation: after Enter, something must happen. If not, click send / retry Enter.
    await page.waitForTimeout(4000);
    const started = await page.locator(ASSISTANT_SELECTOR).count();
    if (started <= before) {
      const sendBtn = page.locator('button[data-testid="send-button"], button[aria-label*="Send"]').first();
      if (await sendBtn.count()) {
        await sendBtn.click().catch(() => {});
      } else {
        await promptBox.click().catch(() => {});
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);
    }

    // Wait until generation finishes (stop button appears then disappears),
    // falling back to stability polling.
    await page.waitForTimeout(2000);
    try {
      await page.waitForSelector(STOP_SELECTOR, { timeout: 20_000 });
      await page.waitForSelector(STOP_SELECTOR, { state: 'detached', timeout: timeoutMs });
    } catch {
      // may already be done or stop button never appeared — fall through to stability polling
    }

    // Poll until the newest assistant message text stops changing.
    let last = '';
    let stable = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const messages = page.locator(ASSISTANT_SELECTOR);
      const count = await messages.count();
      const current = count > before
        ? (await messages.nth(count - 1).innerText().catch(() => '')) ?? ''
        : '';
      if (current && current === last) {
        if (++stable >= 4) return current;
      } else {
        stable = 0;
        last = current;
      }
      await page.waitForTimeout(3000);
    }
    throw new Error('ChatGPT response timed out or never stabilized');
  }
}

export function defaultProfileDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'browser-profile');
}
