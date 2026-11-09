"""`violetas/subscribe`: what the frontend script listens to."""

import asyncio
import json
from datetime import timedelta
from pathlib import Path

from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.violetas.const import DETACH_GRACE_SECONDS, DOMAIN

# The sequences verify/browser.mjs replays against the real script.
EVENTS = json.loads((Path(__file__).parent / "fixtures" / "ws_events.json").read_text())


async def _subscribe(hass, hass_ws_client, token=None):
    client = await hass_ws_client(hass, access_token=token) if token else await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "violetas/subscribe"})
    result = await client.receive_json()
    assert result["success"] is True, result
    return client, result["id"]


async def _next_event(client, sub_id):
    msg = await client.receive_json()
    assert msg["id"] == sub_id and msg["type"] == "event"
    return msg["event"]


async def _drain(hass, client, sub_id):
    """Every event sent so far (waits a little for the last ones)."""
    await hass.async_block_till_done()
    events = []
    while True:
        try:
            msg = await client.receive_json(timeout=0.1)
        except TimeoutError:
            return events
        assert msg["id"] == sub_id and msg["type"] == "event"
        events.append(msg["event"])


async def _past_detach_grace(hass):
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=DETACH_GRACE_SECONDS + 1))
    await hass.async_block_till_done()


async def test_subscribe_sends_snapshot_then_updates(hass, hass_ws_client, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client)
    assert await _drain(hass, client, sub_id) == EVENTS["subscribe"]

    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.violetas"}, blocking=True)
    assert (await _next_event(client, sub_id))["enabled"] is False

    hass.config_entries.async_update_entry(loaded_entry, options={"count": 60, "speed": "fast", "opacity": 0.4})
    await hass.async_block_till_done()
    assert await _next_event(client, sub_id) == {"enabled": False, "count": 60, "speed": "fast", "opacity": 0.4}


async def test_snapshot_exposes_only_state_and_options(hass, hass_ws_client, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client)
    assert set(await _next_event(client, sub_id)) == {"enabled", "count", "speed", "opacity"}


async def test_subscribe_is_allowed_for_non_admin_users(hass, hass_ws_client, hass_read_only_access_token, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client, hass_read_only_access_token)
    assert (await _next_event(client, sub_id))["enabled"] is True


async def test_rename_never_reports_disabled(hass, hass_ws_client, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client)
    await _drain(hass, client, sub_id)
    er.async_get(hass).async_update_entity("switch.violetas", new_entity_id="switch.flores")
    await hass.async_block_till_done()
    await _past_detach_grace(hass)
    assert await _drain(hass, client, sub_id) == EVENTS["rename_entity_id"]
    assert hass.data[DOMAIN].entity_id == "switch.flores"


async def test_reload_never_reports_disabled(hass, hass_ws_client, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client)
    await _drain(hass, client, sub_id)
    assert await hass.config_entries.async_reload(loaded_entry.entry_id)
    await hass.async_block_till_done()
    await _past_detach_grace(hass)
    assert await _drain(hass, client, sub_id) == EVENTS["reload_entry"]


async def test_unload_reports_disabled_after_the_grace_period(hass, hass_ws_client, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client)
    await _drain(hass, client, sub_id)
    assert await hass.config_entries.async_unload(loaded_entry.entry_id)
    assert await _drain(hass, client, sub_id) == []
    await _past_detach_grace(hass)
    assert await _drain(hass, client, sub_id) == EVENTS["unload_entry"]


async def test_delete_reports_disabled_right_away(hass, hass_ws_client, loaded_entry):
    client, sub_id = await _subscribe(hass, hass_ws_client)
    await _drain(hass, client, sub_id)
    assert await hass.config_entries.async_remove(loaded_entry.entry_id)
    events = await _drain(hass, client, sub_id)
    assert events and events[-1]["enabled"] is False


async def test_two_subscribers_get_every_update(hass, hass_ws_client, loaded_entry):
    first, first_id = await _subscribe(hass, hass_ws_client)
    second, second_id = await _subscribe(hass, hass_ws_client)
    assert (await _next_event(first, first_id))["enabled"] is True
    assert (await _next_event(second, second_id))["enabled"] is True
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.violetas"}, blocking=True)
    assert (await _next_event(first, first_id))["enabled"] is False
    assert (await _next_event(second, second_id))["enabled"] is False


async def test_unsubscribe_removes_the_listener(hass, hass_ws_client, loaded_entry):
    hub = hass.data[DOMAIN]
    client, sub_id = await _subscribe(hass, hass_ws_client)
    await _next_event(client, sub_id)
    listeners = len(hub._listeners)
    await client.send_json_auto_id({"type": "unsubscribe_events", "subscription": sub_id})
    assert (await client.receive_json())["success"] is True
    assert len(hub._listeners) == listeners - 1


async def test_disconnect_without_unsubscribe_removes_the_listener(hass, hass_ws_client, loaded_entry):
    hub = hass.data[DOMAIN]
    before = len(hub._listeners)
    client, sub_id = await _subscribe(hass, hass_ws_client)
    await _next_event(client, sub_id)
    assert len(hub._listeners) == before + 1
    await client.close()
    for _ in range(20):  # the server notices the closed socket asynchronously
        await hass.async_block_till_done()
        if len(hub._listeners) == before:
            break
        await asyncio.sleep(0.01)
    assert len(hub._listeners) == before
