import { ChatGPTBrowser, defaultProfileDir } from '../../packages/core/src/browser/chatgpt.js';
import { parsePlanResponse } from '../../packages/core/src/browser/parser.js';

const browser = new ChatGPTBrowser(defaultProfileDir('runtime'), false, 'chrome');
await browser.launch();
const t0 = Date.now();
const res = await browser.ask('Reply with exactly one line and nothing else: JARVIS_CONTROLLER_OK');
console.log('elapsed_s:', Math.round((Date.now() - t0) / 1000));
console.log('response:', JSON.stringify(res));
const parsed = parsePlanResponse(res);
console.log('parsed usedFallback:', parsed.usedFallback, '| prompt:', JSON.stringify(parsed.opencodePrompt));
await browser.close();
process.exit(res.includes('JARVIS_CONTROLLER_OK') ? 0 : 1);
