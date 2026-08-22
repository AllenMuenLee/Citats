AI-Native Browser — Project Requirements
Draft v1
1. Motivation
Gemini, ChatGPT, and Claude are increasingly replacing the traditional search engine: people ask a question and get a synthesized answer instead of a list of links to click through. But none of them can genuinely browse — take real actions on live websites, read authenticated sessions, or interact with a site's actual functionality beyond a search-and-fetch. On the other side, the current wave of "AI browsers" (Perplexity Comet, ChatGPT Atlas, Opera Neon) bolt agentic browsing onto a fairly conventional browser shell, but the chat/reasoning layer underneath is often less capable or less integrated than the frontier assistants people already use every day.
There is a real gap in the market: no product yet combines a frontier-quality conversational reasoning engine with genuine, first-class browsing and action capability, unified into one native interface. This project aims to close that gap by building an AI-native browser: a chat-first interface where the assistant can read any website, discover and call its underlying APIs, generate task-specific interactive UI on the fly, and — where a site's own interface genuinely matters (Google Docs, Instagram, and similar) — fall back to a real embedded browser view rather than trying to reconstruct it.
Grounding note: field data on real agentic-browser usage (Perplexity/Comet) shows the strongest, best-validated demand is for research, comparison, and drudgery-removal (search, filter, summarize, draft) rather than fully autonomous transactions — actual "buy" or "book" actions remain a small fraction of usage even where the capability exists. The product should be built and sequenced around this evidence: research/decision-support as the core value proposition, with autonomous action execution treated as a carefully gated, secondary capability rather than the headline feature.
2. Features
Core chat interface — persistent conversational entry point with memory of the current session and (later) prior sessions.
Web research & synthesis — multi-source search, comparison, and summarization with inline citations, replacing "ten blue links" with a direct, verifiable answer.
Agentic task execution — multi-step actions (navigate, fill forms, click, submit) carried out on the user's behalf, gated by a confirmation step for anything sensitive (payments, account changes, irreversible submissions).
Dynamic / generative UI — task-specific interactive components (comparison tables, booking widgets, product carousels, forms) rendered on the fly based on the structure of the data or API response the agent retrieves, instead of a static text answer.
API discovery & direct invocation — the agent inspects a site's real network traffic to identify the underlying API calls its frontend makes, then reuses those endpoints directly for faster, more reliable data retrieval and actions.
In-app embedded browser mode — for UI-heavy, stateful, or highly visual platforms (Google Docs, Instagram, and similar), the assistant switches from generated UI to a real, live rendered browser view so the user gets the authentic experience where it matters.
Session & credential management — isolated browser profiles/cookies per site; credentials are handled by the browser layer and never exposed to the LLM directly.
Guardrails — sensitive-action detection, confirmation flows, and defenses against prompt injection from untrusted page content (a known, unresolved risk class in existing AI browsers).
History & continuity — record of past tasks, sites, and outcomes to support follow-up requests and long-running workflows.
Multi-task orchestration — the ability to run more than one browsing task in parallel (e.g., comparing three sites at once) without blocking the chat.
3. Tools
Tool
Role in the system
Key capabilities used
Notes / considerations
Mistral
The reasoning / orchestration "brain"
Conversational chat completion; function/tool calling to decide when and how to browse, search, or act
Needs a reliable, well-tested tool-calling schema — this is the hinge the rest of the system depends on
Vercel AI SDK (UI)
Frontend streaming + generative UI layer
Streams model output to the chat interface; maps structured tool results to matching React components in real time
JavaScript/TypeScript, typically Next.js — needs a defined contract for what shape of tool output maps to which component
Nodriver
The actual browsing engine
Navigates real pages via Chrome DevTools Protocol; reads DOM/page content; intercepts network requests to discover a site's private API calls; executes actions (fill, click, submit); can also stream a live rendered view for the in-app browser fallback
Python-based, stealth-oriented (CDP-native, no Selenium/WebDriver overhead) — this is where most legal/ToS and security risk concentrates, since it is the layer actually touching third-party sites

