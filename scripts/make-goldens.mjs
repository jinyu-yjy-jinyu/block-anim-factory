/* 重新生成 fixtures/legacy-golden.json（仅在确认绘制变化是有意的之后运行） */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureAll } from './golden.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = captureAll();
const file = join(root, 'fixtures', 'legacy-golden.json');
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(out, null, 2) + '\n');
const frames = Object.values(out.templates).reduce((n, t) => n + t.frames, 0);
console.log(`已写入 ${file}`);
console.log(`${Object.keys(out.templates).length} 个模板，共 ${frames} 帧`);
