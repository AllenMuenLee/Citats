import { describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/generative-ui/sandbox/route";

describe("generated UI sandbox document", () => {
  it("uses a closed CSP and external bootstrap", async () => { const response = GET(); const body = await response.text(); const csp = response.headers.get("content-security-policy") ?? ""; expect(csp).toContain("default-src 'none'"); expect(csp).toContain("connect-src 'none'"); expect(csp).toContain("form-action 'none'"); expect(csp).not.toContain("unsafe-eval"); expect(body).not.toContain("srcdoc"); expect(body).toContain("/api/generative-ui/sandbox/bootstrap"); });
});
