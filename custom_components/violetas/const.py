"""Constants for Violetas."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "violetas"
# The version lives only in manifest.json (read at runtime) and, because the
# script has no build step, in frontend/violetas.js; tests keep them equal.

CONF_COUNT: Final = "count"
CONF_SPEED: Final = "speed"
CONF_OPACITY: Final = "opacity"

SPEEDS: Final = ("slow", "normal", "fast")
MIN_COUNT: Final = 1
MAX_COUNT: Final = 80
MIN_OPACITY: Final = 0.1
MAX_OPACITY: Final = 1.0

DEFAULT_OPTIONS: Final = {CONF_COUNT: 25, CONF_SPEED: "normal", CONF_OPACITY: 0.9}

# The frontend script, served from this integration and loaded on every page
# with `?v=<manifest version>` appended.
JS_URL: Final = f"/{DOMAIN}/violetas.js"

WS_SUBSCRIBE: Final = "violetas/subscribe"

# When the switch entity goes away, subscribers learn it only after this many
# seconds: a reload or an entity_id rename adds it back well before, so open
# dashboards keep the same flowers instead of hiding and redrawing them.
DETACH_GRACE_SECONDS: Final = 3
