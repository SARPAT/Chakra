'use strict';
// Mounts CHAKRA on an Express or Fastify app with the real adapters. Uses the public
// entry point when chakra() wires them itself (`app.use(c)`, `app.register(c.fastify)`),
// otherwise the adapter modules in dist/ over the same chakra() instance.

const { chakra } = require('../..');

const internal = (mod) => require(`../../dist/${mod}`);
const table = (routes) => internal('priority/route-table').createRouteTable(routes);

function express(app, options) {
  const c = chakra({ logger: false, ...options });
  app.use(
    typeof c === 'function'
      ? c
      : internal('adapters/express').expressMiddleware(c, table(options.routes)),
  );
  return { c, adapter: typeof c === 'function' ? 'public' : 'dist/adapters' };
}

async function fastify(app, options) {
  const c = chakra({ logger: false, ...options });
  const pub = typeof c.fastify === 'function';
  await app.register(
    pub ? c.fastify : internal('adapters/fastify').fastifyPlugin(c, table(options.routes)),
  );
  return { c, adapter: pub ? 'public' : 'dist/adapters' };
}

module.exports = { express, fastify };
