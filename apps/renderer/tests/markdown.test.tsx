// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/components/chat/markdown";

afterEach(() => cleanup());

describe("renderMarkdown", () => {
  it("renders a heading and a bold run as their own elements", () => {
    render(<div>{renderMarkdown("### **Common Themes:**")}</div>);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading).toHaveTextContent("Common Themes:");
    expect(heading.querySelector("strong")).toHaveTextContent("Common Themes:");
  });

  it("renders plain text with no markdown syntax as an unadorned paragraph", () => {
    render(<div>{renderMarkdown("Hello there")}</div>);
    expect(screen.getByText("Hello there").tagName).toBe("P");
  });

  it("renders an unordered and ordered list from adjacent item lines", () => {
    const { container } = render(<div>{renderMarkdown("- one\n- two\n\n1. first\n2. second")}</div>);
    const ul = container.querySelector("ul");
    const ol = container.querySelector("ol");
    expect(ul?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
    expect(ul).toHaveTextContent("one");
    expect(ol).toHaveTextContent("first");
  });

  it("renders a fenced code block verbatim, without interpreting markdown inside it", () => {
    const { container } = render(<div>{renderMarkdown("```js\nconst x = *not italic*;\n```")}</div>);
    const code = container.querySelector("pre > code");
    expect(code).toHaveTextContent("const x = *not italic*;");
    expect(code?.querySelector("em")).toBeNull();
  });

  it("keeps a citation marker anchored at its original position inside a heading", () => {
    render(<div>{renderMarkdown("### Themes[[m]]", [{ id: "m", citationId: "c1", sourceId: "s1", position: "### Themes".length }])}</div>);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading).toHaveTextContent("Themes");
    expect(screen.getByRole("button", { name: /Citation 1/ })).toBeInTheDocument();
  });

  it("does not render an unsafe link href, falling back to plain text", () => {
    render(<div>{renderMarkdown("[click me](javascript:alert(1))")}</div>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("click me")).toBeInTheDocument();
  });

  it("renders a safe link as an anchor", () => {
    render(<div>{renderMarkdown("[docs](https://example.com/docs)")}</div>);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
