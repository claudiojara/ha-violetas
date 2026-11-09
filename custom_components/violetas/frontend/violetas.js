/**
 * Violetas — falling violets for Home Assistant.
 *
 * Served by the `violetas` integration and loaded on every frontend page
 * (`frontend.add_extra_js_url`), for every user. Vanilla JS, no build step,
 * no external dependencies. Drawing code from violet-fall-card 2.0.1.
 *
 * 1. Global overlay: the script subscribes to the `violetas/subscribe`
 *    websocket command. Each event is a snapshot
 *      { enabled, count, speed, opacity }
 *    sent on subscribe and whenever the switch or the options change. While
 *    `enabled` is true, one fixed overlay attached to document.body shows the
 *    violets (pointer-events: none). The subscription is kept alive across
 *    reconnects (see keepSubscribed).
 *
 * 2. Optional card: `type: custom:violet-fall-card` in a single view
 *    (count / speed / opacity / colors). It renders nothing while the global
 *    overlay is shown.
 *
 * Coexists with any other script that uses the same global key (for example
 * a violet-fall-card file added separately as a dashboard resource): whichever
 * loads second does not start a second overlay, so there are never double
 * flowers.
 *
 * Respects prefers-reduced-motion (renders nothing) and pauses all
 * animations while the document is hidden.
 */
const VERSION = "0.1.0"; // must equal manifest.json (checked by the tests)

// Options: same defaults and count range as the integration (const.py). The
// card also accepts opacity 0, the integration's options start at 0.1.
const DEFAULT_COUNT = 25;
const MIN_COUNT = 1;
const MAX_COUNT = 80;
const DEFAULT_SPEED = "normal";
const DEFAULT_OPACITY = 0.9;
const DEFAULT_COLORS = ["#3f1a66", "#5b2a86", "#8e44ad", "#b57edc", "#d6b8f0"];

// Durations (seconds) of one full fall from above the top to below the bottom.
const SPEEDS = {
  slow: [16, 26],
  normal: [10, 17],
  fast: [6, 10],
};

// Look of each flower: [min, max] ranges picked at random per flower.
const TUNING = {
  size: [14, 30], // px
  // The smallest flower takes this much longer to fall than the largest
  // (linear in between), which reads as depth.
  smallestSlowdown: 1.25,
  left: [-2, 98], // % of the width
  opacityJitter: [0.55, 1], // multiplied by the configured opacity
  swayAmplitude: [12, 45], // px
  swayDuration: [2.2, 4.5], // s
  spinStart: [-50, 10], // deg
  spinTurn: [40, 110], // deg
  spinDuration: [2.8, 6], // s
};

// One global slot per page, shared by every copy of this script and by any
// other script that uses the same key and event name (for example a
// violet-fall-card file added separately as a dashboard resource). It says
// whether a full-screen overlay is already drawn, so nobody draws a second one.
export const GLOBAL_KEY = "__violetFallGlobal";
const GLOBAL_EVENT = "violet-fall-global-change";
const WS_SUBSCRIBE = "violetas/subscribe";
// Waiting for the frontend to create its connection.
const CONNECTION_POLL_MS = 1000;
// Subscribe retries: exponential from firstMs up to maxMs; after
// hideAfterFailures failures in a row the overlay is hidden until one works.
export const RETRY = { firstMs: 1000, maxMs: 60000, hideAfterFailures: 3 };

const SVG_NS = "http://www.w3.org/2000/svg";

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// ---------------------------------------------------------------------------
// Pure logic (no DOM; unit-tested with `node --test`)
// ---------------------------------------------------------------------------

/** Validates and fills defaults for count / speed / opacity / colors. */
export function normalizeConfig(config) {
  const speed = Object.prototype.hasOwnProperty.call(SPEEDS, config.speed) ? config.speed : DEFAULT_SPEED;
  const n = Number.parseInt(config.count, 10);
  const count = Number.isFinite(n) ? clamp(n, MIN_COUNT, MAX_COUNT) : DEFAULT_COUNT;
  const op = Number.parseFloat(config.opacity);
  const opacity = Number.isFinite(op) ? clamp(op, 0, 1) : DEFAULT_OPACITY;
  const colors = Array.isArray(config.colors)
    ? config.colors.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim())
    : [];
  return { count, speed, opacity, colors: colors.length ? colors : DEFAULT_COLORS };
}

