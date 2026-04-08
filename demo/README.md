# CHAKRA Demo — Friday Sale Traffic Surge

A self-contained demo that shows CHAKRA protecting an e-commerce API during a simulated Black Friday sale. Traffic surges from 100 to 800 req/sec. CHAKRA automatically activates, suspends low-priority recommendations, protects payment endpoints, and gradually restores when traffic normalises — all in 2 minutes.

## Quick Start (Docker)

```bash
cd demo
docker compose up --build
```

Open [http://localhost:4242](http://localhost:4242) to watch the CHAKRA dashboard in real time.

## Quick Start (Local)

```bash
cd demo
npm install

# Terminal 1 — start the app
node app.js

# Terminal 2 — start the surge
node surge.js
```

Open [http://localhost:4242](http://localhost:4242) to watch the dashboard.

## What To Watch For

| Time        | What Happens                                           |
|-------------|--------------------------------------------------------|
| 0–30s       | Normal traffic. All blocks green. CHAKRA sleeping.     |
| 30–45s      | Traffic ramps to 800 rps. RPM climbs past threshold.   |
| 45s–90s     | **CHAKRA activates.** Recommendations block → red (SUSPENDED). Payment block stays green (PROTECTED). Premium users still served despite surge. |
| 90–105s     | Traffic ramps down. RPM drops below deactivation threshold. |
| 105–120s    | **CHAKRA restores** blocks one level at a time.         |

## Endpoint Reference

| Endpoint                  | Block          | Priority    | Simulated Latency |
|---------------------------|----------------|-------------|--------------------|
| `GET /api/products`       | browse-block   | Normal      | 80–120ms           |
| `GET /api/products/:id`   | browse-block   | Normal      | 40–60ms            |
| `GET /api/search`         | browse-block   | Normal      | 100–150ms          |
| `GET /api/recommendations`| recs-block     | **Low (degrade first)** | 200–400ms |
| `POST /api/cart/add`      | cart-block     | Medium      | 30–50ms            |
| `GET /api/cart`           | cart-block     | Medium      | 20–40ms            |
| `POST /api/checkout`      | payment-block  | **High (always protect)** | 50–80ms  |
| `POST /api/payment/process`| payment-block | **High (always protect)** | 150–250ms|
| `GET /api/auth/verify`    | payment-block  | **High (always protect)** | 20–30ms  |

## User Types

The demo simulates three user types per request:

- **Anonymous** (40%) — no session headers
- **Standard** (45%) — `X-User-Tier: standard`
- **Premium** (15%) — `X-User-Tier: premium` — weight +40, often passes through even during surge
