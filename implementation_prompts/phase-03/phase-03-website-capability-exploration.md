# Phase 3 — Website Capability Exploration

## Mission

Allow the agent to observe and understand a rendered public website as a structured, bounded, untrusted page model. Capture visible content, media, layout, semantic relationships, accessibility information, controls, forms, navigation affordances, and other discoverable interaction capabilities so Mistral can understand what the site contains, what a user could do there, and what source material is available for a later generative UI.

This phase does not intercept, infer, persist, expose, or replay website APIs. It does not execute arbitrary controls, submit forms, mutate site state, use authenticated/private data, or treat page content as instructions. It describes capabilities and produces opaque handles and provenance; later phases decide how generated UI is rendered and whether an action may be executed.

## Claude execution restriction

Claude must not create, spawn, delegate to, or use subagents while executing this prompt. Claude must perform all work directly in the primary agent context. This restriction overrides every subagent or agent-based concurrency instruction in this prompt.

## Isolation rule

Use only the requirements, `Claude.md`, this prompt, relevant source, feature docs, and approved-site policy records. Never read another implementation prompt. Tell subagents likewise.

## Required page coverage

The observer must recognize all applicable categories below. A category being absent, hidden, inaccessible, unsupported, cross-origin, truncated, or still loading must be represented explicitly; completeness must never be fabricated.

1. **Document and page metadata:** final/canonical URL, origin, title, language, description, author, publication/update time when trustworthy, favicon, theme color, viewport, document direction, content type, charset, robots hints, and safe social/structured metadata.
2. **Semantic structure and landmarks:** document, main, header, footer, navigation, search, article, section, aside, complementary content, region, banner, content information, headings and hierarchy, address, figure/figcaption, separator, and named ARIA landmarks.
3. **Text and rich content:** paragraphs, spans, labels, headings, quotations, citations, code/preformatted text, keyboard text, definitions, abbreviations, emphasis, strong text, inserted/deleted/marked text, superscript/subscript, time, line breaks, lists, nested lists, description lists, captions, footnotes, breadcrumbs, badges, tags, prices, ratings, availability, status text, and visible CSS-generated text when it materially affects meaning.
4. **Tabular and repeated data:** tables, captions, headers, row/column relationships, grids, tree grids, lists, feeds, cards, search results, product/listing/result collections, timelines, calendars, schedules, comparison groups, pagination state, virtualized collections, and repeated-item field relationships.
5. **Images and graphics:** `img`, responsive `picture`/`source`, background images that convey meaning, image maps/areas, icons, logos, avatars, thumbnails, posters, SVG content, charts, diagrams, maps, and canvas-rendered regions. Capture safe source/provenance, alt/accessibility text, caption, intrinsic/display dimensions, role, surrounding context, and a bounded visual snapshot or derived description only when policy permits; never expose pixels containing private information.
6. **Audio and video:** audio, video, source variants, poster, duration, current/loading/playback state, controls, autoplay/loop/mute state, captions/subtitles/descriptions/chapters tracks, visible transcript, title, and surrounding context. Do not download or transcribe unbounded media in this phase; use bounded public metadata, provided text tracks, and explicit unavailable/truncated states.
7. **Links and navigation:** anchors, areas, same-page links, same-origin links, external links, downloads, mail/telephone links, breadcrumbs, pagination, tabs that change location, history controls exposed by the page, target/disposition, destination origin, relationship attributes, accessible label, and unsafe-protocol classification. Do not follow unsafe or download targets.
8. **Buttons and command controls:** buttons, icon buttons, menu buttons, toggles, disclosure controls, tabs, tab lists/panels, accordions, carousels, steppers, split buttons, toolbar controls, tree controls, context menus, popup triggers, command palettes, copy/share/print controls, media controls, and custom ARIA/widget controls. Capture label, role, state, owning region/form, relationships, declared target, and whether the effect is known, inferred, or unknown.
9. **Forms and user input:** form purpose, action origin when safely available, method classification without values, labels, descriptions, validation messages, fieldsets/legends, text/search/email/tel/url/password/date/time/month/week/number/range/color/file/hidden inputs, textarea, select, option/optgroup, datalist, checkbox, radio, switch, combobox, listbox, autocomplete hints, required/optional/read-only/disabled state, constraints, units, and submit/reset controls. Never capture password values, hidden values, entered personal data, autofill values, cookies, tokens, or credential material; return only redacted structural descriptors and opaque field/form handles.
10. **Feedback and transient UI:** dialogs, modal/non-modal overlays, drawers, sheets, popovers, menus, tooltips, alerts, status messages, toasts, banners, loading indicators, skeletons, progress bars, meters, errors, validation summaries, empty states, cookie/consent notices, permission prompts, and ARIA live regions.
11. **Embedded and special content:** same-origin and cross-origin frames/iframes, portals, objects, embeds, PDFs, maps, third-party widgets, ads, social embeds, web components, open shadow roots, slots, and closed/inaccessible roots. Traverse accessible same-origin/frame/shadow content within bounds; represent inaccessible boundaries by origin, title, role, dimensions, and reason without bypassing browser isolation.
12. **Interaction and accessibility state:** accessibility role/name/description/value, focus order, focusability, keyboard shortcut hints, expanded/pressed/checked/selected/current/busy/invalid/required/disabled/read-only states, active descendant, controls/described-by/labelled-by/owns relationships, drag/drop affordances, resize handles, scroll containers, pointer/keyboard-only behavior, and announced live changes.
13. **Layout and visual relationships:** viewport-relative bounding boxes, visibility, occlusion where practical, reading order, DOM order, z-layer/overlay relationship, grouping, nesting, proximity, alignment, columns, sticky/fixed regions, responsive breakpoint state, scroll position/range, and relationships between media, labels, values, sources, and controls. Capture semantic/layout facts, not full computed-style dumps.
14. **Dynamic application state:** client-rendered updates, lazy-loaded regions, infinite-scroll sentinels, route/view identity, selected filters, sort state, active tab, expanded sections, currently visible result window, hydration/loading completion, and bounded mutations observed during a settle window. Do not observe network traffic or infer APIs.