/**
 * Reads one `violetas/subscribe` event. Only a literal `enabled: true` shows
 * the overlay; `key` changes only when the drawing options change, so a
 * state-only update never reshuffles the flowers.
 */
export function parseSnapshot(event) {
  const ev = event && typeof event === "object" ? event : {};
  const config = normalizeConfig({ count: ev.count, speed: ev.speed, opacity: ev.opacity });
  return { enabled: ev.enabled === true, config, key: JSON.stringify(config) };
}

/** Another script's overlay already covers the screen: don't add a second one. */
export const shouldShowOverlay = ({ enabled, externalActive }) => Boolean(enabled) && !externalActive;

/**
 * Takes the shared global slot in `win`.
 * - Already taken by this script (loaded twice): `skip`.
 * - Taken by another script using the same key: keep a reference to it
 *   (`external`) and expose `active` as "either overlay is shown", which is
 *   what card instances of both scripts read to avoid double flowers.
 * - Free: take it. Another script loading later sees it taken and does not
 *   start its own overlay.
 */
export function claimGlobal(win, version) {
  const previous = win[GLOBAL_KEY];
  if (previous && previous.integration) return { skip: true };
  const external = previous || undefined;
  let mine = false;
  const shared = {
    integration: version,
    get active() {
      return mine || Boolean(external && external.active);
    },
  };
  win[GLOBAL_KEY] = shared;
  return {
    skip: false,
    external,
    shared,
    setMine(on) {
      mine = Boolean(on);
    },
  };
}

export const retryDelay = (failures) => Math.min(RETRY.firstMs * 2 ** (failures - 1), RETRY.maxMs);

/**
 * Keeps one `violetas/subscribe` subscription alive on a
 * home-assistant-js-websocket Connection and returns a function that stops it.
 *
 * The library's own resubscribe-on-reconnect is turned off (`resubscribe:
 * false`): when it fails (for example a reconnect while Home Assistant is
 * still starting and has not registered `violetas/subscribe` yet) the error is
 * swallowed and the tab never gets another update. Instead:
 * - every `ready` event (a reconnect) subscribes again;
 * - a failed subscribe is retried with exponential backoff (RETRY), forever;
 * - after RETRY.hideAfterFailures failures in a row `onLost` is called once
 *   (the caller hides the overlay) until a subscribe works again.
 * Events of a superseded subscription are ignored.
 */
export function keepSubscribed(conn, onEvent, onLost, { timers = globalThis, log = console } = {}) {
  let generation = 0;
  let failures = 0;
  let retryTimer = null;
  let unsubscribe = null;

  const safely = (fn) => {
    try {
      Promise.resolve(fn?.()).catch(() => {});
    } catch {
      // The connection is gone: nothing left to unsubscribe.
    }
  };
  const cancelRetry = () => {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  };
  const dropCurrent = () => {
    const unsub = unsubscribe;
    unsubscribe = null;
    safely(unsub);
  };

  const subscribe = () => {
    cancelRetry();
    dropCurrent();
    const attempt = ++generation;
    let request;
    try {
      request = conn.subscribeMessage(
        (event) => {
          if (attempt === generation) onEvent(event);
        },
        { type: WS_SUBSCRIBE },
        { resubscribe: false },
      );
    } catch (err) {
      request = Promise.reject(err);
    }
    Promise.resolve(request).then(
      (unsub) => {
        if (attempt !== generation) {
          safely(unsub);
          return;
        }
        unsubscribe = unsub;
        failures = 0;
      },
      (err) => {
        if (attempt !== generation) return;
        failures += 1;
        if (failures === RETRY.hideAfterFailures) {
          log.warn("violetas: cannot subscribe, hiding the violets and retrying:", err?.message || err);
          onLost(err);
        }
        retryTimer = timers.setTimeout(subscribe, retryDelay(failures));
      },
    );
  };

  const onReady = () => {
    failures = 0;
    subscribe();
  };
  conn.addEventListener?.("ready", onReady);
  subscribe();

  return () => {
    generation += 1;
    cancelRetry();
    conn.removeEventListener?.("ready", onReady);
    dropCurrent();
  };
}

