/**
 * Contract versioning.
 *
 * Compatibility rule (applies to every schema in this package):
 *
 *  - `CONTRACT_MAJOR_VERSION` is the single integer that every wire-level
 *    envelope schema (tool definitions, invocations, success/error results,
 *    progress events, cancellation request/result) embeds as its
 *    `contractVersion` field, enforced with `z.literal(CONTRACT_MAJOR_VERSION)`.
 *  - Adding a new **optional** field, widening a numeric/length bound, or
 *    adding a new variant to an already-open extension point does NOT
 *    require bumping `CONTRACT_MAJOR_VERSION` -- both sides must treat an
 *    absent optional field as "not provided" and must not fail closed on it.
 *  - Any of the following IS a breaking change and REQUIRES bumping
 *    `CONTRACT_MAJOR_VERSION` (and updating every producer/consumer in
 *    lockstep, since old and new major versions are not required to
 *    interoperate):
 *      - removing a field, or making a previously-optional field required
 *      - renaming a field
 *      - tightening a previously-open type (e.g. `z.unknown()` ->
 *        a closed shape) in a way that rejects previously-valid payloads
 *      - changing the meaning (not just the membership) of an enum value
 *      - narrowing a numeric/length bound below a value that was
 *        previously accepted
 *      - any other change that would cause a payload valid under the old
 *        version to be rejected, or a payload valid under the new version
 *        to be silently misinterpreted under the old one
 *
 * `packages/contracts`'s own `package.json` `version` field (semver) tracks
 * documentation/tooling revisions within a major contract version (i.e. its
 * major segment is expected to track `CONTRACT_MAJOR_VERSION`, but its
 * minor/patch segments are free to move for non-breaking changes such as
 * new fixtures, generator fixes, or additive optional fields). The
 * `contractVersion` literal is what is actually validated at runtime on
 * every message; the package `version` is informational.
 */
export const CONTRACT_MAJOR_VERSION = 1 as const;
