// CHAKRA Demo — E-commerce Express API with simulated Friday sale
// Usage: node app.js
// Dashboard: http://localhost:4242

const express = require('express');
const path = require('path');
const { chakra } = require('chakra-middleware');

const app = express();
app.use(express.json());

// ─── Initialise CHAKRA ──────────────────────────────────────────────────────

const configPath = path.join(__dirname, 'chakra.config.yaml');
const chakraInstance = chakra(configPath);
app.use(chakraInstance.middleware());

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// ─── User simulation middleware ─────────────────────────────────────────────

app.use((req, _res, next) => {
  const roll = Math.random();
  if (roll < 0.15) {
    req.headers['x-user-tier'] = 'premium';
    req.headers['x-session-id'] = req.headers['x-session-id'] || `prem-${Math.random().toString(36).slice(2, 10)}`;
  } else if (roll < 0.60) {
    req.headers['x-user-tier'] = 'standard';
    req.headers['x-session-id'] = req.headers['x-session-id'] || `std-${Math.random().toString(36).slice(2, 10)}`;
  }
  // else: anonymous — no headers added
  next();
});

// ─── Request logger middleware ──────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - start;
    const chakraMode = res.getHeader('x-chakra-mode');
    let status = 'SERVED';
    if (res.statusCode === 503) status = 'SUSPENDED';
    else if (chakraMode === 'limited') status = 'LIMITED';
    console.log(`[${timestamp()}] ${req.method} ${req.originalUrl} | ${elapsed}ms | ${status}`);
  });
  next();
});

// ─── Fake data ──────────────────────────────────────────────────────────────

const PRODUCTS = [
  { id: 1, name: 'Wireless Headphones', price: 79.99, stock: 142 },
  { id: 2, name: 'Mechanical Keyboard', price: 129.99, stock: 87 },
  { id: 3, name: 'USB-C Hub', price: 49.99, stock: 231 },
  { id: 4, name: '4K Monitor', price: 399.99, stock: 34 },
  { id: 5, name: 'Ergonomic Mouse', price: 59.99, stock: 198 },
];

// ─── Endpoints ──────────────────────────────────────────────────────────────

// GET /api/products — product listing (browse-block)
app.get('/api/products', chakraInstance.block('browse-block'), async (_req, res) => {
  await delay(80, 120);
  res.json({ products: PRODUCTS });
});

// GET /api/products/:id — single product (browse-block)
app.get('/api/products/:id', chakraInstance.block('browse-block'), async (req, res) => {
  await delay(40, 60);
  const product = PRODUCTS.find((p) => p.id === Number(req.params.id)) || PRODUCTS[0];
  res.json({ product });
});

// GET /api/recommendations — ML recs, deliberately slow (recs-block)
app.get('/api/recommendations', chakraInstance.block('recs-block'), async (_req, res) => {
  await delay(200, 400);
  res.json({
    recommendations: [
      { id: 3, name: 'USB-C Hub', reason: 'Frequently bought together' },
      { id: 5, name: 'Ergonomic Mouse', reason: 'Customers also viewed' },
      { id: 1, name: 'Wireless Headphones', reason: 'Trending this week' },
    ],
  });
});

// GET /api/search — search results (browse-block)
app.get('/api/search', chakraInstance.block('browse-block'), async (_req, res) => {
  await delay(100, 150);
  res.json({ results: PRODUCTS.slice(0, 3), total: 42 });
});

// POST /api/cart/add — add to cart (cart-block)
app.post('/api/cart/add', chakraInstance.block('cart-block'), async (_req, res) => {
  await delay(30, 50);
  res.json({ cart: { items: [{ id: 2, name: 'Mechanical Keyboard', qty: 1 }], total: 129.99 } });
});

// GET /api/cart — view cart (cart-block)
app.get('/api/cart', chakraInstance.block('cart-block'), async (_req, res) => {
  await delay(20, 40);
  res.json({ cart: { items: [], total: 0 } });
});

// POST /api/checkout — checkout (payment-block)
app.post('/api/checkout', chakraInstance.block('payment-block'), async (_req, res) => {
  await delay(50, 80);
  res.json({ orderId: `ORD-${Date.now().toString(36).toUpperCase()}`, status: 'pending' });
});

// POST /api/payment/process — payment gateway (payment-block)
app.post('/api/payment/process', chakraInstance.block('payment-block'), async (_req, res) => {
  await delay(150, 250);
  res.json({ transactionId: `TXN-${Date.now().toString(36).toUpperCase()}`, status: 'success' });
});

// GET /api/auth/verify — auth verification (payment-block)
app.get('/api/auth/verify', chakraInstance.block('payment-block'), async (_req, res) => {
  await delay(20, 30);
  res.json({ valid: true, userId: 'USR-789' });
});

// ─── Start server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║          CHAKRA DEMO — E-Commerce API        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  API Server:    http://localhost:${PORT}        ║`);
  console.log('║  Dashboard:     http://localhost:4242         ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Blocks registered:                          ║');
  console.log('║    browse-block   → /api/products, /search   ║');
  console.log('║    recs-block     → /api/recommendations     ║');
  console.log('║    cart-block     → /api/cart                 ║');
  console.log('║    payment-block  → /api/checkout, /payment   ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Run surge.js to simulate Friday sale!        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
