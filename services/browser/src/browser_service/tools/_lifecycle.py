"""Owns the ONE shared :class:`BrowserLifecycleManager` for the whole
service process. Every browser-driving tool gets its page(s) through this
single lazily-created manager -- never a second, independent one -- so the
process's browser-resource limits (`LifecycleConfig.max_concurrent_contexts`
and friends) apply across every tool, not per tool. Private to
`browser_service.tools`; not part of the public tool surface.
"""

from __future__ import annotations

import asyncio

from browser_service.browser import BrowserLifecycleManager

_lifecycle_manager: BrowserLifecycleManager | None = None
_lifecycle_manager_lock = asyncio.Lock()


async def get_lifecycle_manager() -> BrowserLifecycleManager:
    """Lazily creates the one process-wide browser lifecycle manager.

    Lazy (not created at import time) so importing a tool module -- e.g. to
    register it -- never itself launches Chrome; the first real invocation
    pays that cost.
    """
    global _lifecycle_manager
    async with _lifecycle_manager_lock:
        if _lifecycle_manager is None:
            _lifecycle_manager = BrowserLifecycleManager()
        return _lifecycle_manager


__all__ = ["get_lifecycle_manager"]
