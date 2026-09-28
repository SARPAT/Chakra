// CHAKRA with Express: create the instance, mount it. That's the whole setup.
const express = require('express');
const { chakra } = require('chakra-middleware');

const app = express();
const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
app.use(c);

app.get('/metrics', c.metricsHandler); // Prometheus scrape endpoint (optional)
app.post('/checkout', (req, res) => res.json({ ok: true }));
app.get('/products', (req, res) => res.json([{ id: 1, name: 'Lamp' }]));
// Near the limit, admitted requests are marked degraded: send something cheaper.
app.get('/recommendations', (req, res) =>
  res.json(req.chakra?.degraded ? [] : [{ id: 2, name: 'Desk' }]),
);

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
