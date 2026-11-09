"""The script is served by the integration and loaded on every frontend page."""

import json
import re
from pathlib import Path
from unittest.mock import patch

import custom_components.violetas.const as const

COMPONENT = Path(__file__).parents[1] / "custom_components" / "violetas"
JS_FILE = COMPONENT / "frontend" / "violetas.js"
JS_URL = "/violetas/violetas.js"
# manifest.json is the single source of the version.
VERSION = json.loads((COMPONENT / "manifest.json").read_text())["version"]


def test_version_has_a_single_source():
    assert re.fullmatch(r"\d+\.\d+\.\d+", VERSION)
    # The script has no build step: its copy must match the manifest.
    assert re.findall(r'^const VERSION = "([^"]+)";', JS_FILE.read_text(), re.M) == [VERSION]
    # Python reads it from the manifest at runtime: no second copy to forget.
    assert not hasattr(const, "VERSION")


def test_manifest():
    manifest = json.loads((COMPONENT / "manifest.json").read_text())
    assert manifest["domain"] == "violetas"
    assert manifest["name"] == "Violetas"
    assert manifest["config_flow"] is True
    assert manifest["single_config_entry"] is True
    assert manifest["iot_class"] == "calculated"
    assert manifest["codeowners"] == ["@claudiojara"]
    assert manifest["documentation"] == "https://github.com/claudiojara/ha-violetas"
    assert manifest["issue_tracker"] == "https://github.com/claudiojara/ha-violetas/issues"
    assert set(manifest["dependencies"]) == {"http", "websocket_api"}
    assert manifest["after_dependencies"] == ["frontend"]


def test_strings_json_is_the_english_translation():
    strings = json.loads((COMPONENT / "strings.json").read_text())
    assert json.loads((COMPONENT / "translations" / "en.json").read_text()) == strings


def test_translations_have_the_same_keys():
    def keys(node, prefix=""):
        if isinstance(node, dict):
            return set().union(*(keys(v, f"{prefix}.{k}") for k, v in node.items()))
        return {prefix}

    strings = json.loads((COMPONENT / "strings.json").read_text())
    for lang in ("en", "es"):
        assert keys(json.loads((COMPONENT / "translations" / f"{lang}.json").read_text())) == keys(strings), lang
    # Neutral Spanish: no voseo forms in the Spanish text.
    es = (COMPONENT / "translations" / "es.json").read_text()
    endings = set(re.findall(r"\b\w+(?:ás|és|ís)\b", es)) - {"más", "después", "través", "país"}
    assert not endings, endings


async def test_script_is_served(hass, hass_client, loaded_entry):
    client = await hass_client()
    resp = await client.get(f"{JS_URL}?v={VERSION}")
    assert resp.status == 200
    body = await resp.text()
    assert 'customElements.define("violet-fall-card"' in body
    assert '"violetas/subscribe"' in body


async def test_script_added_to_every_page_and_removed_on_unload(hass, entry):
    hass.config.components.add("frontend")
    with (
        patch("custom_components.violetas.add_extra_js_url") as add_js,
        patch("custom_components.violetas.remove_extra_js_url") as remove_js,
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        add_js.assert_called_once_with(hass, f"{JS_URL}?v={VERSION}")
        remove_js.assert_not_called()

        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()
        remove_js.assert_called_once_with(hass, f"{JS_URL}?v={VERSION}")


async def test_no_frontend_no_script_url(hass, entry):
    with patch("custom_components.violetas.add_extra_js_url") as add_js:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    add_js.assert_not_called()


def test_brand_icons_exist():
    brand = COMPONENT / "brand"
    for name, size in (("icon.png", 256), ("icon@2x.png", 512)):
        data = (brand / name).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", name
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        assert (width, height) == (size, size), name
