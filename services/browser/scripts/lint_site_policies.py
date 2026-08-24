"""Standalone startup/CI lint for `config/sites/*.yaml` pilot-site
governance records (P03-F03 build step 3).

Run from `services/browser` (the package is installed editable into the
project's `uv` venv, so no path hacking is needed):

    uv run python scripts/lint_site_policies.py

Exits non-zero if ANY site file fails to parse or validate against
`browser_service.sites.schema.SitePolicy` -- which itself already
rejects overly broad wildcards, unsafe (non-`GET`/`HEAD`) methods,
invalid dates, and credential-shaped keys/values -- or if two files
claim the same `site_id`. Reuses
`browser_service.sites.loader.parse_site_policy_file` for every
per-file check, and this script's own duplicate-`site_id` check mirrors
`SitePolicyLoader._load_all`'s, so this linter cannot silently drift
from what the runtime loader enforces.

On success, logs ONLY `site_id`, `schema_version`, and `decision` for
each record -- never the full parsed record -- per this feature's
"never log full record content just in case something slips past
redaction" rule.
"""

from __future__ import annotations

import logging
from pathlib import Path

from browser_service.sites.loader import (
    SitePolicyLoadError,
    default_sites_root,
    parse_site_policy_file,
)

logger = logging.getLogger("browser_service.sites.lint")


def lint(root: Path | None = None) -> int:
    sites_root = root if root is not None else default_sites_root()

    if not sites_root.is_dir():
        logger.error("sites_root_missing: %s", sites_root)
        return 1

    paths = sorted(sites_root.glob("*.yaml"))
    if not paths:
        logger.warning("no_site_policy_files_found: %s", sites_root)
        return 0

    errors: list[str] = []
    seen_site_ids: dict[str, str] = {}

    for path in paths:
        try:
            policy = parse_site_policy_file(path)
        except SitePolicyLoadError as exc:
            errors.append(str(exc))
            continue

        if policy.site_id in seen_site_ids:
            errors.append(
                f"{path.name}: duplicate_site_id: {policy.site_id!r} also claimed by "
                f"{seen_site_ids[policy.site_id]!r}"
            )
            continue
        seen_site_ids[policy.site_id] = path.name

        logger.info(
            "site_policy_ok site_id=%s schema_version=%d decision=%s",
            policy.site_id,
            policy.schema_version,
            policy.decision.value,
        )

    if errors:
        for error in errors:
            logger.error(error)
        return 1

    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(lint())