// ---------------------------------------------------------------------------
// Rendering (shared by the card and the global overlay)
// ---------------------------------------------------------------------------

// One petal: an ellipse pushed away from the center and rotated around it.
function petal(cls, angle, rx, ry, dist) {
  const e = document.createElementNS(SVG_NS, "ellipse");
  e.setAttribute("class", cls);
  e.setAttribute("cx", "0");
  e.setAttribute("cy", String(-dist));
  e.setAttribute("rx", String(rx));
  e.setAttribute("ry", String(ry));
  e.setAttribute("transform", `rotate(${angle})`);
  return e;
}

// Builds the violet artwork once; every flower clones it.
// viewBox is centered on the flower's throat.
function buildVioletTemplate() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "-50 -50 100 100");
  svg.setAttribute("aria-hidden", "true");
  // Upper pair (darker), drawn first so the lower petals overlap them.
  svg.append(petal("up", -28, 15, 22, 22), petal("up", 28, 15, 22, 22));
  // Two lateral petals and the wide lower lip (lighter).
  svg.append(petal("low", -105, 13, 19, 19), petal("low", 105, 13, 19, 19));
  svg.append(petal("low", 180, 17, 21, 20));
  // Fine nectar guides on the lower lip.
  for (const x of [-4, 0, 4]) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("class", "vein");
    l.setAttribute("x1", "0");
    l.setAttribute("y1", "6");
    l.setAttribute("x2", String(x * 1.6));
    l.setAttribute("y2", "20");
    svg.append(l);
  }
  // Yellow-white center.
  const eye = document.createElementNS(SVG_NS, "circle");
  eye.setAttribute("class", "eye");
  eye.setAttribute("r", "6");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "dot");
  dot.setAttribute("r", "2.6");
  dot.setAttribute("cy", "1");
  svg.append(eye, dot);
  return svg;
}

const STYLE = `
  :host {
    display: block;
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: visible;
    pointer-events: none;
    background: none !important;
  }
  .layer {
    position: fixed;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 999;
    contain: strict;
  }
  /* Three nested elements: fall (vertical), sway (horizontal), spin (rotation). */
  .fall {
    position: absolute;
    top: 0;
    will-change: transform;
    animation: vf-fall linear infinite;
  }
  .sway {
    animation: vf-sway ease-in-out infinite alternate;
  }
  .spin {
    animation: vf-spin ease-in-out infinite alternate;
  }
  .spin svg { display: block; width: 100%; height: 100%; overflow: visible; }
  .up { fill: var(--vf-up); }
  .low { fill: var(--vf-low); }
  .vein { stroke: var(--vf-up); stroke-width: 1.4; stroke-linecap: round; opacity: 0.55; }
  .eye { fill: #fff6cf; }
  .dot { fill: #f2c418; }
  @keyframes vf-fall {
    from { transform: translateY(-12vh); }
    to   { transform: translateY(112vh); }
  }
  @keyframes vf-sway {
    from { transform: translateX(calc(-1 * var(--vf-amp))); }
    to   { transform: translateX(var(--vf-amp)); }
  }
  @keyframes vf-spin {
    from { transform: rotate(var(--vf-r0)); }
    to   { transform: rotate(var(--vf-r1)); }
  }
  :host([paused]) .fall,
  :host([paused]) .sway,
  :host([paused]) .spin { animation-play-state: paused; }
  @media (prefers-reduced-motion: reduce) {
    .layer { display: none; }
  }
`;

function styleElement() {
  const style = document.createElement("style");
  style.textContent = STYLE;
  return style;
}

