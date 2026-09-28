'use strict';
// Benchmark server, run as a child process: `node server.js <framework> <protection> [appKind]`.
//   framework:  express | fastify
//   protection: none | cap | chakra
//   appKind:    hello (tiny JSON, for overhead) | shop (simulated capacity, for overload)
// Sends { port, adapter } to the parent over IPC once listening.

const mount = require('./mount');
const { ROUTES, CAP, handlerFor } = require('./shop');

const [framework = 'express', protection = 'none', appKind = 'hello'] = process.argv.slice(2);
const routes = appKind === 'hello' ? { 'GET /hello': 'normal' } : ROUTES;
const chakraOptions = { routes, ...JSON.parse(process.env.BENCH_CHAKRA_OPTIONS || '{}') };
const handle = appKind === 'hello' ? async () => ({ hello: 'world' }) : handlerFor;

// A fixed concurrency cap that sheds any request above CAP in flight, whatever its route.
function capGate() {
  let inFlight = 0;
  return (res) => {
    if (inFlight >= CAP) {
      res
        .writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
        .end('{"error":"overloaded"}');
      return false;
    }
    inFlight++;
    let released = false;
    const release = () => released || ((released = true), inFlight--);
    res.once('finish', release).once('close', release);
    return true;
  };
}

async function main() {
  let adapter = protection;
  if (framework === 'express') {
    const app = require('express')();
    if (protection === 'cap') {
      const gate = capGate();
      app.use((req, res, next) => gate(res) && next());
    }
    if (protection === 'chakra') adapter = mount.express(app, chakraOptions).adapter;
    for (const key of Object.keys(routes)) {
      const [method, path] = key.split(' ');
      app[method.toLowerCase()](path, (req, res, next) =>
        handle(path, req.chakra).then((body) => res.json(body), next),
      );
    }
    const server = app.listen(0, '127.0.0.1', () => ready(server.address().port, adapter));
    server.keepAliveTimeout = 60_000;
  } else {
    const app = require('fastify')({ logger: false, keepAliveTimeout: 60_000 });
    if (protection === 'cap') {
      const gate = capGate();
      app.addHook('onRequest', (req, reply, next) => (gate(reply.raw) ? next() : reply.hijack()));
    }
    if (protection === 'chakra') adapter = (await mount.fastify(app, chakraOptions)).adapter;
    for (const key of Object.keys(routes)) {
      const [method, path] = key.split(' ');
      app.route({ method, url: path, handler: (req) => handle(path, req.chakra) });
    }
    await app.listen({ port: 0, host: '127.0.0.1' });
    ready(app.server.address().port, adapter);
  }
}

function ready(port, adapter) {
  process.send?.({ port, adapter });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
