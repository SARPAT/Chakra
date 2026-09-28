// `chakra init`: scaffold chakra.config.js from the routes an Express or Fastify app declares.
//
// Route discovery is a static scan of source files, so it never runs application code.
// Priorities are guesses from the path and method; the developer reviews the file.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Priority } from '../types';

export type Framework = 'express' | 'fastify';

export interface InitOptions {
  /** Project directory. Default `process.cwd()`. */
  readonly dir?: string;
  /** Overwrite an existing config file. */
  readonly force?: boolean;
  /** Framework, when it cannot be read from package.json. Default `express`. */
  readonly framework?: Framework;
}

export interface InitResult {
  readonly file: string;
  readonly framework: Framework;
  readonly routes: Readonly<Record<string, Priority>>;
  /** The code to add to the app. */
  readonly snippet: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', 'out']);
const SOURCE = /\.(?:[cm]?js|[cm]?ts)$/;
const ROUTE = /\b\w+\.(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`\s$]*)\2/gi;
const CRITICAL = /checkout|payment|\/pay\b|billing|order|login|logout|sign-?in|sign-?up|auth|token|health|ready|live/i;
const SHEDDABLE = /recommend|suggest|related|trending|popular|analytics|track|telemetry|report|export|feed|preview/i;
const MAX_FILES = 2000;
const MAX_BYTES = 512 * 1024;

/** Guess a route's priority from its method and path. */
export function guessPriority(method: string, path: string): Priority {
  if (CRITICAL.test(path)) return 'critical';
  if (SHEDDABLE.test(path)) return 'sheddable';
  return method === 'GET' ? 'normal' : 'high';
}

/** Find `x.get('/path', ...)`-style route declarations under `dir`, keyed `'METHOD /path'`. */
export function scanRoutes(dir: string): Record<string, Priority> {
  const routes: Record<string, Priority> = {};
  let files = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (files >= MAX_FILES || SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (SOURCE.test(name) && !name.endsWith('.d.ts') && st.size <= MAX_BYTES) {
        files++;
        for (const [, m, , path] of readFileSync(p, 'utf8').matchAll(ROUTE)) {
          const method = m.toUpperCase();
          routes[`${method} ${path}`] = guessPriority(method, path);
        }
      }
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
}
