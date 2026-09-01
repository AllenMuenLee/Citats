"""Browser automation primitives: lifecycle, URL policy, and navigation.

Phase 2 (P02-F01) scope only: nodriver lifecycle management, ephemeral
per-task isolated contexts, URL safety policy, and a read-only
(NAVIGATE/GET_CONTENT) navigation service. No content-extraction logic and
no HTTP routes live here -- this package is a private, importable library
for a later integration step to wire up.
"""

from __future__ import annotations

from browser_service.browser.accessibility_capture import (
    AccessibilityCapture,
    capture_accessibility,
)
from browser_service.browser.lifecycle import (
    BROWSER_EXECUTABLE_PATH_ENV_VAR,
    BrowserLifecycleManager,
    IsolatedBrowserContext,
    LifecycleConfig,
)
from browser_service.browser.navigation import (
    NavigationBlockedError,
    NavigationCancelledError,
    NavigationError,
    NavigationLimits,
    NavigationResult,
    NavigationService,
    NavigationTimeoutError,
    ReadOnlyOperation,
    ResponseTooLargeError,
    TooManyRedirectsError,
)
from browser_service.browser.policy import (
    BlockedUrlError,
    PolicyViolation,
    UrlPolicy,
    UrlPolicyConfig,
)
from browser_service.browser.registry import BrowserResourceRegistry, ManagedContext

__all__ = [
    "BROWSER_EXECUTABLE_PATH_ENV_VAR",
    "AccessibilityCapture",
    "BlockedUrlError",
    "BrowserLifecycleManager",
    "BrowserResourceRegistry",
    "IsolatedBrowserContext",
    "LifecycleConfig",
    "ManagedContext",
    "NavigationBlockedError",
    "NavigationCancelledError",
    "NavigationError",
    "NavigationLimits",
    "NavigationResult",
    "NavigationService",
    "NavigationTimeoutError",
    "PolicyViolation",
    "ReadOnlyOperation",
    "ResponseTooLargeError",
    "TooManyRedirectsError",
    "UrlPolicy",
    "UrlPolicyConfig",
    "capture_accessibility",
]
