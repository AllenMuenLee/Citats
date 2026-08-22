"""Python-side half of the TS<->Python round-trip check: parses
`packages/contracts/fixtures/invocation/valid-1.json` with
`InvocationSystemEcho`, then re-serializes it and confirms the result is
JSON-equivalent to the fixture (not necessarily key-order-identical).
`packages/contracts/tests/roundtrip.test.ts` performs the matching
construct-and-validate check on the TypeScript side against the same
fixture file.
"""

from __future__ import annotations

import json
from pathlib import Path

from browser_service.contracts import InvocationSystemEcho

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPO_ROOT / "packages" / "contracts" / "fixtures" / "invocation" / "valid-1.json"


def test_round_trips_the_shared_invocation_fixture() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    parsed = InvocationSystemEcho.model_validate(fixture)

    # Re-serialize (model -> JSON -> dict) and compare structurally.
    # `exclude_none=True` because the fixture omits optional fields
    # (`arguments.context`, `arguments.credentialHandle`) entirely rather
    # than setting them to `null`, and Pydantic's default dump includes
    # every field -- "JSON-equivalent", not literally byte-identical, is
    # the round-trip bar (see the build brief's validation criteria).
    dumped = json.loads(parsed.model_dump_json(exclude_none=True))
    assert dumped == fixture
