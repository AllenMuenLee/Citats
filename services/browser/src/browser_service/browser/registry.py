"""Bookkeeping registry for live browser-context/page resources.

This module holds no browser handles itself (no ``Browser``/``Page``
references) -- it is a pure, lock-protected accounting structure that
``lifecycle.py`` updates as it creates and tears down isolated contexts and
pages. Keeping it separate lets tests assert "no resources leaked" without
needing a live browser.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field


@dataclass
class ManagedContext:
    """Bookkeeping record for one isolated browser context (profile)."""

    context_id: str
    created_at: float
    page_target_ids: set[str] = field(default_factory=set)


class BrowserResourceRegistry:
    """Tracks live isolated contexts and the pages opened within each."""

    def __init__(self) -> None:
        self._contexts: dict[str, ManagedContext] = {}
        self._lock = asyncio.Lock()

    async def register_context(self, context_id: str) -> ManagedContext:
        async with self._lock:
            managed = ManagedContext(context_id=context_id, created_at=time.monotonic())
            self._contexts[context_id] = managed
            return managed

    async def unregister_context(self, context_id: str) -> None:
        async with self._lock:
            self._contexts.pop(context_id, None)

    async def add_page(self, context_id: str, target_id: str) -> None:
        async with self._lock:
            managed = self._contexts.get(context_id)
            if managed is not None:
                managed.page_target_ids.add(target_id)

    async def remove_page(self, context_id: str, target_id: str) -> None:
        async with self._lock:
            managed = self._contexts.get(context_id)
            if managed is not None:
                managed.page_target_ids.discard(target_id)

    def context_count(self) -> int:
        return len(self._contexts)

    def total_page_count(self) -> int:
        return sum(len(managed.page_target_ids) for managed in self._contexts.values())

    def snapshot(self) -> tuple[ManagedContext, ...]:
        return tuple(self._contexts.values())

    def stale_contexts(self, max_age_seconds: float) -> tuple[ManagedContext, ...]:
        """Return contexts older than ``max_age_seconds`` -- candidates for reaping."""
        now = time.monotonic()
        return tuple(
            managed
            for managed in self._contexts.values()
            if now - managed.created_at > max_age_seconds
        )
