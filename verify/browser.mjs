// Headless browser check of frontend/violetas.js against a fake Home Assistant connection
// (no Home Assistant instance involved). Covers what node unit tests cannot: the real DOM overlay,
// live options, the event sequences the integration really sends (tests/fixtures/ws_events.json,
// asserted by tests/test_websocket.py), subscribe failures and reconnects, reduced motion and the
// optional card.
//
//   npm install && npx playwright install chromium   # once
//   node verify/browser.mjs
//
// Optional:
//   SCREENSHOT=docs/preview.png    also saves a preview of the overlay (README image).
//   EXTERNAL_CARD_JS=<path>        a separately distributed violet-fall-card script that shares the
//                                  global key; runs the coexistence checks (skipped otherwise).
//
// Exit code 0 only if every check passes.
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const read = (rel) => readFileSync(new URL(rel, import.meta.url));
const SCRIPT = read("../custom_components/violetas/frontend/violetas.js");
const VERSION = JSON.parse(read("../custom_components/violetas/manifest.json")).version;
const EVENTS = JSON.parse(read("../tests/fixtures/ws_events.json"));
const EXTERNAL = process.env.EXTERNAL_CARD_JS;
const SCRIPT_URL = `/violetas/violetas.js?v=${VERSION}`;
const WS = "violetas/subscribe";

const ORIGIN = "http://ha.test";
const PAGE = `<!doctype html><html><body><home-assistant></home-assistant><script>
  // Fake home-assistant-js-websocket Connection. Keeps live subscription callbacks so the test can
  // push events, can reject the next violetas/subscribe attempts (Home Assistant still starting:
  // unknown_command) and can simulate a reconnect (the server drops every subscription, then the
  // library fires "ready").
  window.__subs = {};
  window.__attempts = {};
  window.__options = {};
  window.__rejectNext = 0;
  const listeners = {};
  const conn = {
    subscribeMessage(cb, msg, options) {
      window.__attempts[msg.type] = (window.__attempts[msg.type] || 0) + 1;
      window.__options[msg.type] = options;
      if (msg.entity_ids) window.__entityIds = msg.entity_ids;
      if (msg.type === "${WS}" && window.__rejectNext > 0) {
        window.__rejectNext--;
        return Promise.reject({ code: "unknown_command", message: "Unknown command." });
      }
      const list = (window.__subs[msg.type] ||= []);
      list.push(cb);
      return Promise.resolve(() => {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      });
    },
    addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
    removeEventListener(type, cb) { listeners[type] = (listeners[type] || []).filter((x) => x !== cb); },
  };
  document.querySelector("home-assistant").hass = { connection: conn };
  window.reconnect = (rejectNext) => {
    window.__subs = {};
    window.__rejectNext = rejectNext;
    (listeners.ready || []).forEach((cb) => cb(conn));
  };
  window.push = (type, ev) => (window.__subs[type] || []).forEach((cb) => cb(ev));
  window.live = (type) => (window.__subs[type] || []).length;
  // Every falling violet in the document, shadow roots included.
  window.countViolets = () => {
    let n = 0;
    const walk = (root) => root.querySelectorAll("*").forEach((el) => {
      if (el.classList?.contains("fall")) n++;
      if (el.shadowRoot) walk(el.shadowRoot);
    });
    walk(document);
    return n;
  };
  window.firstLeft = () =>
    document.getElementById("violetas-overlay")?.shadowRoot.querySelector(".fall")?.style.left ?? null;
  window.load = (path) => import(path).then(() => undefined);
</script></body></html>`;

