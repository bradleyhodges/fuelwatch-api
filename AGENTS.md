# AGENTS.md

## Repository purpose and layout

This repository contains the **FuelWatch API**, an independent public API for Western Australian FuelWatch prices and normalized station details.

- `api/`: Cloudflare Worker, TypeScript source, Wrangler configuration, D1 migrations, fixtures and Node/Miniflare tests.
- `docs/`: Next.js/Fumadocs API documentation, MDX reference pages and the downloadable OpenAPI specification.
- `sdk/`: reserved SDK workspace. No implemented or released SDK is assumed; do not invent SDK interfaces or publish SDK documentation.

The Home Assistant integration lives in the separate `hacs-fuelwatch` repository. Do not assume its Python components, tests, dashboard or blueprints exist here.

## Commands

There is no root application package or shared workspace install. Run commands inside the relevant package and use its committed pnpm lockfile.

From `docs/`:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm types:check
pnpm lint
pnpm build
pnpm format
```

From `api/`:

```sh
pnpm install --frozen-lockfile
pnpm run db:migrate:local
pnpm run dev
pnpm run lint
pnpm run type-check
pnpm test
pnpm run build
```

Worker `type-check` regenerates Cloudflare types. Worker `build` is a deployment dry run; it does not publish anything. Local and remote D1 are separate databases. Do not deploy, apply remote migrations, spend Google API budget or push commits without authorization. Local scheduled testing may make paid Google calls when a real key is configured.

## Engineering and API contract

1. Inspect source, types, tests and configuration before changing behavior. Verify current library/service syntax with Context7 or official documentation.
2. Keep changes scoped and production-ready. Add dependencies only with a concrete need; prefer the existing package tooling.
3. Preserve `/v1` JSON:API `serviceStation` resources, grouped `price.products`, numeric cents per litre, AWST timestamps, stable reference codes, case-insensitive filters, selective expansion and documented HTTP/cache semantics unless a requested contract change requires otherwise.
4. Never renumber or recycle brand, feature or restriction codes. Unknown or unavailable values must not become fabricated facts.
5. FuelWatch prices and source identity take precedence over optional Google enrichment. Preserve attribution and unknown source notes.
6. Keep input validation, bounded upstream work, timeouts, cache leases, atomic persistence, safe error messages and structured diagnostics intact.
7. Every database schema change needs a migration. Do not commit D1 state, deployment outputs, API keys, `.dev.vars`, local environment files or credentials.
8. Do not rely on files from a sibling checkout. The Worker currently reads registry/artwork from the sibling hacs-fuelwatch checkout; inspect these migration dependencies when working on its build and keep future code self-contained. Report blocked checks accurately.
9. Use JSDoc for public utilities and non-obvious behavior. Comments should explain constraints and failure handling.

## Documentation conventions

- Treat Worker source as the behavioral authority; `docs/public/openapi.json` and MDX pages must agree with it.
- Preserve the existing reference UI: method badges, two-column `ReferenceGrid`, `FieldTable`, `CodeRail`, expandable type definitions and note callouts.
- Keep examples valid, copyable and explicitly illustrative. Use native HTTP clients until an SDK exists.
- Distinguish publication, price validity, origin fetch time, D1 refresh and rendered response caching.
- Document nullability, omitted fields, aliases, errors and limitations. Do not advertise endpoints, pagination, auth, quotas or guarantees the Worker does not implement.
- Update navigation, search, metadata, repository links and machine-readable content with page changes.
- Validate reference codes, example schemas, internal links, TypeScript and the production docs build. Keep tests independent of live prices and paid Google calls.

## Workflow and Git

Preserve unrelated local changes and inspect the staged diff before committing. Run the relevant checks and fix regressions. Report commands and observed outcomes; never claim unrun checks passed.

Commit each completed major coherent change with a Conventional Commit. Use scopes such as `api`, `docs`, `sdk`, `infra` or `repo`:

```text
feat(api): add a supported price filter
docs(api): document station response expansion
fix(docs): correct reference links
chore(repo): update repository guidance
```

Do not commit temporary debugging, generated caches, broken work, secrets or unrelated user edits. Create a PR or deploy only when requested.

