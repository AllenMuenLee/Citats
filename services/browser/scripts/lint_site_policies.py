from __future__ import annotations

import logging

from browser_service.sites.lint import lint

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(lint())