const pick = ([min, max]) => rand(min, max);

// 1 for the largest flower up to TUNING.smallestSlowdown for the smallest.
function depthSlowdown(size) {
  const [min, max] = TUNING.size;
  return TUNING.smallestSlowdown - ((TUNING.smallestSlowdown - 1) * (size - min)) / (max - min);
}

function buildLayer({ count, speed, opacity, colors }) {
  const template = buildVioletTemplate();
  const layer = document.createElement("div");
  layer.className = "layer";

  for (let i = 0; i < count; i++) {
    const size = pick(TUNING.size);
    const dur = pick(SPEEDS[speed]) * depthSlowdown(size);
    const shade = colors.length > 1 ? Math.floor(Math.random() * (colors.length - 1)) : 0;
    const up = colors[shade];
    const low = colors[Math.min(shade + 1, colors.length - 1)];
    const r0 = pick(TUNING.spinStart);

    const fall = document.createElement("div");
    fall.className = "fall";
    fall.style.left = `${pick(TUNING.left).toFixed(2)}%`;
    fall.style.width = `${size.toFixed(1)}px`;
    fall.style.height = `${size.toFixed(1)}px`;
    fall.style.opacity = (pick(TUNING.opacityJitter) * opacity).toFixed(2);
    fall.style.animationDuration = `${dur.toFixed(2)}s`;
    // Negative delay spreads the flowers over the screen from the first frame.
    fall.style.animationDelay = `${(-Math.random() * dur).toFixed(2)}s`;

    const sway = document.createElement("div");
    sway.className = "sway";
    sway.style.setProperty("--vf-amp", `${pick(TUNING.swayAmplitude).toFixed(1)}px`);
    const swayDur = pick(TUNING.swayDuration);
    sway.style.animationDuration = `${swayDur.toFixed(2)}s`;
    sway.style.animationDelay = `${(-Math.random() * swayDur).toFixed(2)}s`;

    const spin = document.createElement("div");
    spin.className = "spin";
    spin.style.width = "100%";
    spin.style.height = "100%";
    spin.style.setProperty("--vf-r0", `${r0.toFixed(1)}deg`);
    spin.style.setProperty("--vf-r1", `${(r0 + pick(TUNING.spinTurn)).toFixed(1)}deg`);
    const spinDur = pick(TUNING.spinDuration);
    spin.style.animationDuration = `${spinDur.toFixed(2)}s`;
    spin.style.animationDelay = `${(-Math.random() * spinDur).toFixed(2)}s`;
    // setProperty keeps user-supplied colors out of any markup string.
    spin.style.setProperty("--vf-up", up);
    spin.style.setProperty("--vf-low", low);

    spin.append(template.cloneNode(true));
    sway.append(spin);
    fall.append(sway);
    layer.append(fall);
  }
  return layer;
}

/**
 * Renders the violets into `host`'s shadow root and keeps them in sync with
 * page visibility (pause) and reduced motion (nothing drawn). Returns a
 * function that stops listening and removes every animated node.
 */
function attachViolets(host, config) {
  const root = host.shadowRoot || host.attachShadow({ mode: "open" });
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncPaused = () => host.toggleAttribute("paused", document.hidden);
  const render = () => {
    root.replaceChildren(styleElement());
    syncPaused();
    // Reduced motion: render nothing at all (the CSS media query is a fallback).
    if (!motion.matches) root.append(buildLayer(config));
  };
  document.addEventListener("visibilitychange", syncPaused);
  motion.addEventListener?.("change", render);
  render();
  return () => {
    document.removeEventListener("visibilitychange", syncPaused);
    motion.removeEventListener?.("change", render);
    root.replaceChildren(styleElement());
  };
}

const globalOverlayActive = () => Boolean(window[GLOBAL_KEY]?.active);

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

// HTMLElement does not exist outside a browser (unit tests import this file).
const BaseElement = typeof HTMLElement === "undefined" ? class {} : HTMLElement;

