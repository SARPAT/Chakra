# Getting started

This guide takes an Express or Fastify app from zero to priority-aware load shedding in about five minutes.

## 1. Install

```bash
npm install chakra-middleware
```

Requires Node.js 18.18+. CHAKRA has no runtime dependencies and no native modules.

## 2. Mount it before your routes

**Express**

```js
const express = require('express');
const { chakra } = require('chakra-middleware');

const app = express();
const c = chakra({
  routes: {
    'POST /checkout': 'critical',
    'POST /login': 'critical',
    'GET /recommendations': 'sheddable',
  },
});
app.use(c);

app.post('/checkout', (req, res) => res.json({ ok: true }));
app.get('/recommendations', (req, res) => res.json(req.chakra?.degraded ? [] : loadRecommendations()));
app.listen(3000);
```

**Fastify**

```js
const fastify = require('fastify');
const { chakra } = require('chakra-middleware');

const app = fastify();
const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
app.register(c.fastify);

app.post('/checkout', async () => ({ ok: true }));
app.get('/recommendations', async (req) => (req.chakra?.degraded ? [] : loadRecommendations()));
app.listen({ port: 3000 });
```

Register CHAKRA before your routes. In Fastify the plugin reads each route's `config.chakra` as the route is added, so routes registered earlier are not seen.

## 3. Declare priorities

Every request lands in one of four bands. Lower bands are refused first when capacity runs short.

| Band        | Typical routes                                 |
| ----------- | ---------------------------------------------- |
| `critical`  | checkout, payment, login, health and readiness |
| `high`      | product pages, search, core APIs               |
| `normal`    | anything you did not tag (the default)         |
| `sheddable` | recommendations, analytics beacons, exports    |

Declare them in one place with `routes`, or next to each route:

```js
const { route } = require('chakra-middleware');

app.post('/checkout', route('critical'), checkoutHandler);          // Express
app.post('/checkout', { config: { chakra: 'critical' } }, handler); // Fastify
```

Route keys are `'METHOD /pattern'`. Patterns support `:param` segments and a trailing `*`; `*` as the method matches any method. When several rules match, the most specific wins. Rules in `routes` take precedence over inline tags for the same method and pattern.

`npx chakra init` scans your project for route declarations and writes a `chakra.config.js` you can review and load with `chakra(require('./chakra.config'))`.

## 4. Raise priority for the right users

```js
const c = chakra({
  routes: { 'GET /api/*': 'normal' },
  priority: (ctx) => (ctx.user?.plan === 'enterprise' ? 'high' : undefined),
});
```

`ctx.user` is whatever your auth middleware put on `req.user`. Return `undefined` to fall through to route rules. Never derive priority from request headers: clients control them.

In Express, mount CHAKRA after your auth middleware if the resolver needs `req.user`. In Fastify, admission runs in `onRequest` by default, before auth hooks; register `c.fastifyPlugin({ hook: 'preHandler' })` instead so it runs after them.

## 5. Serve lighter responses under pressure

Admitted requests carry `req.chakra`:

```ts
{ priority: 'high', degraded: false, wouldShed: false, pressure: 0.42, mode: 'enforce' }
```

When `degraded` is `true` the request's band is close to its limit. Skip optional work (recommendations, personalisation, expensive joins) and answer quickly. That frees capacity and often avoids shedding entirely.

## 6. Watch it work

```bash
npx chakra demo
```

The demo starts a sample shop API behind CHAKRA and overloads it. You will see `sheddable` routes refused while `critical` latency stays flat. Run `npx chakra demo --off` to see the same surge without CHAKRA.

## Next

- [Configuration reference](configuration.md)
- [Production rollout](production-rollout.md): dry-run first, then enforce
- [Operations and FAQ](operations.md)
