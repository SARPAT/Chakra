// Copies non-TypeScript runtime assets (e.g. HTML) from src/ into dist/,
// preserving directory layout, since tsc only emits compiled .ts output.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';

const SRC = 'src';
const OUT = 'dist';
const SKIP = new Set(['.ts', '.tsx', '.mts', '.cts']);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (!SKIP.has(extname(name))) {
      const dest = join(OUT, relative(SRC, path));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(path, dest);
    }
  }
}

if (existsSync(SRC)) walk(SRC);
