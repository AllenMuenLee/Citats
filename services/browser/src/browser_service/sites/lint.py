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

    for error in errors:
        logger.error(error)
    return 1 if errors else 0
