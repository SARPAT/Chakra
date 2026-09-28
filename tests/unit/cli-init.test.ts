import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOptions } from '../../src/config/schema';
import { guessPriority, runInit, scanRoutes } from '../../src/cli/init';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chakra-init-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const APP = `
const app = require('express')();
const router = require('express').Router();
app.post('/checkout', pay);
app.get("/api/products/:id", show);
router.get(\`/recommendations\`, recs);
app.put('/api/cart', update);
app.get(\`/users/\${id}\`, skip);   // dynamic path: not a pattern
cache.get(key);                      // not a route
`;

describe('guessPriority', () => {
  it.each([
    ['POST', '/checkout', 'critical'],
    ['POST', '/api/login', 'critical'],
    ['GET', '/healthz', 'critical'],
    ['GET', '/recommendations', 'sheddable'],
    ['GET', '/api/products/:id', 'normal'],
    ['PUT', '/api/cart', 'high'],
  ])('%s %s → %s', (method, path, expected) => {
    expect(guessPriority(method, path)).toBe(expected);
  });
});

describe('scanRoutes', () => {
  it('finds static route declarations and skips node_modules', () => {
    writeFileSync(join(dir, 'app.js'), APP);
    mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/x/index.js'), "app.get('/vendored', h)");
    expect(scanRoutes(dir)).toEqual({
      'GET /api/products/:id': 'normal',
      'GET /recommendations': 'sheddable',
      'POST /checkout': 'critical',
      'PUT /api/cart': 'high',
    });
  });
});

describe('runInit', () => {
  it('writes a config that chakra() accepts, and an Express snippet', () => {
    writeFileSync(join(dir, 'app.js'), APP);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4' } }));
    const r = runInit({ dir });
    expect(r.framework).toBe('express');
    expect(r.snippet).toContain('app.use(c);');
    const config = require(r.file);
    expect(config.routes['POST /checkout']).toBe('critical');
    expect(() => resolveOptions(config, {})).not.toThrow();
  });

  it('detects Fastify and ESM projects', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { fastify: '^4' } }));
    const r = runInit({ dir });
    expect(r.framework).toBe('fastify');
    expect(r.snippet).toContain("import config from './chakra.config.js'");
    expect(readFileSync(r.file, 'utf8')).toContain('export default {');
    expect(readFileSync(r.file, 'utf8')).toContain("// 'POST /checkout': 'critical',");
  });

  it('refuses to overwrite without force', () => {
    writeFileSync(join(dir, 'chakra.config.js'), 'keep me');
    expect(() => runInit({ dir })).toThrow(/already exists/);
    expect(readFileSync(join(dir, 'chakra.config.js'), 'utf8')).toBe('keep me');
    runInit({ dir, force: true });
    expect(readFileSync(join(dir, 'chakra.config.js'), 'utf8')).toContain('module.exports');
  });
});
