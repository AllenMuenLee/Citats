import { z } from "zod";

/**
 * Recursive safeguard against credential-shaped fields anywhere inside a
 * tool-call payload.
 *
 * Argument payloads (`arguments` on an invocation envelope, `payload` on a
 * success result, `partialPayload` on a progress event) are tool-defined
 * objects. Some of those objects intentionally carry an open "extra
 * context" bag (see `tools/system-echo.ts`'s `context` field) so a tool can
 * pass through small amounts of unstructured metadata. That openness is
 * exactly where a raw cookie jar, an `Authorization` header, or a bearer
 * token could get smuggled in by a careless caller -- credentials must
 * NEVER appear in this contract as literal values, only as an opaque
 * `credentialHandle` string (see `primitives.ts`).
 *
 * This module walks a decoded JSON value (object/array/primitive) and
 * rejects it if any object key, at any depth, matches the forbidden-name
 * pattern below -- regardless of whether that object sits behind a
 * `.strict()` schema at the top level (a `.strict()` object only guards its
 * *own* declared keys; it does nothing for an open `z.record(...)`
 * sub-field nested inside it).
 */
export const FORBIDDEN_FIELD_NAME_PATTERN = /^(cookie|authorization|auth[-_]?token|set-cookie|headers)$/i;

export interface ForbiddenFieldMatch {
  /** Dotted/bracketed path to the offending key, e.g. `arguments.context.cookie`. */
  path: string;
  /** The offending key itself. */
  key: string;
}

/**
 * Recursively scans `value` for any plain-object property name matching
 * `FORBIDDEN_FIELD_NAME_PATTERN`. Handles nested objects and arrays of
 * objects, and is safe against cyclic references (a cycle simply stops
 * being re-descended into, it does not throw or loop forever).
 *
 * `basePath` is prepended to every reported path; pass e.g. `"arguments"`
 * when scanning the arguments payload of an invocation envelope so
 * reported paths are unambiguous in logs/test output.
 */
export function findForbiddenFieldPaths(value: unknown, basePath = ""): ForbiddenFieldMatch[] {
  const matches: ForbiddenFieldMatch[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    for (const key of Object.keys(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_FIELD_NAME_PATTERN.test(key)) {
        matches.push({ path: childPath, key });
      }
      walk((node as Record<string, unknown>)[key], childPath);
    }
  };

  walk(value, basePath);
  return matches;
}

export class ForbiddenCredentialFieldError extends Error {
  readonly matches: ForbiddenFieldMatch[];

  constructor(matches: ForbiddenFieldMatch[]) {
    super(
      `payload contains credential-shaped field name(s): ${matches
        .map((m) => `'${m.path}'`)
        .join(", ")}. Reference credentials only via a credentialHandle string.`,
    );
    this.name = "ForbiddenCredentialFieldError";
    this.matches = matches;
  }
}

/** Throws {@link ForbiddenCredentialFieldError} if any forbidden field name is found. */
export function assertNoForbiddenFields(value: unknown, basePath = ""): void {
  const matches = findForbiddenFieldPaths(value, basePath);
  if (matches.length > 0) {
    throw new ForbiddenCredentialFieldError(matches);
  }
}

/**
 * Wraps a Zod schema (typically an envelope object) so that, in addition
 * to its own shape validation, it recursively rejects credential-shaped
 * field names found in a sub-value of the parsed result. `select` picks
 * out the sub-value to scan (e.g. the `arguments` payload of an
 * invocation envelope, or the `payload` of a result) -- default is the
 * whole parsed value. `basePath` is used only to make reported issue
 * paths readable (e.g. `"arguments"` so a violation is reported at
 * `arguments.context.cookie`, not just `context.cookie`).
 *
 * Use this on every schema that embeds an open/tool-defined payload:
 * invocation arguments, success-result payloads, progress-event partial
 * payloads.
 */
export function withCredentialGuard<T extends z.ZodTypeAny>(
  schema: T,
  // Deliberately untyped (`unknown` in, `unknown` out) rather than
  // `z.infer<T>`: with a generic `T extends z.ZodTypeAny`, TS cannot
  // distribute the mapped/conditional types zod v4 uses for object output
  // types, so a concrete `.property` access on `z.infer<T>` fails to
  // typecheck even though it is sound at each (non-generic) call site.
  // Call sites cast their selector's parameter to the concrete shape they
  // already know statically.
  select: (value: unknown) => unknown = (value) => value,
  basePath = "",
): T {
  return schema.superRefine((value, ctx) => {
    const target = select(value);
    const matches = findForbiddenFieldPaths(target, basePath);
    for (const match of matches) {
      ctx.addIssue({
        code: "custom",
        message: `forbidden credential-shaped field name '${match.key}'`,
        path: match.path.split("."),
      });
    }
  }) as unknown as T;
}
