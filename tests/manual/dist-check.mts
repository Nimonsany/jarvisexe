import path from 'node:path';
import { existsSync } from 'node:fs';
const url = new URL('file:///Users/nimon/Desktop/Jarvisexe/jarvis-orchestrator/packages/core/src/server.ts');
const d = path.resolve(path.dirname(url.pathname), '../../apps/desktop/dist');
console.log('resolved:', d);
console.log('exists:', existsSync(d));
// actual import.meta.url in tsx:
console.log('import.meta.url:', import.meta.url);
process.exit(0);
