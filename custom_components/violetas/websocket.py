"""Websocket command used by the frontend script (allowed for every user)."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, WS_SUBSCRIBE


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_subscribe)


@websocket_api.websocket_command({vol.Required("type"): WS_SUBSCRIBE})
@callback
def ws_subscribe(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Send the current snapshot now and again on every change.

    Each event is `{enabled, count, speed, opacity}`. The script never needs
    the switch's entity_id, so renaming `switch.violetas` keeps working. Not
    admin-only on purpose: every user who sees a dashboard must see the effect,
    and the snapshot exposes nothing but whether to draw and the drawing options.
    """
    hub = hass.data[DOMAIN]

    @callback
    def forward() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], hub.snapshot()))

    connection.subscriptions[msg["id"]] = hub.async_add_listener(forward)
    connection.send_result(msg["id"])
    forward()
