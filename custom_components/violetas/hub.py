"""Runtime state shared by the switch and the websocket subscribers."""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from typing import Any

from homeassistant.core import CALLBACK_TYPE, HassJob, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later

from .const import (
    CONF_COUNT,
    CONF_OPACITY,
    CONF_SPEED,
    DEFAULT_OPTIONS,
    DETACH_GRACE_SECONDS,
    MAX_COUNT,
    MAX_OPACITY,
    MIN_COUNT,
    MIN_OPACITY,
    SPEEDS,
)


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalize_options(options: Mapping[str, Any]) -> dict[str, Any]:
    """Options with defaults filled in and values clamped to their ranges.

    Anything that is not a finite number (missing, text, NaN, infinity) falls
    back to the default instead of failing.
    """
    count = _finite_float(options.get(CONF_COUNT))
    opacity = _finite_float(options.get(CONF_OPACITY))
    speed = options.get(CONF_SPEED)
    return {
        CONF_COUNT: DEFAULT_OPTIONS[CONF_COUNT] if count is None else min(max(int(count), MIN_COUNT), MAX_COUNT),
        CONF_SPEED: speed if isinstance(speed, str) and speed in SPEEDS else DEFAULT_OPTIONS[CONF_SPEED],
        CONF_OPACITY: (
            DEFAULT_OPTIONS[CONF_OPACITY] if opacity is None else round(min(max(opacity, MIN_OPACITY), MAX_OPACITY), 2)
        ),
    }


class VioletasHub:
    """One per Home Assistant run: created once in `async_setup`, it outlives
    entry reloads and entity_id renames, and is reset when the entry is deleted.

    The switch writes `switch_on` and attaches its current entity_id; websocket
    subscribers (the frontend script) get a snapshot on every change. The effect
    is enabled only while the switch is on *and* its entity exists, so a
    disabled or unloaded switch turns the violets off (after
    DETACH_GRACE_SECONDS, see `async_detach`).
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self.options: dict[str, Any] = dict(DEFAULT_OPTIONS)
        # None until the switch restores its state. Kept in memory so a reload or
        # an entity_id rename (the entity is removed and re-added) keeps it.
        self.switch_on: bool | None = None
        self.entity_id: str | None = None
        self._listeners: set[Callable[[], None]] = set()
        self._cancel_detach: CALLBACK_TYPE | None = None

    def snapshot(self) -> dict[str, Any]:
        """What subscribers get: whether to draw, and how."""
        return {"enabled": bool(self.switch_on) and self.entity_id is not None, **self.options}

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        self._listeners.add(listener)

        @callback
        def remove() -> None:
            self._listeners.discard(listener)

        return remove

    @callback
    def async_set_options(self, options: Mapping[str, Any]) -> None:
        normalized = normalize_options(options)
        if normalized != self.options:
            self.options = normalized
            self._notify()

    @callback
    def async_set_on(self, on: bool) -> None:
        if on != self.switch_on:
            self.switch_on = on
            self._notify()

    @callback
    def async_attach(self, entity_id: str) -> None:
        self._cancel_pending_detach()
        self.entity_id = entity_id
        self._notify()

    @callback
    def async_detach(self, entity_id: str) -> None:
        """The switch entity is going away: report it only if it stays away.

        A reload or a rename removes the entity and adds it back right away.
        Reporting the removal at once would make every open dashboard hide the
        flowers and draw new ones a moment later.
        """
        if self.entity_id != entity_id:
            return
        self._cancel_pending_detach()
        self._cancel_detach = async_call_later(
            self._hass,
            DETACH_GRACE_SECONDS,
            HassJob(self._finish_detach, "violetas detach", cancel_on_shutdown=True),
        )

    @callback
    def async_reset(self) -> None:
        """The config entry was deleted: forget everything; a new entry starts fresh."""
        self._cancel_pending_detach()
        self.options = dict(DEFAULT_OPTIONS)
        self.switch_on = None
        self.entity_id = None
        self._notify()

    @callback
    def _finish_detach(self, _now: Any) -> None:
        self._cancel_detach = None
        self.entity_id = None
        self._notify()

    def _cancel_pending_detach(self) -> None:
        if self._cancel_detach is not None:
            self._cancel_detach()
            self._cancel_detach = None

    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()
