'use strict';
// Mounts CHAKRA through its public API, exactly as an application would.

const { chakra } = require('../..');

function express(app, options) {
  const c = chakra({ logger: false, ...options });
  app.use(c);
  return { c, adapter: 'public' };
}

async function fastify(app, options) {
  const c = chakra({ logger: false, ...options });
  await app.register(c.fastify);
  return { c, adapter: 'public' };
}

module.exports = { express, fastify };
