"""Shared fixtures for the Violetas tests."""

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.violetas.const import DEFAULT_OPTIONS, DOMAIN


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture
def entry(hass):
    """A Violetas config entry with default options, not yet set up."""
    config_entry = MockConfigEntry(domain=DOMAIN, title="Violetas", data={}, options=dict(DEFAULT_OPTIONS))
    config_entry.add_to_hass(hass)
    return config_entry


@pytest.fixture
async def loaded_entry(hass, entry):
    """The Violetas config entry, set up."""
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