class VioletFallCard extends BaseElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._key = "";
    this._dispose = null;
    this._onGlobalChange = () => this._update();
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("violet-fall-card: invalid config");
    const normalized = normalizeConfig(config);
    // Only rebuild when the effective config changes, so Lovelace re-applying
    // the same config does not reshuffle the flowers.
    const key = JSON.stringify(normalized);
    if (key !== this._key) {
      this._key = key;
      this._config = normalized;
      if (this.isConnected) this._update();
    }
  }

  set hass(_hass) {
    // Purely decorative: no entities, no service calls.
  }

  getCardSize() {
    return 0;
  }

  static getStubConfig() {
    return { count: DEFAULT_COUNT, speed: DEFAULT_SPEED, opacity: DEFAULT_OPACITY };
  }

  connectedCallback() {
    window.addEventListener(GLOBAL_EVENT, this._onGlobalChange);
    this._update();
  }

  disconnectedCallback() {
    window.removeEventListener(GLOBAL_EVENT, this._onGlobalChange);
    this._stop();
  }

  _stop() {
    this._dispose?.();
    this._dispose = null;
  }

  _update() {
    this._stop();
    // Keep the zero-size :host style even when nothing is drawn.
    this.shadowRoot.replaceChildren(styleElement());
    // The global overlay already covers the screen: avoid double flowers.
    if (this._config && !globalOverlayActive()) this._dispose = attachViolets(this, this._config);
  }
}

// ---------------------------------------------------------------------------
// Global overlay, driven by the integration
// ---------------------------------------------------------------------------

function startGlobalOverlay(claim) {
  let snapshot = parseSnapshot(null);
  let host = null;
  let dispose = null;
  let drawnKey = null;
  let shown = false;

  const sync = () => {
    const show = shouldShowOverlay({
      enabled: snapshot.enabled,
      externalActive: Boolean(claim.external?.active),
    });
    if (show && drawnKey !== snapshot.key) {
      // First show, or new options: (re)draw with the new config.
      dispose?.();
      if (!host) {
        host = document.createElement("div");
        host.id = "violetas-overlay";
        host.setAttribute("aria-hidden", "true");
        document.body.append(host);
      }
      dispose = attachViolets(host, snapshot.config);
      drawnKey = snapshot.key;
    } else if (!show && host) {
      dispose?.();
      host.remove();
      host = dispose = drawnKey = null;
    }
    if (show !== shown) {
      shown = show;
      claim.setMine(show);
      window.dispatchEvent(new CustomEvent(GLOBAL_EVENT));
    }
  };

  // Another script sharing GLOBAL_KEY announces its overlay changes with the same event.
  window.addEventListener(GLOBAL_EVENT, sync);

  // The frontend creates `hass` after this script starts loading: poll until
  // the connection exists, then keep the subscription alive across reconnects.
  const connect = () => {
    const conn = document.querySelector("home-assistant")?.hass?.connection;
    if (!conn || !document.body) {
      setTimeout(connect, CONNECTION_POLL_MS);
      return;
    }
    keepSubscribed(
      conn,
      (event) => {
        snapshot = parseSnapshot(event);
        sync();
      },
      () => {
        snapshot = parseSnapshot(null);
        sync();
      },
    );
  };
  connect();
}

// ---------------------------------------------------------------------------
// Registration (browser only; guarded against loading the script twice)
// ---------------------------------------------------------------------------

if (typeof window !== "undefined" && typeof customElements !== "undefined") {
  if (!customElements.get("violet-fall-card")) {
    customElements.define("violet-fall-card", VioletFallCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: "violet-fall-card",
      name: "Violetas (falling violets)",
      description: "Falling violets in this view only (decorative, no entities).",
      preview: false,
    });
  }
  const claim = claimGlobal(window, VERSION);
  if (!claim.skip) {
    console.info(`%c violetas %c ${VERSION} `, "background:#5b2a86;color:#fff", "background:#d6b8f0;color:#3f1a66");
    startGlobalOverlay(claim);
  }
}
