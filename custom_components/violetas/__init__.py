"""Violetas: falling violets on every Home Assistant dashboard, behind one switch."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from . import websocket
from .const import DOMAIN, JS_URL
from .hub import VioletasHub

PLATFORMS = [Platform.SWITCH]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

JS_FILE = Path(__file__).parent / "frontend" / "violetas.js"

type VioletasConfigEntry = ConfigEntry[VioletasHub]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Once per start: the shared state, the script's URL and the websocket command."""
    hass.data[DOMAIN] = VioletasHub(hass)
    # Static paths cannot be unregistered: register once, not per entry. The
    # versioned URL (?v=) makes long browser caching safe across updates.
    await hass.http.async_register_static_paths([StaticPathConfig(JS_URL, str(JS_FILE), True)])
    websocket.async_register(hass)
    return True


async def _async_script_url(hass: HomeAssistant) -> str:
    # manifest.json is the single source of the version.
    integration = await async_get_integration(hass, DOMAIN)
    return f"{JS_URL}?v={integration.version}"


async def async_setup_entry(hass: HomeAssistant, entry: VioletasConfigEntry) -> bool:
    hub: VioletasHub = hass.data[DOMAIN]
    hub.async_set_options(entry.options)
    entry.runtime_data = hub
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    # Options apply live: no reload, the script redraws when it gets the new snapshot.
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    # Load the script on every frontend page, for every user (not a Lovelace
    # resource: it also runs outside dashboards and needs no admin setup).
    if "frontend" in hass.config.components:
        url = await _async_script_url(hass)
        add_extra_js_url(hass, url)
        entry.async_on_unload(lambda: _remove_script(hass, url))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: VioletasConfigEntry) -> None:
    entry.runtime_data.async_set_options(entry.options)


@callback
def _remove_script(hass: HomeAssistant, url: str) -> None:
    # Pages already open keep the script; it hides the violets because the
    # subscription reports the effect as disabled.
    try:
        remove_extra_js_url(hass, url)
    except KeyError:
        pass


async def async_unload_entry(hass: HomeAssistant, entry: VioletasConfigEntry) -> bool:
    # Removing the switch detaches it from the hub: subscribers get enabled=false
    # after a short grace period (a reload adds the switch back before that).
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: VioletasConfigEntry) -> None:
    # The hub outlives the entry (it is created once per start): a new entry
    # added later in the same run must not inherit the deleted one's state.
    # Subscribers get enabled=false right away.
    if (hub := hass.data.get(DOMAIN)) is not None:
        hub.async_reset()
