import { z } from "zod";

/**
 * Shared, closed primitive schemas reused across every contract schema.
 * Keeping these in one place is what lets the recursive credential guard
 * (see `security/credential-guard.ts`) and the drift check reason about a
 * small, stable set of leaf shapes.
 */

/** Max length for any opaque identifier (request/task/user/session/tool-call ids). */
export const ID_MAX_LENGTH = 128;

/**
 * Opaque identifier shape shared by requestId/taskId/userId/sessionId/
 * toolCallId. Deliberately restrictive (alphanumeric + `_`/`-`, must start
 * with an alphanumeric character) so IDs can safely appear in URL path
 * segments, header values, and log lines without further encoding.
 */
export const IdSchema = z
  .string()
  .min(1)
  .max(ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be alphanumeric with '_'/'-', starting with an alphanumeric character");

export const MAX_URL_LENGTH = 2048;

/**
 * URL schema restricted to `http`/`https`. JSON Schema (and therefore the
 * generated Pydantic models) can only capture the `maxLength` bound
 * structurally -- the scheme check is a refinement that does not survive
 * `z.toJSONSchema()`, so the Python side re-implements the same scheme
 * check in `browser_service/contracts/_validators.py` (see that module's
 * docstring, and `docs/features/p00-f03-tool-contract.md`).
 */
export const HttpUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be an absolute URL" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "URL scheme must be 'http' or 'https'" });
    }
  });

/** RFC 3339 / ISO-8601 timestamp with an explicit offset (or `Z`). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const CREDENTIAL_HANDLE_MAX_LENGTH = 200;

/**
 * The ONLY legal way to reference a credential inside a contract payload:
 * an opaque handle (a vault reference ID), never a raw secret value. See
 * `security/credential-guard.ts` for the recursive rejection of
 * cookie/authorization/token/header-shaped fields anywhere in a payload.
 */
export const CredentialHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(CREDENTIAL_HANDLE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/, "must be an opaque handle (letters, digits, '.', '_', ':', '-')");
