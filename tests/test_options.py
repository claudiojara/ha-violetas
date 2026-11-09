"""Option values: defaults, clamping and fallbacks, wherever they come from."""

import math

import pytest

from custom_components.violetas.const import DEFAULT_OPTIONS, DOMAIN
from custom_components.violetas.hub import normalize_options


def test_missing_keys_get_defaults():
    assert normalize_options({}) == DEFAULT_OPTIONS
    assert normalize_options({"count": 40}) == {**DEFAULT_OPTIONS, "count": 40}


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1, 1),
        (80, 80),
        (0, 1),
        (-5, 1),
        (81, 80),
        (10_000, 80),
        (40.0, 40),
        (40.7, 40),
        ("40", 40),
        ("many", 25),
        (None, 25),
        ([3], 25),
        (math.inf, 25),
        (-math.inf, 25),
        (math.nan, 25),
    ],
)
def test_count(value, expected):
    count = normalize_options({"count": value})["count"]
    assert count == expected
    assert type(count) is int


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.1, 0.1),
        (1.0, 1.0),
        (1, 1.0),
        (0.5, 0.5),
        (0.123, 0.12),
        (0.05, 0.1),
        (0, 0.1),
        (-1, 0.1),
        (2, 1.0),
        ("0.4", 0.4),
        ("opaque", 0.9),
        (None, 0.9),
        (math.inf, 0.9),
        (-math.inf, 0.9),
        (math.nan, 0.9),
    ],
)
def test_opacity(value, expected):
    assert normalize_options({"opacity": value})["opacity"] == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [("slow", "slow"), ("normal", "normal"), ("fast", "fast"), ("warp", "normal"), ("", "normal"), (None, "normal"), (3, "normal")],
)
def test_speed(value, expected):
    assert normalize_options({"speed": value})["speed"] == expected


async def test_out_of_range_entry_options_are_clamped(hass, loaded_entry):
    """Options written outside the options flow (storage edits, other code) are clamped too."""
    hass.config_entries.async_update_entry(loaded_entry, options={"count": 500, "speed": "warp", "opacity": 5})
    await hass.async_block_till_done()
    snapshot = hass.data[DOMAIN].snapshot()
    assert (snapshot["count"], snapshot["speed"], snapshot["opacity"]) == (80, "normal", 1.0)

    hass.config_entries.async_update_entry(loaded_entry, options={"count": "x"})
    await hass.async_block_till_done()
    snapshot = hass.data[DOMAIN].snapshot()
    assert (snapshot["count"], snapshot["speed"], snapshot["opacity"]) == (25, "normal", 0.9)
    attrs = hass.states.get("switch.violetas").attributes
    assert (attrs["count"], attrs["speed"], attrs["opacity"]) == (25, "normal", 0.9)
