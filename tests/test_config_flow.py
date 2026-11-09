"""Config flow and options flow."""

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.data_entry_flow import FlowResultType

from custom_components.violetas.const import DEFAULT_OPTIONS, DOMAIN


async def test_user_flow_creates_single_entry_with_default_options(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Violetas"
    assert result["data"] == {}
    assert result["options"] == DEFAULT_OPTIONS
    assert DEFAULT_OPTIONS == {"count": 25, "speed": "normal", "opacity": 0.9}

    # Adding the integration is enough: the switch exists and starts on.
    assert hass.states.get("switch.violetas").state == "on"


async def test_only_one_instance(hass, loaded_entry):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_options_flow_applies_live_without_reload(hass, loaded_entry):
    switch_before = hass.data["entity_components"]["switch"].get_entity("switch.violetas")

    result = await hass.config_entries.options.async_init(loaded_entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"count": 40.0, "speed": "slow", "opacity": 0.5}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert loaded_entry.options == {"count": 40, "speed": "slow", "opacity": 0.5}
    assert isinstance(loaded_entry.options["count"], int)
    assert loaded_entry.state is ConfigEntryState.LOADED
    # Same entity object: the entry was not reloaded.
    assert hass.data["entity_components"]["switch"].get_entity("switch.violetas") is switch_before
    attrs = hass.states.get("switch.violetas").attributes
    assert (attrs["count"], attrs["speed"], attrs["opacity"]) == (40, "slow", 0.5)


async def test_options_flow_rejects_out_of_range(hass, loaded_entry):
    import pytest
    from homeassistant.data_entry_flow import InvalidData

    result = await hass.config_entries.options.async_init(loaded_entry.entry_id)
    for bad in ({"count": 0, "speed": "normal", "opacity": 0.9},
                {"count": 25, "speed": "warp", "opacity": 0.9},
                {"count": 25, "speed": "normal", "opacity": 2}):
        with pytest.raises(InvalidData):
            await hass.config_entries.options.async_configure(result["flow_id"], bad)