## Feature builds

### P03-F01 Rendered page observation adapter

- **Tools:** Nodriver/CDP DOM and Accessibility domains, browser adapter interfaces, Pydantic, asyncio, pytest fixtures.
- **Depends on:** P02-F01 and P02-F02.
- **Concurrency:** parallel with P03-F02 and P03-F03 using saved/local fixtures and exclusive files.
- **Build steps:**
  1. Create `services/browser/src/browser_service/page_observation/` with an adapter that observes the post-render page from the existing Phase 2 isolated context. Use DOM and accessibility snapshots plus narrowly scoped computed layout/visibility reads; do not use arbitrary page-authored scripts as an execution mechanism.
  2. Wait through a bounded deterministic settle strategy covering DOM readiness, quiet mutation windows, and configured client-render timeout. Record loading, timeout, unstable, and partial states rather than waiting indefinitely.
  3. Traverse the primary document, accessible same-origin child frames, open shadow roots, and slotted content with cycle detection, depth/node/time limits, cancellation, and cleanup. Emit explicit boundary nodes for cross-origin frames, closed shadow roots, plugins, and otherwise inaccessible content.
  4. Combine DOM semantics with the accessibility tree so custom widgets and accessible names/states are retained. Keep source IDs local to the observation and mint opaque, unguessable server-side handles for elements that later phases may reference.
  5. Collect viewport/layout facts needed to reconstruct grouping and hierarchy: visible bounding boxes, reading order, scroll containers, overlays, sticky/fixed regions, repeated regions, and ownership/label relationships. Avoid bulk computed-style serialization.
  6. Observe bounded dynamic changes during the settle window and merge them deterministically, marking removed, late, virtualized, or unstable nodes. Do not intercept network requests, response bodies, WebSockets, service workers, or browser caches.
- **Validate:** static/client-rendered pages, nested/open-shadow content, same/cross-origin frames, virtualized lists, overlays, lazy content, cancellation/timeouts, deterministic ordering, resource cleanup, and proof that no network interception is enabled.

### P03-F02 Canonical page-understanding graph

