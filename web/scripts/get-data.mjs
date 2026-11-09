// Downloads the latest show data (built by the "Build data" GitHub workflow) into web/public/data,
// so `npm run dev` shows the real map. Usage: npm run get-data
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.env.DATA_RELEASE_URL || 'https://github.com/ChinmayaR23/TvMap/releases/download/data/data.tar.gz';
const out = fileURLToPath(new globalThis.URL('../public/data/', import.meta.url));

console.log('Downloading', URL);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`Download failed (HTTP ${res.status}). Has the Build data workflow run yet?`);
  process.exit(1);
}
const file = join(tmpdir(), 'tvgalaxy-data.tar.gz');
writeFileSync(file, Buffer.from(await res.arrayBuffer()));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync('tar', ['-xzf', file, '-C', out], { stdio: 'inherit' }); // tar ships with Windows 10+, macOS and Linux
console.log('Data ready in', out);
