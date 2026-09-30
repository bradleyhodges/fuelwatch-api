# FuelWatch API documentation

The API documentation site at https://docs.fuelwatch.oss.bhodges.me, built with Next.js and Fumadocs. This project documents the Worker HTTP API. It does not publish or require an SDK.

## Develop and validate

Run from `docs/` with Node.js 24+ and pnpm 11.6.0:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm types:check
pnpm lint
pnpm build
```

Open http://localhost:3000. `pnpm start` serves the production build. `pnpm format` formats source and configuration with the pinned Biome installation; MDX prose is maintained deliberately in its existing reference layout.

Set `NEXT_PUBLIC_SITE_URL=https://docs.fuelwatch.oss.bhodges.me` for production metadata. The API origin is independently configured in `src/lib/shared.ts` and the OpenAPI `servers` list. Building the docs never queries FuelWatch or Google.

## Authoring

- `content/docs` contains the guides and endpoint reference. `meta.json` controls navigation.
- Preserve `ReferenceGrid`, `ReferenceHeader`, `FieldTable`, `CodeRail` and note components for the two-column reference style.
- `public/openapi.json` is the downloadable OpenAPI 3.1 contract. Update it alongside prose when the Worker changes.
- `src/lib/reference-types.ts` derives expandable field tables and type links from the OpenAPI schemas.
- Controlled enums use names from `reference-codes.json` and link to their reference tables. Field/schema description strings support internal Markdown links, such as `[product codes](/docs/api-reference/codes#products)`, in both visual pages and Markdown exports.
- `ApiExample` renders complete validated examples from the specification; illustrative prices are never live data.
- `src/lib/reference-codes.json` is the documentation snapshot of brand, product, feature, restriction and region codes. Never infer identifiers from array positions.
- `src/lib/shared.ts` supplies FuelWatch branding, repository links and the canonical docs origin.
- Search, `/llms.txt`, `/llms-full.txt` and per-page Markdown all use the same content collection.
- `src/lib/reference-markdown.ts` renders reference schemas, field tables and JSON examples into readable Markdown and searchable text. Field-table props must use static literals; the exporter never executes MDX expressions.
- Keep SDK installation, authentication scaffolding and unreleased SDK methods out of this site.

Read `../api/src/{query,jsonapi,station,references,cache,index,errors}.ts` before editing behavioral claims. The tests validate the OpenAPI document and examples, reference codes, links, navigation and search. New routes need prose, a specification operation and validation.

## Repository split

The Worker currently imports its reference registry and logo source from the sibling `hacs-fuelwatch/custom_components/fuelwatch_wa` checkout. Local Worker builds can use that checkout, but a standalone clone needs those migration dependencies relocated or provided. The docs are self-contained: their code snapshot preserves the existing published identifiers and is checked against Worker product/brand/region definitions and controlled vocabulary labels. Once the Worker owns a local registry, keep this snapshot synchronized with it.

Site navigation, contribution links and API metadata examples point to `bradleyhodges/fuelwatch-api`.

## Scope of verification

A successful docs build verifies rendering and static generation. It does not deploy the site, validate production DNS, or prove a particular Worker deployment matches this source contract. Run the Worker's own checks separately after its migration is complete.

