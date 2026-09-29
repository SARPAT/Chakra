# Contributing to CHAKRA

Thanks for helping. CHAKRA sits in the request path of other people's production services, so the bar is correctness, a small footprint and measured performance.

## Setup

```bash
git clone https://github.com/SARPAT/Chakra.git
cd Chakra
npm install
npm test
```

Node.js 18.18 or newer.

| Command                                     | What it does                   |
| ------------------------------------------- | ------------------------------ |
| `npm run build`                             | Compile TypeScript to `dist/`  |
| `npm test`                                  | Run all Vitest tests           |
| `npx vitest run tests/unit/<file>.test.ts`  | Run one test file              |
| `npm run typecheck`                         | Type-check sources and tests   |
| `npm run lint`                              | ESLint                         |
| `npm run format`                            | Prettier                       |

CI runs typecheck, lint, tests and build on Node 18, 20 and 22, plus a package smoke test. Run the same locally before opening a pull request.

## Ground rules

1. **Never crash the host app.** After `chakra()` returns, nothing may throw into the request path. On internal failure, admit the request.
2. **Priority is declared, never inferred from client input.** Do not read tiers, sessions or identity from request headers.
3. **No PII.** Never store or log user identifiers, request bodies or raw paths. Metric `route` labels are route patterns or `<unmatched>`, capped in number.
4. **No native dependencies and no listening ports by default.** Adding either needs an ADR.
5. **Test behaviour.** Every feature needs a test through the public API or a real Express/Fastify app, not only unit tests of internals.
6. **Lean and fast.** Prefer deleting code to adding options. Hot-path changes (`decide`, `acquire`, `release`, the adapters) come with a benchmark result from `bench/`.

The design is recorded in [docs/adr/](docs/adr/). The shared contracts in `src/types.ts` change only through an ADR amendment.

## Pull requests

- Keep each pull request focused on one change, and each commit on one logical step with a descriptive message.
- Describe what a user would see before and after the change.
- Update `README.md`, `docs/` and `CHANGELOG.md` (under an `Unreleased` heading) when behaviour or options change.

## Reporting bugs

Open an issue with the Node.js version, framework and version, your CHAKRA options (without secrets) and the smallest reproduction you can manage. For security issues, follow [SECURITY.md](SECURITY.md) instead.

## Releasing

Maintainers only. Releases are published to npm by the release workflow when a version tag is pushed.

1. Make sure the `NPM_TOKEN` repository secret is set.
2. Bump `version` in `package.json` and move the `Unreleased` notes in `CHANGELOG.md` under the new version.
3. Merge to `main`, then push a matching tag, for example `git tag v0.2.0 && git push origin v0.2.0`. The workflow fails if the tag does not match `package.json`.
