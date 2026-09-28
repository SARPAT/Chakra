'use strict';
// Mounts CHAKRA on an Express or Fastify app through the public API in dist/.
// Prefers the real adapters (`app.use(c)`, `fastifyPlugin`); until they are exported,
// falls back to a minimal adapter over `c.decide()` and reports `adapter: 'shim'`.

const lib = require('../..');

function writeShed(res, r) {
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  res.writeHead(r.status, {
    ...r.headers,
    'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json',
  });
  res.end(body);
}

function ctxOf(method, path, route, headers, user, raw) {
  return { method, path, route, headers, user, raw };
}

function express(app, options) {
  const c = lib.chakra({ logger: false, ...options });
  if (typeof c === 'function') return (app.use(c), { c, adapter: 'real' });
  if (typeof lib.expressMiddleware === 'function' && typeof lib.createRouteTable === 'function') {
    return (
      app.use(lib.expressMiddleware(c, lib.createRouteTable(options.routes ?? {}))),
      { c, adapter: 'real' }
    );
  }
  app.use((req, res, next) => {
    const d = c.decide(ctxOf(req.method, req.path, undefined, req.headers, req.user, req));
    if (d.outcome === 'shed') return writeShed(res, d.response);
    req.chakra = d.info;
    let done = false;
    const finish = () => done || ((done = true), d.done(res.statusCode, !res.writableFinished));
    res.once('finish', finish).once('close', finish);
    next();
  });
  return { c, adapter: 'shim' };
}

async function fastify(app, options) {
  const c = lib.chakra({ logger: false, ...options });
  if (typeof c.fastify === 'function')
    return (await app.register(c.fastify), { c, adapter: 'real' });
  if (typeof lib.fastifyPlugin === 'function' && typeof lib.createRouteTable === 'function') {
    await app.register(lib.fastifyPlugin(c, lib.createRouteTable(options.routes ?? {})));
    return { c, adapter: 'real' };
  }
  app.addHook('onRequest', (req, reply, next) => {
    const d = c.decide(
      ctxOf(
        req.method,
        req.url.split('?', 1)[0],
        req.routeOptions?.url,
        req.headers,
        req.user,
        req,
      ),
    );
    if (d.outcome === 'shed') {
      reply.hijack();
      return writeShed(reply.raw, d.response);
    }
    req.chakra = d.info;
    req.chakraDone = d.done;
    next();
  });
  app.addHook('onResponse', (req, reply, next) => {
    req.chakraDone?.(reply.statusCode, false);
    next();
  });
  return { c, adapter: 'shim' };
}

module.exports = { express, fastify };
