"""A local, client-rendered accommodation-results fixture (P03-R06 step 1).

Builds a CDP-shaped DOM for a stays/search results page carrying six
listing records with dates, prices, ratings, images and alt text,
amenities, availability evidence, an internal comparison affordance, and an
external booking capability descriptor -- plus enough DOM volume to
reproduce the shape that used to time out.

Nothing here touches Airbnb or any live site. It exists so the regression
that motivated this repair can be asserted deterministically.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

LISTING_COUNT = 6

#: The regression prompt's criteria, kept next to the fixture that satisfies
#: them so the two cannot drift apart.
CHECK_IN = "2026-09-03"
CHECK_OUT = "2026-09-05"
COLLECTION_URL = (
    f"https://stays.test/seattle-wa/stays?check_in={CHECK_IN}&check_out={CHECK_OUT}&adults=2"
)

_LISTINGS = [
    ("Capitol Hill Loft", "$182", "4.92", "128", "Wifi, Kitchen, Washer"),
    ("Ballard Garden Suite", "$147", "4.81", "204", "Wifi, Free parking"),
    ("Queen Anne View Flat", "$219", "4.97", "89", "Wifi, Kitchen, Air conditioning"),
    ("Fremont Canal Studio", "$134", "4.74", "312", "Wifi, Kitchen"),
    ("Belltown Corner Apartment", "$198", "4.88", "156", "Wifi, Gym, Washer"),
    ("Green Lake Cottage", "$165", "4.90", "97", "Wifi, Kitchen, Free parking"),
]


def element(
    backend_id: int,
    tag: str,
    *,
    children: list[Any] | None = None,
    attributes: dict[str, str] | None = None,
    child_node_count: int | None = None,
    content_document: Any = None,
    shadow_roots: list[Any] | None = None,
) -> Any:
    kids = children or []
    flat: list[str] = []
    for name, value in (attributes or {}).items():
        flat.extend([name, value])
    return SimpleNamespace(
        backend_node_id=backend_id,
        node_type=1,
        node_name=tag.upper(),
        node_value="",
        attributes=flat,
        children=kids,
        child_node_count=len(kids) if child_node_count is None else child_node_count,
        content_document=content_document,
        shadow_roots=shadow_roots or [],
    )


def text(backend_id: int, value: str) -> Any:
    return SimpleNamespace(
        backend_node_id=backend_id,
        node_type=3,
        node_name="#text",
        node_value=value,
        attributes=[],
        children=[],
        child_node_count=0,
        content_document=None,
        shadow_roots=[],
    )


def _listing_card(index: int, base: int) -> Any:
    name, price, rating, reviews, amenities = _LISTINGS[index]
    return element(
        base,
        "article",
        attributes={"role": "listitem", "data-testid": "listing-card"},
        children=[
            element(
                base + 1,
                "img",
                attributes={
                    "src": f"https://images.test/{index}.jpg",
                    "alt": f"{name} interior photograph",
                },
            ),
            element(base + 2, "h3", children=[text(base + 3, name)]),
            element(
                base + 4,
                "p",
                attributes={"class": "price"},
                children=[text(base + 5, f"{price} per night")],
            ),
            element(
                base + 6,
                "p",
                attributes={"class": "rating"},
                children=[text(base + 7, f"{rating} out of 5, {reviews} reviews")],
            ),
            element(
                base + 8,
                "p",
                attributes={"class": "availability"},
                children=[text(base + 9, f"Available {CHECK_IN} to {CHECK_OUT}")],
            ),
            element(
                base + 10,
                "p",
                attributes={"class": "amenities"},
                children=[text(base + 11, amenities)],
            ),
            # Internal, React-only comparison affordance: a checkbox that
            # changes nothing on the external site.
            element(
                base + 12,
                "button",
                attributes={"type": "button", "aria-label": f"Add {name} to comparison"},
                children=[text(base + 13, "Compare")],
            ),
            # External booking capability descriptor -- observed, never invoked.
            element(
                base + 14,
                "a",
                attributes={"href": f"https://stays.test/rooms/{index}?check_in={CHECK_IN}"},
                children=[text(base + 15, "Reserve")],
            ),
        ],
    )


def build_results_document(
    *, filler_nodes: int = 0, truncate_at_depth: bool = False
) -> Any:
    """The full results document.

    `filler_nodes` pads the page with inert markup so a fixture can exceed a
    node budget on purpose. `truncate_at_depth` makes the results container
    declare its children without carrying them, which is how CDP reports a
    subtree cut at the requested depth -- the case the incremental expansion
    path exists for.
    """
    cards = [_listing_card(index, 1_000 + index * 100) for index in range(LISTING_COUNT)]
    filler = [
        element(
            50_000 + index,
            "div",
            attributes={"class": "decor"},
            children=[text(60_000 + index, f"decorative row {index}")],
        )
        for index in range(filler_nodes)
    ]
    results = element(
        20,
        "main",
        attributes={"role": "main", "aria-label": "Search results"},
        children=[] if truncate_at_depth else [*cards, *filler],
        child_node_count=LISTING_COUNT + filler_nodes,
    )
    head = element(
        2,
        "head",
        children=[
            element(3, "title", children=[text(4, "Stays in Seattle")]),
            element(
                5,
                "meta",
                attributes={"name": "description", "content": "Seattle stays for your dates"},
            ),
        ],
    )
    body = element(
        10,
        "body",
        children=[
            element(
                11,
                "header",
                attributes={"role": "banner"},
                children=[text(12, f"Seattle stays, {CHECK_IN} to {CHECK_OUT}")],
            ),
            results,
        ],
    )
    return element(1, "html", children=[head, body])


def expansion_for_results() -> Any:
    """What `DOM.describeNode` returns for the truncated results container."""
    return element(
        20,
        "main",
        children=[_listing_card(index, 1_000 + index * 100) for index in range(LISTING_COUNT)],
    )


def ax_nodes_for_results() -> list[Any]:
    """A bounded accessibility tree correlated to the listing cards."""
    nodes: list[Any] = []
    for index in range(LISTING_COUNT):
        base = 1_000 + index * 100
        name = _LISTINGS[index][0]
        nodes.append(
            SimpleNamespace(
                backend_dom_node_id=base,
                role=SimpleNamespace(value="article"),
                name=SimpleNamespace(value=name),
                description=None,
                ignored=False,
                ignored_reasons=[],
                properties=[],
                node_id=f"ax-{base}",
                child_ids=[],
            )
        )
    return nodes


__all__ = [
    "CHECK_IN",
    "CHECK_OUT",
    "COLLECTION_URL",
    "LISTING_COUNT",
    "ax_nodes_for_results",
    "build_results_document",
    "element",
    "expansion_for_results",
    "text",
]