Architecture note — language bridge: Nodriver is Python; the Vercel AI SDK and Mistral tool-calling loop will most naturally live in a Next.js/TypeScript app. The requirements should explicitly account for a bridge service — e.g., a Python service (FastAPI or similar) wrapping Nodriver and exposing it over REST/WebSocket, called by the Next.js backend. This boundary is a first-class architecture decision, not an implementation detail, since it is where latency, session state, and security review will concentrate.
Supporting infrastructure (recommended additions, not replacements):
A datastore for conversation history, browser session state, and discovered API maps (e.g., Postgres + Redis for hot session state).
A job/worker queue for long-running or parallel browsing tasks (e.g., BullMQ or Celery), since browser automation is not instantaneous.
A secrets/credential vault for any stored site logins, kept out of the LLM's context window entirely.
4. Workflow of the Tools (how they interact)
4.1 Component responsibilities
Frontend (Next.js + Vercel AI SDK): renders the chat, streams model output, renders generative UI components, embeds the live browser view when needed.
Orchestrator (backend): owns the conversation loop — sends messages + tool definitions to Mistral, receives tool calls, dispatches them to the Browser Service, returns results to Mistral and to the frontend.
Mistral: decides whether to answer directly, call a research/search tool, or call a browsing/action tool; drafts the natural-language reply.
Browser Service (Nodriver): executes navigation, reading, API discovery, and actions against real websites; decides (via a site classifier/allowlist) whether a request should be served via generated UI or via the in-app embedded browser.
4.2 Scenario A — research / comparison query
User asks a question → Orchestrator sends it to Mistral with available tools → Mistral calls a "search/browse" tool → Browser Service navigates and reads relevant pages → structured findings return to Mistral → Mistral synthesizes a cited answer → Frontend streams the text response.
4.3 Scenario B — task with dynamic UI
User asks to compare or book something → Mistral calls a "browse + extract" tool → Browser Service navigates the target site and intercepts its network calls to identify the relevant API endpoints → Browser Service calls those endpoints directly for structured data (e.g., prices, availability) → structured result is passed both to Mistral (for reasoning) and to the Vercel AI SDK UI layer → UI layer renders a matching interactive component (e.g., a comparison table or booking widget) → user interacts with the generated component, which sends the next "command" back through the same pipeline.
4.4 Scenario C — sensitive action
Generated UI or agent plan includes a state-changing action (payment, account change, message send, irreversible submission) → Orchestrator's guardrail layer flags it → Frontend shows an explicit confirmation step naming the exact action → only on user confirmation does the Browser Service execute it (either via the discovered API or by simulating the real UI interaction) → result is confirmed back to the user.
4.5 Scenario D — UI-heavy / stateful site (Google Docs, Instagram, etc.)
Mistral or the site classifier recognizes the target as a stateful/visual/collaborative platform → instead of attempting API reconstruction or generative UI, the Browser Service switches to "embedded browser" mode → the real rendered page (via Nodriver's live view) is streamed into the app as an actual browser pane → the user interacts with the authentic site directly, with the assistant available alongside for questions or lightweight actions, not as a replacement interface.
5. Building Steps
Phase 0 — Architecture & environment setup: repo structure, decide and stand up the Python/Nodriver bridge service, define the tool-calling schema contract between Mistral and the Orchestrator.
Phase 1 — Core chat loop: Mistral integration with basic conversation, no browsing yet.
Phase 2 — Read-only browsing: Nodriver navigates and extracts page content/text; agent can fetch and summarize a page with no dynamic UI yet, text answers only.
Phase 3 — API discovery layer: network interception during navigation logs XHR/fetch calls on a small set of pilot sites; build a mapping of discovered endpoints into callable tool functions.
Phase 4 — Generative UI integration: Vercel AI SDK renders matching React components from structured tool output for a small set of pilot use cases (e.g., product search results, flight comparisons).
Phase 5 — Action execution: form fill/submit and direct API calls, gated by the confirmation step and sensitive-action detection.
Phase 6 — In-app embedded browser mode: live rendered view for a whitelisted set of stateful sites (starting with Google Docs and Instagram).
Phase 7 — Session/state persistence: conversation history, browser session state, credential vault, multi-task orchestration.
Phase 8 — Guardrail hardening: prompt-injection defenses, sensitive-domain handling, rate limiting — informed by publicly documented attacks against existing AI browsers.
Phase 9 — Closed alpha: real users on a narrow, research/comparison-first task set (matching validated demand); iterate on findings.
Phase 10 — Broaden coverage: expand site coverage and, only once trust and reliability metrics are strong, expand transaction capabilities.
6. Validation (per stage)
Phase 0/1 (architecture & chat core): tool-call schema correctness — does Mistral reliably emit correctly structured tool calls; latency benchmarks for the round trip; basic instruction-following tests.
Phase 2 (read-only browsing): extraction accuracy against a fixed test set of pages (does the agent correctly answer questions about page content); navigation success rate; Nodriver session resource usage/stability.
Phase 3 (API discovery): endpoint coverage — what percentage of a pilot site's real functionality is reachable via discovered endpoints versus UI-only; stability of the mapping across repeated runs and site updates; a manual legal/ToS review of each pilot site before use.
Phase 4 (generative UI): schema validation tests confirming structured tool output always matches the expected component's prop shape; visual QA across a range of outputs; small user tests on whether generated components are actually clearer than plain text.
Phase 5 (action execution): a sandboxed test suite of "safe" actions run against test accounts/staging sites before any live site is allowed; tracked error/failure rate; confirmation-gate precision (not asking too often or too rarely); security red-teaming specifically for prompt injection, replicating known attack patterns (hidden page text, image-based instructions, look-alike URLs) documented against existing AI browsers.
Phase 6 (embedded browser fallback): classifier accuracy — does the system correctly identify which sites need the real browser view; latency and visual fidelity of the streamed view; usability testing against the "authentic" version of the site.
Phase 7 (session/state): persistence across restarts; data isolation between sites and users; audit that raw credentials never appear anywhere in the LLM's context or logs.
Phase 8 (guardrails): adversarial/red-team testing against known indirect-prompt-injection techniques; measured reduction in successful attack rate over iterations.
Phase 9/10 (alpha and beyond): real usage metrics mapped against the validated-demand categories — track what share of actual usage is research/comparison versus attempted transactions, task completion rate, and user trust/satisfaction — and treat significant divergence from the research-first hypothesis as a signal to revisit the roadmap.
Cross-cutting practice: maintain a fixed "golden test set" of representative tasks across all four categories (research, admin/productivity, shopping-comparison, stateful-app browsing) and re-run it as a regression suite at every phase, not just once at the end.
