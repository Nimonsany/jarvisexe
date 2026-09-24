import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';

const CHATGPT_URL = 'https://chatgpt.com/';
// Prompt box: ChatGPT uses a contenteditable div#prompt-textarea (textarea historically).
const PROMPT_SELECTOR = '#prompt-textarea, textarea[data-testid="prompt-textarea"], div[contenteditable="true"]';
const STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop"], button:has-text("Stop generating")';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

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
   */
  async ask(prompt: string, timeoutMs = 480_000): Promise<string> {
    await this.ensureLoggedIn();
    await this.newConversation();
    const page = this.page!;

    const before = await page.locator(ASSISTANT_SELECTOR).count();

    const promptBox = page.locator(PROMPT_SELECTOR).first();
    await promptBox.click();
    // Fill via keyboard-paste for reliability with contenteditable
    await page.evaluate((text) => navigator.clipboard.writeText(text), prompt).catch(() => {});
    await promptBox.fill(prompt).catch(async () => {
      await promptBox.pressSequentially(prompt.slice(0, 2000), { delay: 1 });
    });
    await page.keyboard.press('Enter');

    // Wait until generation starts then finishes (stop button appears then disappears),
    // with a fallback: poll assistant text until stable.
    await page.waitForTimeout(3000);
    try {
      await page.waitForSelector(STOP_SELECTOR, { timeout: 15_000 });
      await page.waitForSelector(STOP_SELECTOR, { state: 'detached', timeout: timeoutMs });
    } catch {
      // generation may already be done or stop button never appeared — fall through to stability polling
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
        if (++stable >= 3) return current;
      } else {
        stable = 0;
        last = current;
      }
      await page.waitForTimeout(2000);
    }
    throw new Error('ChatGPT response timed out or never stabilized');
  }
}

export function defaultProfileDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'browser-profile');
}
