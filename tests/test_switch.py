"""The global switch: default, toggling, restore, rename and unload."""

from datetime import timedelta

from homeassistant import config_entries
from homeassistant.core import State
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed, mock_restore_cache

from custom_components.violetas.const import DETACH_GRACE_SECONDS, DOMAIN


async def test_switch_defaults_on_with_options_as_attributes(hass, loaded_entry):
    state = hass.states.get("switch.violetas")
    assert state.state == "on"
    assert state.name == "Violetas"
    assert state.attributes["icon"] == "mdi:flower"
    assert (state.attributes["count"], state.attributes["speed"], state.attributes["opacity"]) == (25, "normal", 0.9)
    entity = er.async_get(hass).async_get("switch.violetas")
    assert entity.unique_id == loaded_entry.entry_id


async def test_toggle_updates_state_and_snapshot(hass, loaded_entry):
    hub = hass.data[DOMAIN]
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.violetas"}, blocking=True)
    assert hass.states.get("switch.violetas").state == "off"
    assert hub.snapshot()["enabled"] is False
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.violetas"}, blocking=True)
    assert hass.states.get("switch.violetas").state == "on"
    assert hub.snapshot()["enabled"] is True


async def test_restores_off_after_restart(hass, entry):
    mock_restore_cache(hass, [State("switch.violetas", "off")])
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("switch.violetas").state == "off"
    assert hass.data[DOMAIN].snapshot()["enabled"] is False


async def test_restores_on_after_restart(hass, entry):
    mock_restore_cache(hass, [State("switch.violetas", "on")])
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("switch.violetas").state == "on"


async def test_reload_keeps_state(hass, loaded_entry):
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.violetas"}, blocking=True)
    assert await hass.config_entries.async_reload(loaded_entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("switch.violetas").state == "off"


async def test_rename_entity_id_keeps_state_and_is_tracked(hass, loaded_entry):
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.violetas"}, blocking=True)
    er.async_get(hass).async_update_entity("switch.violetas", new_entity_id="switch.flores")
    await hass.async_block_till_done()
    assert hass.states.get("switch.flores").state == "off"
    assert hass.data[DOMAIN].entity_id == "switch.flores"
    assert hass.data[DOMAIN].snapshot()["enabled"] is False
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.flores"}, blocking=True)
    assert hass.data[DOMAIN].snapshot()["enabled"] is True


async def test_unload_disables_effect_after_the_grace_period(hass, loaded_entry):
    hub = hass.data[DOMAIN]
    assert hub.snapshot()["enabled"] is True
    assert await hass.config_entries.async_unload(loaded_entry.entry_id)
    await hass.async_block_till_done()
    # A reload would add the switch back within the grace period: no flicker.
    assert hub.snapshot()["enabled"] is True
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=DETACH_GRACE_SECONDS + 1))
    await hass.async_block_till_done()
    assert hub.snapshot()["enabled"] is False
    assert hub.entity_id is None


async def test_disabled_entity_disables_effect(hass, loaded_entry):
    er.async_get(hass).async_update_entity("switch.violetas", disabled_by=er.RegistryEntryDisabler.USER)
    await hass.async_block_till_done()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=DETACH_GRACE_SECONDS + 1))
    await hass.async_block_till_done()
    assert hass.data[DOMAIN].snapshot()["enabled"] is False


async def test_delete_and_add_again_starts_on(hass):
    """A new entry starts on, even if the deleted one was off (same run, no restart)."""

    async def add():
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        await hass.async_block_till_done()
        return result["result"]

    first = await add()
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.violetas"}, blocking=True)
    assert await hass.config_entries.async_remove(first.entry_id)
    await hass.async_block_till_done()
    assert hass.data[DOMAIN].snapshot()["enabled"] is False

    await add()
    assert hass.states.get("switch.violetas").state == "on"
    assert hass.data[DOMAIN].snapshot()["enabled"] is True


async def test_restore_ignores_a_state_older_than_the_entry(hass):
    """After a restart, a stored state left by a deleted entry does not apply to a new one."""
    mock_restore_cache(hass, [State("switch.violetas", "off")])
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    await hass.config_entries.flow.async_configure(result["flow_id"], {})
    await hass.async_block_till_done()
    assert hass.states.get("switch.violetas").state == "on"
