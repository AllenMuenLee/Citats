# @ai-browser/renderer

Next.js (App Router, strict TypeScript) desktop renderer for the AI-Native
Browser. This is **not** a standalone website -- it is loaded inside the
Electron `BrowserWindow` owned by `apps/desktop` (dev: the Next dev server on
`localhost`; packaged: the `.next/standalone` server spawned as a child
process). See `docs/desktop-architecture-and-ui-specification.md` for the
product form and security boundary, and
`docs/features/p00-f01-monorepo-environment.md` for exact wiring.

## Getting started

Normally started via the root `npm run dev` (which also starts
`services/browser` and Postgres/Redis). To run only this workspace:

```bash
npm run dev --workspace apps/renderer
```

Open [http://localhost:3000](http://localhost:3000) to see the result.

## Theme tokens

Semantic color/spacing/radius tokens come from `@ai-browser/ui` and are
imported once in `src/app/layout.tsx` (`@ai-browser/ui/tokens.css`). Use the
`--color-*`, `--space-*`, and `--radius-*` custom properties -- do not
introduce raw color values in component styles.

## Build output

`next.config.ts` sets `output: "standalone"` so `next build` produces a
minimal self-contained server bundle under `.next/standalone/` that
`apps/desktop`'s packaging step spawns instead of running `next start`
against the full `node_modules` tree.

## Scripts

- `npm run dev --workspace apps/renderer` -- Next dev server.
- `npm run build --workspace apps/renderer` -- production build (standalone output).
- `npm run lint --workspace apps/renderer` -- ESLint.
- `npm run typecheck --workspace apps/renderer` -- `tsc --noEmit`.
