# fuelwatch-js docs

Fumadocs/Next.js documentation site for the `fuelwatch-js` TypeScript SDK.

Run the development server:

```bash
pnpm dev
```

Open http://localhost:3000.

## Commands

```bash
pnpm types:check
pnpm build
```

## Content

- MDX pages live in `content/docs`.
- Fumadocs collection configuration lives in `source.config.ts`.
- Shared docs metadata lives in `src/lib/shared.ts`.

Set `NEXT_PUBLIC_SITE_URL` in deployment so Open Graph image metadata resolves
to the production docs URL.
