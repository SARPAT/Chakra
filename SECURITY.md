# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| 0.x     | No        |

## Reporting a vulnerability

Please do not open a public issue. Report privately through [GitHub security advisories](https://github.com/SARPAT/Chakra/security/advisories/new).

Include the affected version, a description of the issue and its impact, and steps or code to reproduce it. You can expect an acknowledgement within three working days and a fix or mitigation plan within fourteen days for confirmed issues. We will credit you in the advisory unless you prefer otherwise.

## Security model

CHAKRA runs inside your application process and is designed to add as little attack surface as possible:

- **No listening ports.** CHAKRA opens no server. The metrics handler is mounted on your own server at a path you choose, so you control who can reach it.
- **No control API.** Band overrides are a function call. Expose them only behind your own authentication.
- **Priority never comes from the client.** Route rules and your `priority(ctx)` resolver decide priority. Resolve identity in your authentication layer; do not map request headers directly to priority, or any client can claim to be critical.
- **No PII stored.** State is in-memory counters and timings. Metric labels are route patterns, bands and decisions; raw paths, user identifiers and bodies are never recorded or logged. Nothing is written to disk.
- **Bounded cardinality.** The number of distinct `route` label values is capped (default 200) so crafted URLs cannot blow up metrics memory.
- **No runtime dependencies** and no native modules, which keeps the supply-chain surface to CHAKRA itself.
- **Fail open.** Internal errors after startup admit the request. A bug in CHAKRA degrades protection, not availability.

Load shedding reduces the impact of overload but is not a DDoS defence. Keep network-level protection and per-client rate limiting in front of your service.
