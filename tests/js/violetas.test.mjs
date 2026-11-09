// Unit tests for the pure logic of violetas.js (run: node --test tests/js).
// The module must be importable outside a browser: no DOM access at import time.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_KEY,
  RETRY,
  normalizeConfig,
  parseSnapshot,
  shouldShowOverlay,
  claimGlobal,
  keepSubscribed,
  retryDelay,
} from "../../custom_components/violetas/frontend/violetas.js";

const DEFAULT_COLORS = ["#3f1a66", "#5b2a86", "#8e44ad", "#b57edc", "#d6b8f0"];

test("normalizeConfig: defaults", () => {
  assert.deepEqual(normalizeConfig({}), { count: 25, speed: "normal", opacity: 0.9, colors: DEFAULT_COLORS });
});

test("normalizeConfig: clamps and validates values", () => {
  const c = normalizeConfig({ count: "500", speed: "warp", opacity: 3 });
  assert.equal(c.count, 80);
  assert.equal(c.speed, "normal");
  assert.equal(c.opacity, 1);
  assert.equal(normalizeConfig({ speed: "toString" }).speed, "normal");
});

test("normalizeConfig: count is clamped, never mistaken for missing", () => {
  assert.equal(normalizeConfig({ count: 0 }).count, 1);
  assert.equal(normalizeConfig({ count: -4 }).count, 1);
  assert.equal(normalizeConfig({ count: 1 }).count, 1);
  assert.equal(normalizeConfig({ count: 80 }).count, 80);
  assert.equal(normalizeConfig({ count: "40" }).count, 40);
  assert.equal(normalizeConfig({ count: 40.7 }).count, 40);
  for (const missing of [undefined, null, "", "many", Infinity, NaN]) {
    assert.equal(normalizeConfig({ count: missing }).count, 25, String(missing));
  }
});

test("normalizeConfig: opacity", () => {
  assert.equal(normalizeConfig({ opacity: 0 }).opacity, 0);
  assert.equal(normalizeConfig({ opacity: -1 }).opacity, 0);
  assert.equal(normalizeConfig({ opacity: "0.4" }).opacity, 0.4);
  assert.equal(normalizeConfig({ opacity: "x" }).opacity, 0.9);
  assert.equal(normalizeConfig({ opacity: Infinity }).opacity, 0.9);
});

test("normalizeConfig: colors", () => {
  assert.deepEqual(normalizeConfig({ colors: [" #111 ", "", 4, "#222"] }).colors, ["#111", "#222"]);
  assert.deepEqual(normalizeConfig({ colors: [] }).colors, DEFAULT_COLORS);
});

test("parseSnapshot: integration event", () => {
  const s = parseSnapshot({ enabled: true, count: 40, speed: "slow", opacity: 0.5 });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.config, { count: 40, speed: "slow", opacity: 0.5, colors: DEFAULT_COLORS });
  assert.equal(typeof s.key, "string");
  assert.deepEqual(Object.keys(s).sort(), ["config", "enabled", "key"]);
});

test("parseSnapshot: only a literal true enables; garbage is safe", () => {
  assert.equal(parseSnapshot({ enabled: "true" }).enabled, false);
  assert.equal(parseSnapshot(null).enabled, false);
  assert.equal(parseSnapshot(undefined).enabled, false);
  assert.equal(parseSnapshot({ enabled: true, count: "x" }).config.count, 25);
});

