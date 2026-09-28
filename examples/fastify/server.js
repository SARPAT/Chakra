// CHAKRA with Fastify: create the instance, register it. That's the whole setup.
const fastify = require('fastify');
const { chakra } = require('chakra-middleware');

const app = fastify();
const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
app.register(c.fastify);

app.get('/metrics', (req, reply) => c.metricsHandler(req.raw, reply.hijack().raw)); // optional
app.post('/checkout', async () => ({ ok: true }));
app.get('/products', async () => [{ id: 1, name: 'Lamp' }]);
// Near the limit, admitted requests are marked degraded: send something cheaper.
app.get('/recommendations', async (req) => (req.chakra?.degraded ? [] : [{ id: 2, name: 'Desk' }]));

app.listen({ port: 3000 }).then(() => console.log('Listening on http://localhost:3000'));
