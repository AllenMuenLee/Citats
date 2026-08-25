"""Opaque handle minting and the continuation-handle observation store.

An opaque handle (see `packages/contracts/src/page-understanding/common.ts`)
is a server-minted lookup key, local to one observation, that never carries
a selector, DOM path, script, or any other reconstructible detail. This
module mints them and -- for `browser.get_page_understanding_slice`
(P03-F05 step 4) -- holds the full graph an observation produced so a later
handle lookup can be served without re-observing the page.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Any

DEFAULT_OBSERVATION_TTL_SECONDS = 600.0
MAX_STORED_OBSERVATIONS = 200


class HandleMinter:
    """Mints short, opaque, unguessable-enough-for-this-purpose handles
    scoped to one observation. Randomness prevents a caller from enumerating
    adjacent elements even if one valid handle is disclosed.
    """

    def __init__(self, prefix: str) -> None:
        self._prefix = prefix
        self._minted: set[str] = set()
        self._lock = Lock()

    def mint(self) -> str:
        with self._lock:
            while True:
                handle = f"{self._prefix}-{secrets.token_urlsafe(18)}"
                if handle not in self._minted:
                    self._minted.add(handle)
                    return handle


@dataclass(frozen=True)
class StoredObservation:
    observation_id: str
    session_id: str
    owner_id: str
    nodes_by_handle: dict[str, dict[str, Any]]
    relationships_by_from_handle: dict[str, list[dict[str, Any]]]
    region_child_handles: dict[str, list[str]]
    collection_record_handles: dict[str, list[str]]
    created_at: float = field(default_factory=time.monotonic)


class ObservationStore:
    """In-memory, process-local store of recently-observed pages, keyed by
    `observationId`, scoped to the (sessionId, ownerId) that produced them.

    Bounded by count (`MAX_STORED_OBSERVATIONS`, evicting the oldest) and by
    per-entry TTL (`DEFAULT_OBSERVATION_TTL_SECONDS`) -- an evicted or
    expired handle simply returns `found=False` (see
    `browser_service.tools.get_page_understanding_slice`), never another
    session's data and never a raw error.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_OBSERVATION_TTL_SECONDS,
        max_entries: int = MAX_STORED_OBSERVATIONS,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._lock = Lock()
        self._by_id: dict[str, StoredObservation] = {}
        self._order: list[str] = []

    def put(self, observation: StoredObservation) -> None:
        with self._lock:
            if observation.observation_id in self._by_id:
                self._order.remove(observation.observation_id)
            self._by_id[observation.observation_id] = observation
            self._order.append(observation.observation_id)
            while len(self._order) > self._max_entries:
                stale_id = self._order.pop(0)
                self._by_id.pop(stale_id, None)

    def _get_live(self, observation_id: str) -> StoredObservation | None:
        stored = self._by_id.get(observation_id)
        if stored is None:
            return None
        if time.monotonic() - stored.created_at > self._ttl_seconds:
            self._by_id.pop(observation_id, None)
            return None
        return stored

    def get_slice(
        self,
        *,
        observation_id: str,
        handle: str,
        session_id: str,
        owner_id: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool] | None:
        """Returns `(nodes, relationships, found)` for `handle` within
        `observation_id`, or `None` if the observation is unknown, expired,
        or not owned by `(session_id, owner_id)`. `handle` may name a
        region, a collection, or a single node; a region/collection handle
        expands to its bounded child/record node list plus their outgoing
        relationships, a single-node handle returns just that node.
        """
        with self._lock:
            stored = self._get_live(observation_id)
        if stored is None or stored.session_id != session_id or stored.owner_id != owner_id:
            return None

        node_handles: list[str]
        if handle in stored.region_child_handles:
            node_handles = stored.region_child_handles[handle]
        elif handle in stored.collection_record_handles:
            node_handles = stored.collection_record_handles[handle]
        elif handle in stored.nodes_by_handle:
            node_handles = [handle]
        else:
            return [], [], False

        nodes = [stored.nodes_by_handle[h] for h in node_handles if h in stored.nodes_by_handle]
        relationships: list[dict[str, Any]] = []
        for h in node_handles:
            relationships.extend(stored.relationships_by_from_handle.get(h, []))
        return nodes, relationships, True


__all__ = [
    "DEFAULT_OBSERVATION_TTL_SECONDS",
    "HandleMinter",
    "ObservationStore",
    "StoredObservation",
]
