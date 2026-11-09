"""`switch.violetas`: the global on/off of the effect."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.const import STATE_OFF
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from . import VioletasConfigEntry
from .hub import VioletasHub


async def async_setup_entry(
    hass: HomeAssistant,
    entry: VioletasConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([VioletasSwitch(entry.runtime_data, entry.entry_id, entry.created_at)])


class VioletasSwitch(SwitchEntity, RestoreEntity):
    """On: violets fall on every dashboard for every user. Survives restarts."""

    _attr_has_entity_name = True
    _attr_translation_key = "violetas"
    _attr_icon = "mdi:flower"
    _attr_should_poll = False

    def __init__(self, hub: VioletasHub, unique_id: str, entry_created_at: datetime) -> None:
        self._hub = hub
        self._attr_unique_id = unique_id
        self._entry_created_at = entry_created_at
        self._unsub_hub: CALLBACK_TYPE | None = None

    @property
    def is_on(self) -> bool:
        return bool(self._hub.switch_on)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return dict(self._hub.options)

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self._hub.switch_on is None:
            # First add since Home Assistant started, or since the entry was
            # deleted and added again (reloads and renames keep the hub state).
            # Restore the last state; on by default, so adding the integration
            # is enough to see the violets.
            last = await self.async_get_last_state()
            # A stored state older than this entry was left by a deleted entry
            # (same entity_id): a new entry starts on.
            restored_off = last is not None and last.state == STATE_OFF and last.last_changed >= self._entry_created_at
            self._hub.switch_on = not restored_off
        self._unsub_hub = self._hub.async_add_listener(self._hub_changed)
        self._hub.async_attach(self.entity_id)

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub_hub:
            self._unsub_hub()
            self._unsub_hub = None
        self._hub.async_detach(self.entity_id)

    @callback
    def _hub_changed(self) -> None:
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._hub.async_set_on(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._hub.async_set_on(False)