- **Tools:** TypeScript source contracts, generated JSON Schema/Pydantic, graph normalization, contract fixtures, property tests.
- **Depends on:** P00-F03; consume P03-F01 observations at integration.
- **Concurrency:** parallel with P03-F01 and P03-F03.
- **Build steps:**
  1. Define a versioned `PageUnderstanding` contract with page metadata, observation status, nodes, relationships, regions, repeated collections, interaction capabilities, source/evidence references, viewport state, warnings, truncation, and an observation digest.
  2. Define a closed node union covering metadata, landmark, text, rich text, list, table/grid, repeated record, image/graphic, SVG/chart, canvas region, audio, video, link, button/control, form, field, option, dialog/overlay, feedback/status, embedded boundary, and unknown semantic element. Preserve meaningful HTML/ARIA specialization inside typed fields rather than returning arbitrary DOM attributes.
  3. Define relationship edges for parent/child, reading order, label/description, control/target, form/field/submit, table header/cell, list/item, media/caption/transcript, record/field/action/source, dialog/trigger, tab/panel, menu/item, disclosure/content, error/field, pagination/collection, and visual grouping.
  4. Define `InteractionCapability` with opaque `capabilityId`, semantic intent, control handle, owning region/form/record, capability kind, current state, required inputs, possible destination origin, effect classification (`local_view`, `navigation`, `data_entry`, `submission`, `download`, `media`, `external_application`, or `unknown`), confidence, evidence, and later-phase requirement. It must not contain selectors, code, API details, credentials, captured field values, or policy authority.
  5. Define `UiSourceCandidate` and repeated-record field mappings so the later generative-UI phase can identify titles, descriptions, images, audio/video, prices, ratings, dates, amenities/features, availability, provider/source, and associated actions without hard-coded site schemas. Preserve original evidence and uncertainty; never guess missing values.
  6. Enforce strict per-node, per-collection, text, media, relationship, depth, and total-payload bounds. Prefer semantic de-duplication, repeated-pattern templates, summaries, and continuation handles over truncating silently; every omission must produce machine-readable coverage information.
- **Validate:** schema roundtrip, unknown-node safety, graph consistency, dangling/cyclic edge rejection where invalid, stable IDs/digests, repeated-record generalization, payload bounds, truncation accounting, and cross-language fixtures.

### P03-F03 Content safety, privacy, and media handling

- **Tools:** redaction/risk scanning, URL/media policy, image-region capture, local malicious fixtures, pytest/property tests.
- **Depends on:** Phase 2 security boundary.
- **Concurrency:** parallel with P03-F01 and P03-F02.
- **Build steps:**
  1. Treat every observed string, accessible name, alt text, transcript, metadata value, SVG label, canvas-derived description, and embedded-widget title as untrusted data. Run the existing credential/high-risk and indirect-instruction scanner before data enters the canonical graph or model context.
  2. Remove scripts, event-handler source, CSS source, hidden field values, password/personal/autofill values, tokens, cookies, storage, authorization material, high-entropy secrets, and raw authenticated/private DOM. Preserve only the minimum structural fact that a sensitive field or inaccessible region exists.
  3. Normalize and classify all URLs. Allow bounded public HTTP(S) media/source references subject to SSRF and protocol policy; block data/blob/file/javascript/custom protocols, credential-bearing URLs, private destinations, downloads, and tracking/query values that are not necessary for provenance.
  4. For images, SVG, charts, canvas, video posters, and visually meaningful background regions, capture bounded thumbnails or safe public references only when required for understanding. Apply dimension/byte/count limits, redact or omit private/sensitive regions, and never persist raw screenshots by default.
  5. Prefer author-provided captions, transcripts, accessible labels, and text tracks for audio/video. Bound cue count/duration/text, do not autoplay media, do not fetch entire streams, and report when media meaning cannot be determined safely.
  6. Make hidden/invisible content unavailable to Mistral except for minimal structural accessibility facts legitimately referenced by visible controls. Detect opacity, off-screen, clipping, `hidden`, `aria-hidden`, collapsed, and occluded prompt-injection patterns and emit security warnings.
- **Validate:** hidden injection, malicious alt/SVG/track text, secret canaries, password/autofill omission, unsafe URLs, oversized media, canvas/private screenshot handling, cross-origin embeds, and zero-sensitive-data snapshots.

### P03-F04 Capability classification and safe state exploration

- **Tools:** deterministic classifier, semantic event metadata, reversible local fixture interactions, state-diff engine, policy tests.
- **Depends on:** P03-F01, P03-F02, and P03-F03.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Classify every observed interactive element by semantic capability and risk using trusted DOM/accessibility facts: local disclosure/view change, navigation, data entry, form submission, account/authentication, download/upload, clipboard/share, communication, reservation/purchase/payment, deletion/cancellation, media control, external application, or unknown.
  2. Infer declared behavior from element type, form ownership/method, accessible role/state, safe destination, relationships, and browser semantics. Page labels may inform display intent but are untrusted and cannot lower risk or establish authority.
  3. In this phase, do not click unknown controls, submit/reset forms, enter data, upload/download, authenticate, grant permissions, launch external applications, start media, change accounts, reserve, purchase, send, delete, or otherwise cause externally observable effects.
  4. Permit an optional policy-controlled exploration mode only on local fixtures or explicitly approved public origins. It may focus/hover, scroll, and activate controls proven to produce reversible local-view changes such as tabs, accordions, menus, dialogs, or carousel pages. Snapshot before/after state, enforce an interaction budget, restore state when possible, and stop immediately on navigation, origin change, form activity, download, permission request, or ambiguous effect.
  5. Merge newly revealed nodes/states into the graph with provenance linking the triggering capability and before/after digest. Describing a capability never makes it executable; all handles remain restricted to later policy/action phases.
  6. Produce a coverage report listing observed controls, safely explored controls, prohibited controls, unknown controls, inaccessible regions, unobserved lazy states, and reasons. Never claim to have found “every action” when bounded or inaccessible states remain.
