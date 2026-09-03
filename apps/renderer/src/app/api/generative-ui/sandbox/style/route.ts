import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const runtime = "nodejs";

/**
 * The sandbox stylesheet: the shared semantic theme tokens plus a minimal
 * reset.
 *
 * The tokens are read from `@ai-browser/ui` rather than restated here, so
 * the generated view resolves `var(--color-accent)` to exactly the value
 * the rest of the workspace uses, in both light and dark, and honours the
 * viewer's reduced-motion preference. Nothing here is generated content --
 * a generated view can only *name* a token, never define one.
 */
let cached: string | null = null;

const RESET = `
html,body{margin:0;min-height:100%;background:var(--color-bg-canvas);color:var(--color-text-primary);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5}
body{overflow-x:hidden}
#root{padding:var(--space-16)}
*,*::before,*::after{box-sizing:border-box}
:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
button{min-height:40px;min-width:40px;font:inherit;color:inherit;background:var(--color-bg-elevated);
  border:1px solid var(--color-border);border-radius:var(--radius-control);padding:0 var(--space-12);cursor:pointer}
select,label{font:inherit;color:inherit}
select{min-height:40px;background:var(--color-bg-surface);color:inherit;border:1px solid var(--color-border);
  border-radius:var(--radius-control);padding:0 var(--space-8)}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--color-border);padding:var(--space-8);text-align:left;vertical-align:top}
h1,h2,h3,h4{margin:0}
p{margin:0}
ul,ol{margin:0;padding-left:var(--space-24)}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
`;

function stylesheet(): string {
  if (cached !== null) return cached;
  // Resolve from the working directory (a real path) rather than
  // `import.meta.url`, which Turbopack rewrites to a virtual `[project]/...`
  // path in the bundled route.
  const require = createRequire(join(process.cwd(), "package.json"));
  const tokens = readFileSync(join(dirname(require.resolve("@ai-browser/ui/package.json")), "src", "tokens.css"), "utf8");
  cached = `${tokens}\n${RESET}`;
  return cached;
}

export function GET(): NextResponse {
  return new NextResponse(stylesheet(), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