test("parseSnapshot: key changes only with the drawing options", () => {
  const a = parseSnapshot({ enabled: true, count: 30 });
  const b = parseSnapshot({ enabled: false, count: 30 });
  const c = parseSnapshot({ enabled: true, count: 31 });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test("shouldShowOverlay: on unless another script's overlay is already drawing", () => {
  assert.equal(shouldShowOverlay({ enabled: true, externalActive: false }), true);
  assert.equal(shouldShowOverlay({ enabled: true, externalActive: true }), false);
  assert.equal(shouldShowOverlay({ enabled: false, externalActive: false }), false);
});

test("claimGlobal: fresh page", () => {
  const win = {};
  const claim = claimGlobal(win, "1.2.3");
  assert.equal(claim.skip, false);
  assert.equal(claim.external, undefined);
  assert.equal(win[GLOBAL_KEY], claim.shared);
  assert.equal(win[GLOBAL_KEY].integration, "1.2.3");
  assert.equal(win[GLOBAL_KEY].active, false);
  claim.setMine(true);
  assert.equal(win[GLOBAL_KEY].active, true);
});

test("claimGlobal: a separately loaded violet-fall-card script got there first", () => {
  const external = { active: false };
  const win = { [GLOBAL_KEY]: external };
  const claim = claimGlobal(win, "1.2.3");
  assert.equal(claim.skip, false);
  assert.equal(claim.external, external);
  // Cards of either script read window[GLOBAL_KEY].active: it must reflect both overlays.
  assert.equal(win[GLOBAL_KEY].active, false);
  external.active = true;
  assert.equal(win[GLOBAL_KEY].active, true);
  external.active = false;
  claim.setMine(true);
  assert.equal(win[GLOBAL_KEY].active, true);
});

test("claimGlobal: this script loaded twice runs once", () => {
  const win = {};
  claimGlobal(win, "1.2.3");
  const again = claimGlobal(win, "1.2.3");
  assert.equal(again.skip, true);
});

// --- keepSubscribed -------------------------------------------------------

/** A home-assistant-js-websocket Connection stand-in: each subscribe is answered by the test. */
function fakeConnection() {
  const conn = {
    calls: [],
    listeners: {},
    subscribeMessage(callback, message, options) {
      let settle;
      const promise = new Promise((resolve, reject) => (settle = { resolve, reject }));
      const call = {
        callback,
        message,
        options,
        unsubscribed: 0,
        accept() {
          settle.resolve(() => {
            call.unsubscribed += 1;
          });
        },
        reject(error = { code: "unknown_command", message: "Unknown command." }) {
          settle.reject(error);
        },
      };
      conn.calls.push(call);
      return promise;
    },
    addEventListener(type, cb) {
      (conn.listeners[type] ||= []).push(cb);
    },
    removeEventListener(type, cb) {
      conn.listeners[type] = (conn.listeners[type] || []).filter((x) => x !== cb);
    },
    fire(type) {
      (conn.listeners[type] || []).forEach((cb) => cb(conn));
    },
    get last() {
      return conn.calls.at(-1);
    },
  };
  return conn;
}

function fakeTimers() {
  const timers = {
    pending: new Map(),
    next: 1,
    setTimeout(fn, ms) {
      const id = timers.next++;
      timers.pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.pending.delete(id);
    },
    /** Runs the only pending timer and returns its delay. */
    runOnly() {
      assert.equal(timers.pending.size, 1, "exactly one retry scheduled");
      const [[id, { fn, ms }]] = timers.pending;
      timers.pending.delete(id);
      fn();
      return ms;
    },
  };
  return timers;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const quiet = { warn() {} };

function setup() {
  const conn = fakeConnection();
  const timers = fakeTimers();
  const events = [];
  let lost = 0;
  const stop = keepSubscribed(conn, (ev) => events.push(ev), () => (lost += 1), { timers, log: quiet });
  return { conn, timers, events, stop, lost: () => lost };
}

test("retryDelay: exponential, capped", () => {
  assert.equal(retryDelay(1), RETRY.firstMs);
  assert.equal(retryDelay(2), RETRY.firstMs * 2);
  assert.equal(retryDelay(3), RETRY.firstMs * 4);
  assert.equal(retryDelay(100), RETRY.maxMs);
});

test("keepSubscribed: subscribes once, without the library's resubscribe, and forwards events", async () => {
  const { conn, events } = setup();
  assert.equal(conn.calls.length, 1);
  assert.deepEqual(conn.last.message, { type: "violetas/subscribe" });
  assert.equal(conn.last.options.resubscribe, false);
  conn.last.accept();
  await flush();
  conn.last.callback({ enabled: true });
  assert.deepEqual(events, [{ enabled: true }]);
});

test("keepSubscribed: a rejected subscribe is retried with backoff until accepted", async () => {
  const { conn, timers, events, lost } = setup();
  conn.last.reject();
  await flush();
  assert.equal(timers.runOnly(), RETRY.firstMs);
  assert.equal(conn.calls.length, 2);
  conn.last.accept();
  await flush();
  assert.equal(timers.pending.size, 0);
  conn.last.callback({ enabled: true });
  assert.deepEqual(events, [{ enabled: true }]);
  assert.equal(lost(), 0);
});

test("keepSubscribed: persistent failure reports lost once and keeps retrying at the cap", async () => {
  const { conn, timers, lost } = setup();
  const delays = [];
  for (let i = 0; i < 10; i++) {
    conn.last.reject();
    await flush();
    delays.push(timers.runOnly());
  }
  assert.equal(lost(), 1);
  assert.deepEqual(delays.slice(0, 3), [RETRY.firstMs, RETRY.firstMs * 2, RETRY.firstMs * 4]);
  assert.equal(delays.at(-1), RETRY.maxMs);
  assert.equal(conn.calls.length, 11);
});

test("keepSubscribed: lost is reported after RETRY.hideAfterFailures failures", async () => {
  const { conn, timers, lost } = setup();
  for (let i = 1; i <= RETRY.hideAfterFailures; i++) {
    assert.equal(lost(), 0);
    conn.last.reject();
    await flush();
    timers.runOnly();
  }
  assert.equal(lost(), 1);
});

test("keepSubscribed: resubscribes on reconnect (ready) and ignores the old subscription", async () => {
  const { conn, timers, events } = setup();
  const first = conn.last;
  first.accept();
  await flush();
  conn.fire("ready");
  assert.equal(conn.calls.length, 2);
  // HA is still starting: the command is not registered yet.
  conn.last.reject();
  await flush();
  timers.runOnly();
  conn.last.accept();
  await flush();
  first.callback({ enabled: true, from: "old" });
  conn.last.callback({ enabled: false, from: "new" });
  assert.deepEqual(events, [{ enabled: false, from: "new" }]);
});

test("keepSubscribed: a reconnect while a retry is pending subscribes right away, once", async () => {
  const { conn, timers } = setup();
  conn.last.reject();
  await flush();
  assert.equal(timers.pending.size, 1);
  conn.fire("ready");
  assert.equal(timers.pending.size, 0);
  assert.equal(conn.calls.length, 2);
});

test("keepSubscribed: a late success from a superseded attempt is unsubscribed", async () => {
  const { conn, events } = setup();
  const first = conn.last;
  conn.fire("ready");
  first.accept();
  await flush();
  assert.equal(first.unsubscribed, 1);
  first.callback({ enabled: true });
  assert.deepEqual(events, []);
});

test("keepSubscribed: stop unsubscribes and cancels retries", async () => {
  const { conn, timers, stop } = setup();
  conn.last.accept();
  await flush();
  stop();
  await flush();
  assert.equal(conn.last.unsubscribed, 1);
  conn.fire("ready");
  assert.equal(conn.calls.length, 1);
  assert.equal(timers.pending.size, 0);
});

test("keepSubscribed: a subscribeMessage that throws synchronously is retried", async () => {
  const conn = fakeConnection();
  const timers = fakeTimers();
  let throws = true;
  const original = conn.subscribeMessage;
  conn.subscribeMessage = (...args) => {
    if (throws) throw new Error("socket closing");
    return original(...args);
  };
  keepSubscribed(conn, () => {}, () => {}, { timers, log: quiet });
  await flush();
  throws = false;
  timers.runOnly();
  assert.equal(conn.calls.length, 1);
});