const snap = (over = {}) => ({ ...EVENTS.subscribe[0], ...over });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
async function newPage({ reducedMotion = "no-preference", rejectFirst = 0 } = {}) {
  const context = await browser.newContext({ reducedMotion, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: PAGE });
    if (path === "/violetas/violetas.js") return route.fulfill({ contentType: "text/javascript", body: SCRIPT });
    if (path === "/local/violet-fall-card.js" && EXTERNAL) {
      return route.fulfill({ contentType: "text/javascript", body: readFileSync(EXTERNAL) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((n) => (window.__rejectNext = n), rejectFirst);
  return { page, errors, close: () => context.close() };
}
const settle = (page) => page.waitForTimeout(150);
const count = (page) => page.evaluate(() => window.countViolets());
const push = (page, ev) => page.evaluate(([type, e]) => window.push(type, e), [WS, ev]);
const pushAll = async (page, events) => {
  for (const ev of events) await push(page, ev);
  await settle(page);
};
// A subscribe_entities event (compressed format) turning the other script's toggle entity on or off,
// whatever entity it subscribed to.
const setExternal = (page, on) =>
  page.evaluate((state) => {
    const a = Object.fromEntries((window.__entityIds || []).map((id) => [id, { s: state, a: {} }]));
    window.push("subscribe_entities", { a });
  }, on ? "on" : "off");
const waitLive = (page) => page.waitForFunction((type) => window.live(type) > 0, WS, { timeout: 15000 });

// 1. Integration only: the real event sequences, live options, off, the optional card.
{
  const { page, errors, close } = await newPage();
  await page.evaluate((url) => window.load(url), SCRIPT_URL);
  await waitLive(page);
  check("subscribes to violetas/subscribe without the library's resubscribe",
    await page.evaluate((type) => window.__options[type]?.resubscribe === false, WS));
  await pushAll(page, EVENTS.subscribe);
  check("enabled: 25 violets", (await count(page)) === 25, String(await count(page)));
  if (process.env.SCREENSHOT) {
    await page.evaluate(() => {
      document.body.style.cssText = "margin:0;height:100vh;background:#fafafa;font:600 28px system-ui;color:#212121";
      document.body.insertAdjacentHTML("afterbegin", "<p style='margin:40px'>Violetas</p>");
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: process.env.SCREENSHOT, clip: { x: 0, y: 0, width: 1280, height: 640 } });
  }
  const layer = await page.evaluate(() => {
    const host = document.getElementById("violetas-overlay");
    const r = host.shadowRoot.querySelector(".layer").getBoundingClientRect();
    const s = getComputedStyle(host.shadowRoot.querySelector(".layer"));
    const hit = document.elementFromPoint(640, 450);
    return { w: r.width, h: r.height, pos: s.position, pe: s.pointerEvents, hitsOverlay: hit === host };
  });
  check("fixed full-viewport layer, pointer-events none, does not intercept clicks",
    layer.w === 1280 && layer.h === 900 && layer.pos === "fixed" && layer.pe === "none" && !layer.hitsOverlay,
    JSON.stringify(layer));
  const firstLeft = await page.evaluate(() => window.firstLeft());
  for (const name of ["rename_entity_id", "reload_entry"]) {
    await pushAll(page, EVENTS[name]);
    const n = await count(page);
    check(`${name}: same flowers, not hidden or reshuffled`,
      n === 25 && (await page.evaluate(() => window.firstLeft())) === firstLeft, `${n} violets`);
  }
  await pushAll(page, [snap({ count: 40, speed: "slow", opacity: 0.5 })]);
  check("live options: 40 violets", (await count(page)) === 40, String(await count(page)));
  await pushAll(page, EVENTS.unload_entry);
  check("unload_entry: 0 violets and no overlay host",
    (await count(page)) === 0 && !(await page.evaluate(() => document.getElementById("violetas-overlay"))));
  // Optional card: draws while global is off, nothing while it is on.
  await page.evaluate(() => {
    const card = document.createElement("violet-fall-card");
    card.setConfig({ count: 7 });
    document.body.append(card);
  });
  await settle(page);
  check("card alone: 7 violets", (await count(page)) === 7, String(await count(page)));
  await pushAll(page, [snap()]);
  check("card + global: only the 25 global violets", (await count(page)) === 25, String(await count(page)));
  await page.evaluate((url) => window.load(`${url}&again=1`), SCRIPT_URL);
  await settle(page);
  check("script loaded twice: one subscription", await page.evaluate((type) => window.live(type) === 1, WS));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await close();
}

// 2. Home Assistant still starting: the first subscribes fail (unknown_command), a retry works.
{
  const { page, errors, close } = await newPage({ rejectFirst: 2 });
  await page.evaluate((url) => window.load(url), SCRIPT_URL);
  await waitLive(page);
  check("rejected twice, subscribed on the third attempt",
    (await page.evaluate((type) => window.__attempts[type], WS)) === 3);
  await pushAll(page, [snap()]);
  check("after the retries: 25 violets", (await count(page)) === 25, String(await count(page)));
  check("startup retries: no page errors", errors.length === 0, errors.join(" | "));
  await close();
}

// 3. Reconnects (Home Assistant restarted).
{
  const { page, errors, close } = await newPage();
  await page.evaluate((url) => window.load(url), SCRIPT_URL);
  await waitLive(page);
  await pushAll(page, [snap()]);

  // 3a. The resubscribe lands before the integration is loaded again: rejected once, then retried.
  await page.evaluate(() => window.reconnect(1));
  await waitLive(page);
  await pushAll(page, [snap({ enabled: false })]);
  check("reconnect, first resubscribe rejected: updates still arrive (switched off: 0 violets)",
    (await count(page)) === 0, String(await count(page)));

  // 3b. The integration is gone for good: hidden after RETRY.hideAfterFailures failures, back once it answers.
  await pushAll(page, [snap()]);
  check("before the long outage: 25 violets", (await count(page)) === 25, String(await count(page)));
  await page.evaluate(() => window.reconnect(3));
  await page.waitForFunction(() => window.countViolets() === 0, null, { timeout: 15000 }).catch(() => {});
  check("three failed resubscribes: violets hidden", (await count(page)) === 0, String(await count(page)));
  await waitLive(page);
  await pushAll(page, [snap()]);
  check("integration answers again: 25 violets", (await count(page)) === 25, String(await count(page)));
  check("still one live subscription", await page.evaluate((type) => window.live(type) === 1, WS));
  check("reconnects: no page errors", errors.length === 0, errors.join(" | "));
  await close();
}

// 4. Reduced motion: nothing drawn.
{
  const { page, close } = await newPage({ reducedMotion: "reduce" });
  await page.evaluate((url) => window.load(url), SCRIPT_URL);
  await waitLive(page);
  await pushAll(page, [snap()]);
  check("prefers-reduced-motion: 0 violets", (await count(page)) === 0, String(await count(page)));
  await close();
}

// 5. Coexistence with a separately distributed violet-fall-card script sharing the global key.
if (EXTERNAL && existsSync(EXTERNAL)) {
  // 5a. Integration script first (the usual order: extra_module_url loads before Lovelace resources).
  {
    const { page, errors, close } = await newPage();
    await page.evaluate((url) => window.load(url), SCRIPT_URL);
    await page.evaluate(() => window.load("/local/violet-fall-card.js?v=3"));
    await waitLive(page);
    await settle(page);
    check("integration first: the other script does not subscribe to its helper",
      !(await page.evaluate(() => window.live("subscribe_entities"))));
    await pushAll(page, [snap()]);
    check("integration first: 25 violets, not 50", (await count(page)) === 25, String(await count(page)));
    check("integration first: no page errors", errors.length === 0, errors.join(" | "));
    await close();
  }
  // 5b. The other script first, its helper on, then the integration also on.
  {
    const { page, errors, close } = await newPage();
    await page.evaluate(() => window.load("/local/violet-fall-card.js?v=3"));
    await page.waitForFunction(() => window.live("subscribe_entities"));
    await setExternal(page, true);
    await page.evaluate((url) => window.load(url), SCRIPT_URL);
    await waitLive(page);
    await pushAll(page, [snap({ count: 40 })]);
    check("other script first, both on: only one overlay (its 25 violets)", (await count(page)) === 25, String(await count(page)));
    await setExternal(page, false);
    await settle(page);
    check("other script's helper off: integration overlay takes over (40)", (await count(page)) === 40, String(await count(page)));
    await setExternal(page, true);
    await settle(page);
    const n = await count(page);
    check("other script's helper back on: still a single overlay", n === 25 || n === 40, String(n));
    await push(page, snap({ enabled: false }));
    await setExternal(page, false);
    await settle(page);
    check("both off: 0 violets", (await count(page)) === 0, String(await count(page)));
    check("other script first: no page errors", errors.length === 0, errors.join(" | "));
    await close();
  }
} else {
  console.log("SKIP  coexistence checks (set EXTERNAL_CARD_JS to run them)");
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
