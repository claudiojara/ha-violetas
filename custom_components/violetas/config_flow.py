"""Config flow (one instance, nothing to ask) and options flow."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    CONF_COUNT,
    CONF_OPACITY,
    CONF_SPEED,
    DEFAULT_OPTIONS,
    DOMAIN,
    MAX_COUNT,
    MAX_OPACITY,
    MIN_COUNT,
    MIN_OPACITY,
    SPEEDS,
)
from .hub import normalize_options

OPTIONS_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_COUNT): NumberSelector(
            NumberSelectorConfig(min=MIN_COUNT, max=MAX_COUNT, step=1, mode=NumberSelectorMode.SLIDER)
        ),
        vol.Required(CONF_SPEED): SelectSelector(
            SelectSelectorConfig(options=list(SPEEDS), translation_key="speed", mode=SelectSelectorMode.LIST)
        ),
        vol.Required(CONF_OPACITY): NumberSelector(
            NumberSelectorConfig(min=MIN_OPACITY, max=MAX_OPACITY, step=0.05, mode=NumberSelectorMode.SLIDER)
        ),
    }
)


class VioletasConfigFlow(ConfigFlow, domain=DOMAIN):
    """A single instance (`single_config_entry` in the manifest), no questions."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(step_id="user")
        return self.async_create_entry(title="Violetas", data={}, options=dict(DEFAULT_OPTIONS))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return VioletasOptionsFlow()


class VioletasOptionsFlow(OptionsFlow):
    """Count, speed and opacity; applied live by the integration's update listener."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=normalize_options(user_input))
        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(
                OPTIONS_SCHEMA, normalize_options(self.config_entry.options)
            ),
        )
