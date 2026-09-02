import "server-only";

/**
 * Capture sanitization (P03-F02 step 4).
 *
 * Runs inside the captured page, on a clone of its live DOM, and returns the
 * bounded HTML the planning model is allowed to read. What survives is the
 * rendered semantic structure, the *visible* content, links, safe media
 * references, forms, ARIA, and layout-relevant styling. What does not:
 * scripts, executable handlers, comments, hidden nodes, credential and
 * hidden form values, and every non-http(s) payload.
 *
 * The hidden-node pass is the reason this happens in-page rather than over a
 * serialized string: text a real reader never sees is the standard indirect
 * prompt-injection vector, and only the page itself knows what was actually
 * laid out.
 *
 * This function is stringified and evaluated by Playwright, so it must be
 * entirely self-contained -- no imports, no closure over module scope.
 */
export interface SanitizedCapture {
  readonly html: string;
  readonly title: string;
  readonly truncated: boolean;
  readonly removedHiddenNodes: number;
}

export interface SanitizeOptions {
  readonly maxBytes: number;
  readonly maxNodes: number;
}

export function sanitizeRenderedDocument(options: SanitizeOptions): SanitizedCapture {
  const DROP_ELEMENTS = new Set([
    "SCRIPT",
    "NOSCRIPT",
    "TEMPLATE",
    "IFRAME",
    "FRAME",
    "FRAMESET",
    "OBJECT",
    "EMBED",
    "APPLET",
    "CANVAS",
    "LINK",
    "BASE",
    "STYLE",
    "PORTAL",
  ]);
  const CREDENTIAL_HINT = /pass|secret|token|csrf|auth|session|otp|cvv|card|account|ssn|pin\b/i;
  const HIDDEN_MARK = "data-capture-hidden";

  const isHidden = (element: Element): boolean => {
    if (element.hasAttribute("hidden")) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (Number.parseFloat(style.opacity || "1") === 0) return true;
    // Off-canvas positioning used to hide text from readers but not parsers.
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && element.childElementCount === 0 && (element.textContent ?? "").trim().length > 0) {
      return true;
    }
    if (rect.right < -2_000 || rect.bottom < -2_000) return true;
    return false;
  };

  let removedHiddenNodes = 0;
  const marked: Element[] = [];
  const liveElements = document.body ? document.body.querySelectorAll("*") : [];
  for (const element of Array.from(liveElements)) {
    if (isHidden(element)) {
      element.setAttribute(HIDDEN_MARK, "1");
      marked.push(element);
    }
  }

  const root = document.documentElement.cloneNode(true) as HTMLElement;
  for (const element of marked) element.removeAttribute(HIDDEN_MARK);

  for (const element of Array.from(root.querySelectorAll(`[${HIDDEN_MARK}]`))) {
    removedHiddenNodes += 1;
    element.remove();
  }

  // Comments can carry both injected instructions and build metadata.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);
  for (const comment of comments) comment.remove();

  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (DROP_ELEMENTS.has(element.tagName)) {
      element.remove();
      continue;
    }
    // A large inline SVG is mostly path data: keep the accessible label and
    // drop the geometry.
    if (element.tagName === "svg" || element.tagName === "SVG") {
      const label = element.getAttribute("aria-label") ?? element.querySelector("title")?.textContent ?? "graphic";
      const placeholder = document.createElement("span");
      placeholder.setAttribute("role", "img");
      placeholder.setAttribute("aria-label", label.slice(0, 200));
      element.replaceWith(placeholder);
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "srcset" || name === "imagesrcset" || name === "integrity" || name === "nonce") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "action" || name === "formaction" || name === "ping" || name === "method") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "src" || name === "poster" || name === "cite" || name === "data") {
        const trimmed = value.trim();
        if (!/^(?:https?:\/\/|\/|\.\.?\/|#|[a-z0-9._~-]+\/)/i.test(trimmed)) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (trimmed.length > 512) element.setAttribute(attribute.name, `${trimmed.slice(0, 512)}...`);
        continue;
      }
      if (name === "style") {
        if (/url\s*\(|expression\s*\(|@import|behavior\s*:/i.test(value)) {
          element.removeAttribute(attribute.name);
        } else if (value.length > 300) {
          element.setAttribute("style", value.slice(0, 300));
        }
        continue;
      }
      if (name.startsWith("data-") && value.length > 120) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (value.length > 2_000) element.setAttribute(attribute.name, value.slice(0, 2_000));
    }
  }

  // Credential and hidden form values never leave the page. The *shape* of
  // the form survives (so the planner still sees that a search or filter
  // exists); the values do not.
  for (const field of Array.from(root.querySelectorAll("input, textarea, select, option"))) {
    const type = (field.getAttribute("type") ?? "").toLowerCase();
    const identity = `${field.getAttribute("name") ?? ""} ${field.getAttribute("id") ?? ""} ${field.getAttribute("autocomplete") ?? ""}`;
    if (type === "password" || type === "hidden" || CREDENTIAL_HINT.test(identity)) {
      field.removeAttribute("value");
      field.textContent = "";
      if (type === "password" || type === "hidden") field.setAttribute("data-value-removed", "1");
      continue;
    }
    const value = field.getAttribute("value");
    if (value && value.length > 200) field.setAttribute("value", value.slice(0, 200));
  }

  // Node bound, applied breadth-first from the end so the document keeps its
  // opening structure rather than losing its head and heading order.
  const all = Array.from(root.querySelectorAll("*"));
  let truncated = false;
  if (all.length > options.maxNodes) {
    truncated = true;
    for (const element of all.slice(options.maxNodes)) element.remove();
  }

  const title = (document.title || "").trim().slice(0, 160);
  let html = root.outerHTML;
  // Collapse the runs of whitespace a formatter left behind; they are a
  // large fraction of a typical serialized DOM and carry nothing.
  html = html.replace(/\s{2,}/g, " ").replace(/>\s+</g, "><");
  if (html.length > options.maxBytes) {
    html = html.slice(0, options.maxBytes);
    truncated = true;
  }
  return { html, title, truncated, removedHiddenNodes };
}
