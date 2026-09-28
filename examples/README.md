# Examples

Each example is a small shop API with CHAKRA in front of it. From the repository root:

```bash
npm install && npm run build
cd examples/express    # or examples/fastify
npm install && npm start
```

`POST /checkout` is `critical` and `GET /recommendations` is `sheddable`; everything else is `normal`.
When the process runs short of capacity, recommendations are shed first (503 with `Retry-After`)
while checkout keeps working. Scrape `GET /metrics` with Prometheus to watch it happen.

To see it without writing any code, run `npx chakra demo`. To scaffold priorities for your own
app, run `npx chakra init` in its directory.
