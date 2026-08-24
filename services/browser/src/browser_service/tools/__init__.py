"""Tool-specific handler implementations registered in `browser_service.tool_registry`.

Each module here owns exactly one tool's business logic (composing the
lower-level primitives in `browser_service.browser`/`browser_service.extraction`
as needed) and exposes a single async handler function -- never a route,
never a public class hierarchy other tools are meant to extend.
"""

from __future__ import annotations