- **Validate:** tabs, menus, dialogs, accordion, carousel, hover/focus content, navigation buttons, forms, file controls, media, malicious mislabeled buttons, state restoration, budget exhaustion, and proof that public default mode performs no interaction.

### P03-F05 Adaptive website exploration orchestrator

- **Tools:** canonical tool registry, Mistral tool loop, browser-service bridge, page-understanding contracts, Phase 2 evidence/citations, end-to-end fixtures.
- **Depends on:** P03-F01 through P03-F04 and Phase 2 read-only browsing.
- **Concurrency:** integrate after dependencies.
- **Build steps:**
  1. Add a single public `browser.explore_website` tool with URL and bounded user goal only. It must reuse one Phase 2 isolated page/navigation, then observe the rendered page; lower-level DOM/CDP primitives, selectors, capture options, and exploration policy remain server-owned.
  2. Return a canonical bounded result containing Phase 2 document evidence plus `PageUnderstanding`, collections, source candidates, interaction capabilities, media descriptors, coverage, warnings, timing, and `untrusted: true`. Do not return raw HTML, arbitrary attributes, scripts/styles, screenshots by default, network observations, endpoint maps, or callable APIs.
  3. Add request-scoped orchestration: Mistral may use hosted Web Search to find relevant public pages, then call `browser.explore_website` on selected pages. Where resource limits permit, explore independent sites concurrently with isolated contexts and preserve provider-specific failures and provenance.
  4. Serialize only goal-relevant graph slices and bounded summaries to Mistral. Let Mistral request additional slices through opaque continuation/region/collection handles rather than placing the complete graph in every model turn; validate ownership, digest, expiry, and bounds on every request.
  5. Instruct the exploration/orchestration agent to use page content only as evidence, identify records and capabilities relevant to the user's goal, compare sources without merging unsupported fields, and produce a bounded `UiGenerationBrief`. This agent does not write UI code; the dedicated Phase 4 Mistral UI-generation agent writes React from the validated brief and graph slices. Neither agent may create raw website APIs, selectors, executable URLs, or new authority.
  6. Define `UiGenerationBrief` as trusted routing context rather than executable UI code: user goal, prioritized source collections/nodes, comparison requirements, important fields, provenance, freshness, coverage, warnings, desired local interactions, and external capability intents. Validate every reference against the observation and retain uncertainty; do not prescribe a fixed component/template catalogue that prevents Phase 4 from generating a novel composition.
  7. Send the validated page-understanding result, goal-relevant graph slices, bindings, and brief to the Phase 4 generated-code boundary while also returning bounded evidence to Mistral for reasoning. Phase 4 may generate React/TypeScript, but external generated controls still bind only to opaque capability/workflow intents and never directly to a DOM selector, website URL/API, or embedded prompt.
  8. Add adaptive scenarios for accommodation results, retail catalogues, flight/schedule tables, news/articles, media galleries, map/widget pages, forms, dashboards, and a previously unseen mixed-content site. The unfamiliar site must produce a useful generic UI plan without adding site-specific schemas or code.
- **Validate:** Web Search-to-exploration ordering, single-navigation reuse, goal-relevant graph slicing, multi-site isolation, structured-result delivery to Mistral and Phase 4, brief/reference validation, citation/provenance continuity, inaccessible/truncated reporting, and proof that no network/API discovery or action execution occurs.

## Phase acceptance

The fixed exploration suite must demonstrate high semantic coverage across the required page categories, deterministic bounded page graphs, explicit inaccessible/truncated states, useful adaptive generative-UI plans, valid evidence/provenance, safe multi-site isolation, and browser cleanup. Public pages are observed without interaction by default. No network interception, endpoint inference, API replay, form submission, credential access, state-changing action, arbitrary script execution, or direct generated-UI binding to website internals is available in this phase.
