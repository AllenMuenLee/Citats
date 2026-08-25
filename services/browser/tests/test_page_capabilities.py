from browser_service.page_observation.capabilities import classify_capabilities


def test_classifies_from_structural_facts_without_executing() -> None:
    state: dict[str, object] = {
        "expanded": None,
        "pressed": None,
        "checked": None,
        "selected": None,
        "current": None,
        "busy": False,
        "invalid": False,
        "required": False,
        "disabled": False,
        "readOnly": False,
        "focusable": True,
    }
    nodes: list[dict[str, object]] = [
        {
            "kind": "control",
            "handle": "node-tab",
            "role": "tab",
            "label": "Delete everything",
            "state": state,
        },
        {
            "kind": "link",
            "handle": "node-link",
            "role": "link",
            "label": "Safe",
            "destination": "https://example.com/path?q=x",
            "destinationClass": "external",
        },
        {
            "kind": "field",
            "handle": "node-password",
            "role": "password",
            "label": "Password",
            "required": True,
        },
        {"kind": "embedded_boundary", "handle": "node-frame"},
    ]
    capabilities, coverage = classify_capabilities(nodes, [])
    assert [item["capabilityKind"] for item in capabilities] == [
        "local_view_change",
        "navigation",
        "data_entry",
    ]
    assert capabilities[0]["effectClass"] == "local_view"
    assert capabilities[1]["destinationOrigin"] == "https://example.com"
    assert capabilities[2]["requiredInputs"] == ["password"]
    assert all("destination" not in item for item in capabilities)
    assert coverage == {
        "observedControlCount": 3,
        "safelyExploredControlCount": 0,
        "prohibitedControlCount": 1,
        "unknownControlCount": 0,
        "inaccessibleRegionCount": 1,
        "unobservedLazyStateCount": 0,
        "notes": ["Public default mode observed controls without interaction."],
    }
