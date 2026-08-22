"""Thin, hand-written validation helpers layered on top of the generated
Pydantic models in `browser_service.contracts.generated`.

Per ADR 0004
(`docs/architecture/decisions/0004-canonical-schema-ownership.md`),
generated files are never hand-edited; any bespoke behavior the generator
cannot express lives here instead, and is wired onto public wrapper
classes in `browser_service/contracts/__init__.py`. Two rules live here
because JSON Schema (and therefore the generated models) cannot express
them structurally:

1. **Recursive credential-field rejection.** Mirrors
   `packages/contracts/src/security/credential-guard.ts` byte-for-byte in
   intent (same forbidden-name pattern, same recursive walk semantics,
   same cycle safety) so a payload that TypeScript rejects is rejected
   here too, and vice versa.
2. **`http`/`https`-only URL scheme.** Mirrors
   `packages/contracts/src/primitives.ts`'s `HttpUrlSchema` refinement.

Both are ordinary Python functions with their own tests
(`services/browser/tests/test_contracts_validators.py`), not just
comments -- see that module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

FORBIDDEN_FIELD_NAME_PATTERN = re.compile(
    r"^(cookie|authorization|auth[-_]?token|set-cookie|headers)$", re.IGNORECASE
)


@dataclass(frozen=True)
class ForbiddenFieldMatch:
    """A single credential-shaped field name found during a recursive scan."""

    path: str
    key: str


class ForbiddenCredentialFieldError(ValueError):
    """Raised when a payload contains a credential-shaped field name.

    Subclasses `ValueError` (not a bare `Exception`) so Pydantic
    `model_validator`/`field_validator` callers can raise it directly and
    have Pydantic fold it into a normal `ValidationError` instead of
    propagating an unhandled exception.
    """

    def __init__(self, matches: list[ForbiddenFieldMatch]) -> None:
        self.matches = matches
        paths = ", ".join(f"'{m.path}'" for m in matches)
        super().__init__(
            f"payload contains credential-shaped field name(s): {paths}. "
            "Reference credentials only via a credentialHandle string."
        )


def find_forbidden_field_paths(value: Any, base_path: str = "") -> list[ForbiddenFieldMatch]:
    """Recursively scans `value` (a JSON-shaped dict/list/scalar tree) for
    any dict key matching `FORBIDDEN_FIELD_NAME_PATTERN`, at any depth,
    including inside lists of dicts. Safe against cyclic references (a
    cycle is simply not re-descended into).
    """
    matches: list[ForbiddenFieldMatch] = []
    seen: set[int] = set()

    def walk(node: Any, path: str) -> None:
        if not isinstance(node, (dict, list)):
            return
        node_id = id(node)
        if node_id in seen:
            return
        seen.add(node_id)

        if isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, f"{path}[{index}]")
            return

        for key, child in node.items():
            child_path = f"{path}.{key}" if path else str(key)
            if isinstance(key, str) and FORBIDDEN_FIELD_NAME_PATTERN.match(key):
                matches.append(ForbiddenFieldMatch(path=child_path, key=key))
            walk(child, child_path)

    walk(value, base_path)
    return matches


def assert_no_forbidden_fields(value: Any, base_path: str = "") -> None:
    """Raises `ForbiddenCredentialFieldError` if any forbidden field name is found."""
    matches = find_forbidden_field_paths(value, base_path)
    if matches:
        raise ForbiddenCredentialFieldError(matches)


def is_http_or_https_url(value: str) -> bool:
    """Returns True iff `value` is an absolute URL with an `http`/`https` scheme."""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)
