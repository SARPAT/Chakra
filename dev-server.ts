// dev-server.ts — development server for testing CHAKRA with the dashboard
//
// Run with: npx tsx dev-server.ts
// Dashboard at: http://localhost:4242

import * as express from 'express';
import * as path from 'path';
import { chakra } from './src/index';

// ─── Minimal config ───────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'dev-chakra.yaml');

import * as fs from 'fs';

// ─── Express app ──────────────────────────────────────────────────────────────

const app = (express.default ?? express as unknown as typeof express.default)();
const chakraInstance = chakra(CONFIG_PATH);

// Mount CHAKRA middleware
app.use(chakraInstance.middleware());

// Fake endpoints — registered with blocks so the dashboard shows block state
app.get('/api/products',     chakraInstance.block('api-block'),      (_req, res) => res.json({ products: [] }));
app.get('/api/users/:id',    chakraInstance.block('api-block'),      (_req, res) => res.json({ id: _req.params.id }));
app.post('/api/cart',        chakraInstance.block('api-block'),      (_req, res) => res.status(201).json({ ok: true }));
app.get('/checkout/review',  chakraInstance.block('checkout-block'), (_req, res) => res.json({ total: 99.99 }));
app.get('/static/style.css', chakraInstance.block('static-block'),  (_req, res) => res.send('body{}'));

app.listen(3001, () => {
  console.log('[dev] App server running at http://localhost:3001');
  console.log('[dev] CHAKRA dashboard at http://localhost:4242');
  console.log('[dev] Simulate load: for i in {1..50}; do curl -s http://localhost:3001/api/products > /dev/null & done');
});

// ─── Simulate light background traffic ───────────────────────────────────────
// Send ~5 req/s so the RPM chart has something to show
setInterval(async () => {
  const endpoints = ['/api/products', '/api/users/42', '/checkout/review'];
  const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
  try {
    await fetch(`http://localhost:3001${ep}`).catch(() => {});
  } catch {}
}, 200);
