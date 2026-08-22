import { describe, expect, it } from "vitest";
import {
  ForbiddenCredentialFieldError,
  assertNoForbiddenFields,
  findForbiddenFieldPaths,
} from "../src/security/credential-guard.js";

describe("findForbiddenFieldPaths", () => {
  it("returns no matches for a benign nested object", () => {
    const value = {
      message: "hi",
      context: { locale: "en-US", nested: { theme: "dark" } },
      credentialHandle: "vault:acct:123",
    };
    expect(findForbiddenFieldPaths(value)).toEqual([]);
  });

  it.each([
    ["cookie", { cookie: "session=abc" }],
    ["Cookie", { Cookie: "session=abc" }],
    ["authorization", { authorization: "Bearer xyz" }],
    ["Authorization", { Authorization: "Bearer xyz" }],
    ["auth_token", { auth_token: "xyz" }],
    ["auth-token", { "auth-token": "xyz" }],
    ["authtoken", { authtoken: "xyz" }],
    ["set-cookie", { "set-cookie": "a=b" }],
    ["headers", { headers: { "x-foo": "bar" } }],
  ])("flags a top-level '%s' key", (key, value) => {
    const matches = findForbiddenFieldPaths(value);
    expect(matches.map((m) => m.key)).toContain(key);
  });

  it("finds a forbidden key nested one level deep", () => {
    const value = { arguments: { message: "hi", context: { cookie: "session=abc123" } } };
    const matches = findForbiddenFieldPaths(value);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("arguments.context.cookie");
  });

  it("finds a forbidden key nested arbitrarily deep, including inside arrays", () => {
    const value = {
      a: [{ b: { c: [{ d: { authorization: "Bearer xyz" } }] } }],
    };
    const matches = findForbiddenFieldPaths(value);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("a[0].b.c[0].d.authorization");
  });

  it("finds multiple forbidden keys and reports every path", () => {
    const value = { cookie: "a", nested: { headers: { authorization: "b" } } };
    const matches = findForbiddenFieldPaths(value);
    const paths = matches.map((m) => m.path).sort();
    expect(paths).toEqual(["cookie", "nested.headers", "nested.headers.authorization"].sort());
  });

  it("does not flag a legitimate credentialHandle field", () => {
    expect(findForbiddenFieldPaths({ credentialHandle: "vault:acct:123" })).toEqual([]);
  });

  it("does not flag substrings that merely contain a forbidden word (anchored match only)", () => {
    expect(findForbiddenFieldPaths({ cookieConsentGiven: true })).toEqual([]);
    expect(findForbiddenFieldPaths({ myAuthorizationNote: "x" })).toEqual([]);
  });

  it("is safe against cyclic references (does not throw or infinite-loop)", () => {
    const value: Record<string, unknown> = { message: "hi" };
    value.self = value;
    expect(() => findForbiddenFieldPaths(value)).not.toThrow();
  });

  it("ignores non-object/array primitives and null", () => {
    expect(findForbiddenFieldPaths("just a string")).toEqual([]);
    expect(findForbiddenFieldPaths(42)).toEqual([]);
    expect(findForbiddenFieldPaths(null)).toEqual([]);
    expect(findForbiddenFieldPaths(undefined)).toEqual([]);
  });
});

describe("assertNoForbiddenFields", () => {
  it("does not throw for a clean payload", () => {
    expect(() => assertNoForbiddenFields({ message: "hi" })).not.toThrow();
  });

  it("throws ForbiddenCredentialFieldError with the offending paths", () => {
    try {
      assertNoForbiddenFields({ context: { cookie: "x" } });
      throw new Error("expected assertNoForbiddenFields to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenCredentialFieldError);
      expect((err as ForbiddenCredentialFieldError).matches[0]?.path).toBe("context.cookie");
    }
  });
});
