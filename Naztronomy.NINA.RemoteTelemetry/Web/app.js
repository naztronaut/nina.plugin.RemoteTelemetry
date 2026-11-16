"use strict";

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c != null) e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

function kv(target, pairs) {
  target.replaceChildren(
    ...pairs
      .filter(([, v]) => v != null && v !== "")
      .flatMap(([k, v]) => [el("dt", { text: k }), el("dd", null, v)]),
  );
}

const fmt = {
  num: (v, d = 1, unit = "") =>
    v == null ? null : `${Number(v).toFixed(d)}${unit}`,
  time: (iso, tz) =>
    iso ? new Date(iso).toLocaleTimeString([], zoneOpts(tz)) : null,
  hm: (iso, tz) =>
    iso
      ? new Date(iso).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          ...zoneOpts(tz),
        })
      : null,
  duration(seconds) {
    if (seconds == null) return null;
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  },
  long(seconds) {
    if (seconds == null) return null;
    const h = seconds / 3600;
    return h >= 48
      ? `≈${(h / 24).toFixed(1)} days (${Math.round(h)} h)`
      : fmt.duration(seconds);
  },
  until(iso) {
    if (!iso) return null;
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    return s <= 0 ? "now" : `in ${fmt.duration(s)}`;
  },
  ago(iso) {
    if (!iso) return null;
    const s = Math.max(
      0,
      Math.round((Date.now() - new Date(iso).getTime()) / 1000),
    );
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  },
};

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("Enter an address such as 100.64.0.12:8787.");
  // An https page can only call https NINAs, so default to https there.
  if (!/^https?:\/\//i.test(s))
    s = `${location.protocol === "https:" ? "https" : "http"}://${s}`;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("Only http(s) addresses are supported.");
  if (!u.port && u.protocol === "http:") u.port = "8787";
  return u.origin;
}

// Set by the standalone (e.g. Cloudflare-hosted) build, which is not served by a NINA.
const HOSTED =
  document.querySelector('meta[name="nrt-hosted"]')?.content === "1";

const isLocalHost = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

function mixedContentProblem(url) {
  const u = new URL(url);
  return location.protocol === "https:" &&
    u.protocol === "http:" &&
    !isLocalHost(u.hostname)
    ? "This page is served over https, so browsers block plain http:// NINA addresses. Turn on “Serve the dashboard over HTTPS on my tailnet” in the plugin options and use the https://…ts.net address it shows."
    : null;
}

// ---------- persisted state ----------

const KEYS = {
  devices: "nina-remote-telemetry.devices",
  layout: "nina-remote-telemetry.layout",
  view: "nina-remote-telemetry.view",
  night: "nina-remote-telemetry.night",
  timeMode: "nina-remote-telemetry.timeMode",
  tab: "nina-remote-telemetry.tab",
};

let deviceTab = localStorage.getItem(KEYS.tab) === "ts" ? "ts" : "overview";

const tsAvailable = (feed) =>
  !!(feed.status?.scheduler?.enabled && feed.status.scheduler.apiReachable);

// Times are shown in each NINA's own time zone unless the user picks "My time".
let timeMode = localStorage.getItem(KEYS.timeMode) || "observatory";
// Zone of the card currently being rendered; set by the card wrapper.
let currentTz;

function zoneOpts(tz) {
  const zone = tz === undefined ? currentTz : tz;
  return timeMode === "observatory" && zone ? { timeZone: zone } : {};
}

function zoneFor(info) {
  const valid = (z) => {
    try {
      new Intl.DateTimeFormat([], { timeZone: z });
      return true;
    } catch {
      return false;
    }
  };
  if (info?.timeZone && valid(info.timeZone)) return info.timeZone;
  const m = info?.utcOffsetMinutes;
  // Etc/GMT zones have inverted signs: Etc/GMT-2 is UTC+2.
  if (m != null && m % 60 === 0) {
    const z =
      m === 0 ? "Etc/GMT" : `Etc/GMT${m > 0 ? "-" : "+"}${Math.abs(m / 60)}`;
    if (valid(z)) return z;
  }
  return undefined;
}

function offsetLabel(info) {
  const m = info?.utcOffsetMinutes;
  if (m == null) return "";
  const sign = m < 0 ? "-" : "+";
  const a = Math.abs(m);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

let devices = [];
let layout = []; // [{ id, type, deviceId, span }]
let currentView = "custom"; // 'custom' | 'device:<id>'
let editMode = false;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadState() {
  devices = readJson(KEYS.devices, []);
  layout = readJson(KEYS.layout, []).filter((c) => CARDS[c.type]);
  currentView = localStorage.getItem(KEYS.view) || "custom";
}

const saveDevices = () =>
  localStorage.setItem(KEYS.devices, JSON.stringify(devices));
const saveLayout = () =>
  localStorage.setItem(KEYS.layout, JSON.stringify(layout));
const saveView = () => localStorage.setItem(KEYS.view, currentView);
const deviceById = (id) => devices.find((d) => d.id === id);

// ---------- API ----------

async function api(dev, path, timeoutMs = 8000, method = "GET") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = dev.key ? { "X-Api-Key": dev.key } : {};
    const res = await fetch(dev.url + path, {
      method,
      headers,
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* not JSON */
      }
      throw new Error(msg);
    }
    return await res.json();
  } catch (e) {
    throw e.name === "AbortError" ? new Error("Timed out") : e;
  } finally {
    clearTimeout(timer);
  }
}

function previewUrl(dev, imageId) {
  const params = new URLSearchParams({ t: String(imageId) });
  if (dev.key) params.set("key", dev.key);
  return `${dev.url}/api/v1/images/latest/preview.jpg?${params}`;
}

// ---------- feeds: one poller per NINA, shared by all cards showing it ----------

const STATUS_MS = 5000;
const LOG_MS = 5000;
const GUIDE_MS = 2000;
const PLAN_MS = 5 * 60 * 1000;
const PROGRESS_MS = 60 * 1000;
const MAX_LOGS = 1000;
const MAX_GUIDE_STEPS = 1200;
const feeds = new Map();

class Feed {
  constructor(dev) {
    this.dev = dev;
    this.subs = new Set();
    this.status = null;
    this.error = null;
    this.logs = [];
    this.lastLogId = 0;
    this.issues = [];
    this.history = [];
    this.guide = [];
    this.dithers = [];
    this.lastGuideTime = 0;
    this.guideScale = null;
    this.isGuiding = false;
    this.plan = null;
    this.progress = null;
    this.seqTargets = null;
    this.autofocus = null;
    this.lastImageId = undefined;
    this.lastIssueId = undefined;
    this.startedUtc = null;
  }

  subscribe(sub) {
    this.subs.add(sub);
    if (this.status) sub.update("all");
    if (this.subs.size === 1) {
      this.start();
    } else {
      if (sub.needs.includes("history")) this.fetchHistory();
      if (sub.needs.includes("issues")) this.fetchIssues();
      if (sub.needs.includes("plan")) this.fetchPlan();
      if (sub.needs.includes("progress")) this.fetchProgress();
      if (sub.needs.includes("seqTargets")) this.fetchSeqTargets();
      if (sub.needs.includes("autofocus")) this.fetchAutofocus();
    }
    return () => {
      this.subs.delete(sub);
      if (this.subs.size === 0) this.stop();
    };
  }

  needs(kind) {
    for (const s of this.subs) if (s.needs.includes(kind)) return true;
    return false;
  }

  start() {
    this.lastImageId = undefined;
    this.lastIssueId = undefined;
    this.poll();
    this.pollLogs();
    this.pollGuiding();
    this.fetchPlan();
    this.fetchProgress();
    this.statusTimer = setInterval(() => this.poll(), STATUS_MS);
    this.logTimer = setInterval(() => this.pollLogs(), LOG_MS);
    this.guideTimer = setInterval(() => this.pollGuiding(), GUIDE_MS);
    this.planTimer = setInterval(() => this.fetchPlan(), PLAN_MS);
    this.progressTimer = setInterval(() => this.fetchProgress(), PROGRESS_MS);
    this.fetchSeqTargets();
    this.seqTimer = setInterval(() => this.fetchSeqTargets(), 30000);
    this.fetchAutofocus();
    this.afTimer = setInterval(() => this.fetchAutofocus(), 60000);
  }

  stop() {
    clearInterval(this.statusTimer);
    clearInterval(this.logTimer);
    clearInterval(this.guideTimer);
    clearInterval(this.planTimer);
    clearInterval(this.progressTimer);
    clearInterval(this.seqTimer);
    clearInterval(this.afTimer);
    clearTimeout(this.planRetry);
  }

  emit(kind, payload) {
    for (const s of this.subs) {
      if (kind === "status" || kind === "error" || s.needs.includes(kind)) {
        try {
          s.update(kind, payload);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }

  async poll() {
    try {
      const st = await api(this.dev, "/api/v1/status");
      // Log ids restart with NINA, so drop the incremental cursor.
      if (this.startedUtc && this.startedUtc !== st.info.pluginStartedUtc) {
        this.logs = [];
        this.lastLogId = 0;
        this.emit("logs", null);
      }
      this.startedUtc = st.info.pluginStartedUtc;
      this.status = st;
      this.tz = zoneFor(st.info);
      this.error = null;
      this.updatedAt = Date.now();
      setHealth(this.dev, st);
      this.emit("status");

      const issueId = st.issues.recent?.at(-1)?.id ?? null;
      if (issueId !== this.lastIssueId && this.needs("issues")) {
        this.lastIssueId = issueId;
        this.fetchIssues();
      }
      const imageId = st.lastImage?.id ?? null;
      if (imageId !== this.lastImageId && this.needs("history")) {
        this.lastImageId = imageId;
        this.fetchHistory();
      }
    } catch (e) {
      this.error = e;
      setHealth(this.dev, null, e);
      this.emit("error");
    }
  }

  async pollLogs() {
    if (!this.needs("logs")) return;
    try {
      const res = await api(
        this.dev,
        `/api/v1/logs?limit=300&level=Info&after=${this.lastLogId}`,
      );
      if (!res.entries.length) return;
      this.logs.push(...res.entries);
      if (this.logs.length > MAX_LOGS)
        this.logs.splice(0, this.logs.length - MAX_LOGS);
      this.lastLogId = res.entries.at(-1).id;
      this.emit("logs", res.entries);
    } catch {
      /* surfaced by status poll */
    }
  }

  async pollGuiding() {
    if (!this.needs("guiding")) return;
    try {
      const res = await api(
        this.dev,
        `/api/v1/guiding?after=${this.lastGuideTime}`,
      );
      const changed = res.isGuiding !== this.isGuiding || res.steps.length > 0;
      this.isGuiding = res.isGuiding;
      this.guideScale = res.pixelScale;
      if (res.steps.length) {
        this.guide.push(...res.steps);
        if (this.guide.length > MAX_GUIDE_STEPS)
          this.guide.splice(0, this.guide.length - MAX_GUIDE_STEPS);
        this.lastGuideTime = res.steps.at(-1).time;
      }
      const lastDither = this.dithers.at(-1) ?? 0;
      const newDithers = res.dithers.filter((d) => d > lastDither);
      this.dithers.push(...newDithers);
      if (changed || newDithers.length) this.emit("guiding");
    } catch {
      /* surfaced by status poll */
    }
  }

  async fetchPlan() {
    if (!this.needs("plan")) return;
    try {
      this.plan = await api(this.dev, "/api/v1/scheduler/plan");
      this.emit("plan");
      // The plugin computes the first plan in the background; check back soon.
      clearTimeout(this.planRetry);
      if (this.plan.enabled && !this.plan.updatedUtc)
        this.planRetry = setTimeout(() => this.fetchPlan(), 15000);
    } catch {
      /* surfaced by status poll */
    }
  }

  async refreshPlan() {
    this.plan = await api(
      this.dev,
      "/api/v1/scheduler/plan/refresh",
      95000,
      "POST",
    );
    this.emit("plan");
  }

  async fetchSeqTargets() {
    if (!this.needs("seqTargets")) return;
    try {
      this.seqTargets = await api(this.dev, "/api/v1/sequence/targets", 20000);
      this.emit("seqTargets");
    } catch {
      /* surfaced by status poll */
    }
  }

  async fetchAutofocus() {
    if (!this.needs("autofocus")) return;
    try {
      const af = await api(this.dev, "/api/v1/autofocus");
      if (af.latest?.id === this.autofocus?.latest?.id && this.autofocus)
        return;
      this.autofocus = af;
      this.emit("autofocus");
    } catch {
      /* surfaced by status poll */
    }
  }

  async fetchProgress() {
    if (!this.needs("progress")) return;
    try {
      this.progress = await api(this.dev, "/api/v1/scheduler/progress");
      this.emit("progress");
    } catch {
      /* surfaced by status poll */
    }
  }

  async fetchIssues() {
    try {
      this.issues = await api(this.dev, "/api/v1/issues?limit=100");
      this.emit("issues");
    } catch {
      /* surfaced by status poll */
    }
  }

  async fetchHistory() {
    try {
      this.history = await api(this.dev, "/api/v1/images?limit=300");
      this.emit("history");
    } catch {
      /* surfaced by status poll */
    }
  }
}

function feedFor(dev) {
  let f = feeds.get(dev.id);
  if (!f) {
    f = new Feed(dev);
    feeds.set(dev.id, f);
  }
  return f;
}

// ---------- device health (top bar chips) ----------

const health = new Map();

function healthClass(h) {
  if (!h) return "";
  if (!h.online) return "bad";
  if (h.safety === "unsafe" || h.errors > 0) return "warn";
  return "ok";
}

function setHealth(dev, status, error) {
  const next = status
    ? {
        online: true,
        running: !!status.sequence?.isRunning,
        safety: status.safety?.state,
        target: status.sequence?.activeTarget,
        errors: status.issues?.errors ?? 0,
      }
    : { online: false, error: error?.message };
  if (JSON.stringify(health.get(dev.id)) !== JSON.stringify(next)) {
    health.set(dev.id, next);
    renderChips();
  }
}

function renderChips() {
  $("deviceChips").replaceChildren(
    ...devices.map((d) => {
      const h = health.get(d.id);
      return el(
        "button",
        {
          class: `chip${currentView === `device:${d.id}` ? " active" : ""}`,
          type: "button",
          title: h?.online
            ? `${d.url}${h.target ? ` — ${h.target}` : ""}`
            : `${d.url} — ${h?.error || "offline"}`,
          onclick: () => setView(`device:${d.id}`),
        },
        el("span", { class: `dot ${healthClass(h)}` }),
        h?.online && h.running ? `${d.name} ▶` : d.name,
      );
    }),
  );
}

async function pollIdleDevices() {
  await Promise.all(
    devices
      .filter((d) => !(feeds.get(d.id)?.subs.size > 0))
      .map(async (d) => {
        try {
          setHealth(d, await api(d, "/api/v1/status", 6000));
        } catch (e) {
          setHealth(d, null, e);
        }
      }),
  );
}

// ---------- cards ----------

function setPill(p, text, cls) {
  p.textContent = text;
  p.className = `pill ${cls || ""}`;
}

const DEVICE_VIEWS = {
  camera: [
    "Camera",
    (d) => [
      ["State", d.state],
      [
        "Temp",
        d.setPoint != null
          ? `${fmt.num(d.temperature)} / ${fmt.num(d.setPoint)}°C`
          : fmt.num(d.temperature, 1, "°C"),
      ],
      ["Cooler", d.coolerOn ? fmt.num(d.coolerPower, 0, "%") : "Off"],
      ["Gain / Offset", `${d.gain} / ${d.offset}`],
      ["Binning", `${d.binX}×${d.binY}`],
      ["Battery", d.battery != null ? `${d.battery}%` : null],
    ],
  ],
  mount: [
    "Mount",
    (d) => [
      ["RA / Dec", `${d.ra} ${d.dec}`],
      ["Alt / Az", `${fmt.num(d.altitude)}° / ${fmt.num(d.azimuth)}°`],
      [
        "State",
        d.atPark
          ? "Parked"
          : d.slewing
            ? "Slewing"
            : d.tracking
              ? "Tracking"
              : "Stopped",
      ],
      ["Pier", d.sideOfPier?.replace("pier", "")],
      ["Flip in", d.timeToMeridianFlip],
    ],
  ],
  guider: [
    "Guider",
    (d) => [["RMS", d.rms ? fmt.num(d.rms.totalArcsec, 2, "″") : null]],
  ],
  focuser: [
    "Focuser",
    (d) => [
      ["Position", d.position],
      ["Temp", fmt.num(d.temperature, 1, "°C")],
      ["State", d.isMoving ? "Moving" : d.isSettling ? "Settling" : "Idle"],
    ],
  ],
  filterWheel: [
    "Filter wheel",
    (d) => [["Filter", d.isMoving ? "Moving…" : d.filter]],
  ],
  rotator: [
    "Rotator",
    (d) => [
      ["Sky angle", fmt.num(d.position, 1, "°")],
      ["Mechanical", fmt.num(d.mechanicalPosition, 1, "°")],
    ],
  ],
  dome: [
    "Dome",
    (d) => [
      ["Shutter", d.shutter?.replace("Shutter", "")],
      ["Azimuth", fmt.num(d.azimuth, 1, "°")],
      [
        "State",
        d.atPark
          ? "Parked"
          : d.slewing
            ? "Slewing"
            : d.following
              ? "Following"
              : "Idle",
      ],
    ],
  ],
  flatDevice: [
    "Flat panel",
    (d) => [
      ["Cover", d.coverState],
      ["Light", d.lightOn ? `On (${d.brightness})` : "Off"],
    ],
  ],
  weather: ["Weather", () => []],
  safetyMonitor: ["Safety", (d) => [["Status", d.isSafe ? "Safe" : "Unsafe"]]],
  switch: ["Switches", () => [], (d) => renderSwitches(d.switches || [])],
};

// Drivers often name ports "Description: Label"; the part after the colon is the user's label.
const switchLabel = (s) => {
  const name = s.name || `Switch ${s.id}`;
  const i = name.lastIndexOf(": ");
  return i > 0 && i < name.length - 2 ? name.slice(i + 2) : name;
};

const isToggle = (s) =>
  s.writable &&
  s.minimum === 0 &&
  s.maximum === 1 &&
  (s.step == null || s.step === 1);

const switchValue = (v) =>
  v == null
    ? "—"
    : Number.isInteger(v)
      ? String(v)
      : String(Number(v.toFixed(2)));

function renderSwitches(switches) {
  const row = (s) => {
    const tip = [
      s.name,
      s.description,
      s.writable && !isToggle(s) && s.maximum != null
        ? `range ${switchValue(s.minimum)}–${switchValue(s.maximum)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    const value = isToggle(s)
      ? el("span", {
          class: `pill ${s.value >= 1 ? "ok" : ""}`,
          text: s.value >= 1 ? "On" : "Off",
        })
      : el("span", { class: "swt-num", text: switchValue(s.value) });
    return el(
      "div",
      { class: "swt-row", title: tip },
      el("span", { class: "swt-label", text: switchLabel(s) }),
      value,
    );
  };
  const outputs = switches.filter((s) => s.writable);
  const sensors = switches.filter((s) => !s.writable);
  if (!switches.length)
    return el("div", { class: "muted small", text: "No switches reported." });
  return el(
    "div",
    null,
    outputs.length
      ? el("div", { class: "swt-grid" }, ...outputs.map(row))
      : null,
    sensors.length ? el("div", { class: "swt-head", text: "Sensors" }) : null,
    sensors.length
      ? el("div", { class: "swt-grid" }, ...sensors.map(row))
      : null,
  );
}

function withZone(feed, fn) {
  const prev = currentTz;
  currentTz = feed.tz ?? null;
  try {
    return fn();
  } finally {
    currentTz = prev;
  }
}

function logItem(e) {
  return el(
    "li",
    null,
    el("span", { class: "t", text: fmt.time(e.timestamp) }),
    el("span", { class: `lv ${e.level}`, text: e.level.toUpperCase() }),
    el("span", { class: "src", text: `${e.source} ` }),
    e.message,
  );
}

const LEVEL_RANK = {
  Trace: 0,
  Debug: 1,
  Info: 2,
  Warning: 3,
  Error: 4,
  Fatal: 5,
};

/**
 * Card types. mount(body, feed, onDispose) builds the card's DOM and returns update(kind, payload),
 * called with 'all' | 'status' | 'error' | 'logs' | 'issues' | 'history'.
 */
const CARDS = {
  session: {
    title: "Session",
    span: 2,
    needs: [],
    mount(body, feed) {
      const pills = el("div", { class: "pills" });
      const [seq, safety, issues] = [el("span"), el("span"), el("span")];
      pills.append(seq, safety, issues);
      const dl = el("dl", { class: "kv" });
      const running = el("div", { class: "running" });
      body.append(pills, dl, running);
      return () => {
        const {
          info,
          sequence,
          safety: s,
          devices: eq,
          issues: iss,
        } = feed.status;
        setPill(
          seq,
          sequence.isRunning ? "Sequence running" : "Sequence idle",
          sequence.isRunning ? "ok" : "",
        );
        setPill(
          safety,
          s.state === "unknown" ? "Safety: n/a" : s.isSafe ? "Safe" : "UNSAFE",
          s.state === "unknown" ? "" : s.isSafe ? "ok" : "bad",
        );
        setPill(
          issues,
          `${iss.errors} errors · ${iss.warnings} warnings`,
          iss.errors > 0 ? "bad" : iss.warnings > 0 ? "warn" : "ok",
        );
        const cam = eq.camera;
        const exposing =
          cam?.connected && cam.isExposing && cam.exposureEndUtc
            ? `Exposing — ${Math.max(0, Math.round((new Date(cam.exposureEndUtc) - Date.now()) / 1000))}s left`
            : null;
        const ts = feed.status.scheduler;
        const tsTarget =
          ts?.enabled && ts.state === "imaging" && ts.target
            ? `${ts.target}${ts.project ? ` (TS: ${ts.project})` : ""}`
            : null;
        kv(dl, [
          ["Machine", info.machineName],
          ["Profile", info.profile],
          ["NINA", info.ninaVersion],
          ["Target", tsTarget || sequence.activeTarget],
          [
            "Scheduler",
            ts?.enabled && ts.state === "waiting"
              ? `Waiting for ${ts.target ?? "next target"} (${fmt.until(ts.waitUntilUtc) ?? "?"})`
              : null,
          ],
          ["Camera", exposing || cam?.state],
          [
            "Mount",
            eq.mount?.connected ? `${eq.mount.ra}  ${eq.mount.dec}` : null,
          ],
          [
            "Meridian flip",
            eq.mount?.connected ? eq.mount.timeToMeridianFlip : null,
          ],
          [
            "Observatory time",
            `${fmt.hm(Date.now(), feed.tz ?? null)} ${offsetLabel(info)}${info.timeZone ? ` (${info.timeZone})` : ""}`,
          ],
          ["Updated", fmt.time(feed.updatedAt)],
        ]);
        running.replaceChildren(
          ...(sequence.runningItems || []).map((i) =>
            el("span", { title: i.category || "" }, i.name),
          ),
        );
      };
    },
  },

  schedulerNow: {
    title: "Scheduler: now",
    span: 2,
    needs: [],
    tabs: ["overview", "ts"],
    available: (feed) => tsAvailable(feed),
    mount(body, feed) {
      const pill = el("span");
      const headline = el("div", { class: "ts-headline" });
      const sub = el("div", { class: "muted" });
      const dl = el("dl", { class: "kv" });
      const foot = el("div", { class: "muted small ts-foot" });
      body.append(el("div", { class: "pills" }, pill), headline, sub, dl, foot);
      return () => {
        const ts = feed.status.scheduler;
        if (!ts || !ts.enabled) {
          setPill(pill, "Disabled", "");
          headline.textContent = "";
          sub.textContent = ts
            ? "Target Scheduler integration is turned off in the plugin options."
            : "This NINA's plugin version has no Target Scheduler support.";
          kv(dl, []);
          foot.textContent = "";
          return;
        }
        const coords = ts.ra ? `${ts.ra}  ${ts.dec}` : null;
        const last = ts.lastCompleted
          ? [
              "Last completed",
              `${ts.lastCompleted.target} at ${fmt.hm(ts.lastCompleted.atUtc)}`,
            ]
          : [];
        switch (ts.state) {
          case "imaging":
            setPill(pill, "Imaging", "ok");
            headline.textContent = ts.target ?? "";
            sub.textContent = ts.project ? `Project: ${ts.project}` : "";
            kv(dl, [
              [
                "Exposure",
                [ts.filter, fmt.num(ts.exposureSeconds, 0, "s"), ts.binning]
                  .filter(Boolean)
                  .join(" · "),
              ],
              [
                "Gain / Offset",
                ts.gain || ts.offset
                  ? `${ts.gain ?? "–"} / ${ts.offset ?? "–"}`
                  : null,
              ],
              ["Coordinates", coords],
              ["Rotation", fmt.num(ts.rotation, 1, "°")],
              [
                "Started",
                ts.sinceUtc
                  ? `${fmt.hm(ts.sinceUtc)} (${fmt.ago(ts.sinceUtc)})`
                  : null,
              ],
              [
                "Target sets",
                ts.targetEndsUtc
                  ? `${fmt.hm(ts.targetEndsUtc)} (${fmt.until(ts.targetEndsUtc)})`
                  : null,
              ],
              last,
            ]);
            break;
          case "waiting":
            setPill(pill, "Waiting", "warn");
            headline.textContent = ts.target ? `Next: ${ts.target}` : "Waiting";
            sub.textContent = ts.project ? `Project: ${ts.project}` : "";
            kv(dl, [
              [
                "Starts",
                ts.waitUntilUtc
                  ? `${fmt.hm(ts.waitUntilUtc)} (${fmt.until(ts.waitUntilUtc)})`
                  : null,
              ],
              ["Coordinates", coords],
              ["Waiting since", fmt.hm(ts.sinceUtc)],
              last,
            ]);
            break;
          case "stopped":
            setPill(pill, "Stopped", "");
            headline.textContent = "Scheduler stopped";
            sub.textContent = ts.target ? `Last target: ${ts.target}` : "";
            kv(dl, [
              [
                "Stopped at",
                ts.stoppedAtUtc
                  ? `${fmt.hm(ts.stoppedAtUtc)} (${fmt.ago(ts.stoppedAtUtc)})`
                  : null,
              ],
              last,
            ]);
            break;
          default:
            setPill(pill, "No activity", "");
            headline.textContent = "";
            sub.textContent =
              "No Target Scheduler activity since NINA started.";
            kv(dl, [last]);
        }
        foot.textContent = ts.apiReachable
          ? `Target Scheduler ${ts.version}`
          : `Target Scheduler API not reachable${ts.apiError ? ` (${ts.apiError})` : ""}. Check "Enable API" in Target Scheduler and the port in the plugin options.`;
      };
    },
  },

  schedulerPlan: {
    title: "Tonight's plan",
    span: 4,
    needs: ["plan"],
    tabs: ["ts"],
    mount(body, feed) {
      const btn = el("button", { type: "button" }, "Refresh now");
      const info = el("span", { class: "muted small" });
      const err = el("span", { class: "error small" });
      const timeline = el("div", { class: "ts-timeline" });
      const table = el("div", { class: "tablewrap" });
      body.append(
        el("div", { class: "toolbar" }, btn, info, err),
        timeline,
        table,
      );

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Refreshing…";
        err.textContent = "";
        try {
          await feed.refreshPlan();
        } catch (e) {
          err.textContent = `Refresh failed: ${e.message}`;
        } finally {
          btn.disabled = false;
          btn.textContent = "Refresh now";
        }
      });

      const exposures = (it) =>
        it.exposures
          .map(
            (x) =>
              `${x.count}× ${x.filter}${x.exposureSeconds ? ` ${fmt.num(x.exposureSeconds, 0)}s` : ""}`,
          )
          .join(", ");

      const render = () => {
        const p = feed.plan;
        if (!p) {
          info.textContent = "Loading…";
          return;
        }
        if (!p.enabled) {
          info.textContent = "";
          timeline.replaceChildren(
            el("div", {
              class: "muted",
              text: "Target Scheduler integration is turned off in the plugin options.",
            }),
          );
          table.replaceChildren();
          btn.disabled = true;
          return;
        }
        info.textContent = p.updatedUtc
          ? `Updated ${fmt.hm(p.updatedUtc)} · next automatic refresh ${fmt.hm(p.nextAutoRefreshUtc)}${timeMode === "observatory" && feed.status ? ` · times in observatory time (${offsetLabel(feed.status.info)})` : ""}`
          : "Computing tonight's plan…";
        if (!p.apiReachable)
          err.textContent = `Target Scheduler API not reachable${p.apiError ? ` (${p.apiError})` : ""}`;
        else if (!btn.disabled) err.textContent = "";

        const items = p.items || [];
        if (!items.length) {
          timeline.replaceChildren(
            el("div", {
              class: "muted",
              text: p.updatedUtc
                ? "Nothing scheduled: no active targets are available tonight."
                : "",
            }),
          );
          table.replaceChildren();
          return;
        }

        const start = new Date(items[0].startUtc).getTime();
        const end = new Date(items.at(-1).endUtc).getTime();
        const span = Math.max(1, end - start);
        const pct = (iso) => ((new Date(iso).getTime() - start) / span) * 100;

        const bars = items.map((it, i) => {
          const label = it.waitPeriod ? "Wait" : it.name;
          const bar = el(
            "div",
            {
              class: `ts-bar ${it.waitPeriod ? "wait" : `c${i % 4}`}`,
              title: `${label}${it.project ? ` (${it.project})` : ""}\n${fmt.hm(it.startUtc)} – ${fmt.hm(it.endUtc)}${it.waitPeriod ? "" : `\n${exposures(it)}`}`,
            },
            it.waitPeriod ? "" : it.name,
          );
          bar.style.left = `${pct(it.startUtc)}%`;
          bar.style.width = `${Math.max(0.4, pct(it.endUtc) - pct(it.startUtc))}%`;
          return bar;
        });
        const nowPct = ((Date.now() - start) / span) * 100;
        let marker = null;
        if (nowPct >= 0 && nowPct <= 100) {
          marker = el("div", { class: "ts-now", title: "Now" });
          marker.style.left = `${nowPct}%`;
        }
        timeline.replaceChildren(
          el("div", { class: "ts-track" }, ...bars, marker),
          el(
            "div",
            { class: "ts-axis" },
            el("span", { text: fmt.hm(items[0].startUtc) }),
            el("span", { text: fmt.hm(items.at(-1).endUtc) }),
          ),
        );

        table.replaceChildren(
          el(
            "table",
            null,
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                ...[
                  "Time",
                  "Target",
                  "Project",
                  "Planned exposures",
                  "Duration",
                ].map((h) => el("th", { text: h })),
              ),
            ),
            el(
              "tbody",
              null,
              ...items.map((it) =>
                el(
                  "tr",
                  { class: it.waitPeriod ? "muted" : null },
                  el("td", {
                    text: `${fmt.hm(it.startUtc)} – ${fmt.hm(it.endUtc)}`,
                  }),
                  el("td", { text: it.waitPeriod ? "Wait" : it.name }),
                  el("td", { text: it.project ?? "" }),
                  el("td", { class: "wrap", text: exposures(it) }),
                  el("td", {
                    text: fmt.duration(
                      (new Date(it.endUtc) - new Date(it.startUtc)) / 1000,
                    ),
                  }),
                ),
              ),
            ),
          ),
        );
      };
      // Status ticks keep the "now" marker moving between plan refreshes.
      return (kind) => {
        if (kind === "plan" || kind === "all" || kind === "status") render();
      };
    },
  },

  schedulerProgress: {
    title: "Project progress",
    span: 4,
    needs: ["progress"],
    tabs: ["ts"],
    mount(body, feed) {
      const prefKey = "nina-remote-telemetry.progressFilters";
      const prefs = readJson(prefKey, {
        done: false,
        inactive: false,
        sort: "priority",
      });
      const showDone = el("input", { type: "checkbox", checked: prefs.done });
      const showAll = el("input", {
        type: "checkbox",
        checked: prefs.inactive,
      });
      const sortBy = el(
        "select",
        { "aria-label": "Sort projects" },
        ...[
          ["priority", "Priority"],
          ["progress", "% complete"],
          ["left", "Time left"],
          ["name", "Name"],
        ].map(([v, t]) => el("option", { value: v, text: `Sort: ${t}` })),
      );
      sortBy.value = prefs.sort || "priority";
      const info = el("span", { class: "muted small" });
      const err = el("span", { class: "error small" });
      const summaryLine = el("div", { class: "small ts-summary" });
      const container = el("div", { class: "ts-projects" });
      body.append(
        el(
          "div",
          { class: "toolbar" },
          el("label", { class: "small" }, showDone, " show completed"),
          el("label", { class: "small" }, showAll, " show inactive"),
          sortBy,
          info,
          err,
        ),
        summaryLine,
        container,
      );
      const expanded = new Set();
      const statsCache = new Map();
      let runningKey = null;
      let autoExpandedKey = null;

      const PRIORITY = ["Low priority", "Normal priority", "High priority"];
      const priorityLabel = (p) => PRIORITY[p] ?? `priority ${p}`;

      const bar = (pct) => {
        const fill = el("div", {
          class: `bar-fill${pct >= 100 ? " done" : ""}`,
        });
        fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        return el("div", { class: "bar compact" }, fill);
      };

      const meanSd = (m, sd, d) =>
        m == null
          ? "—"
          : `${m.toFixed(d)}${sd != null ? ` ± ${sd.toFixed(d)}` : ""}`;

      const isDone = (t) =>
        t.percentComplete == null || t.percentComplete >= 100;

      // Same filter + exposure + plan collapses to one row; same filter + exposure from different plans gets the plan name.
      const mergeFilters = (filters) => {
        const rows = new Map();
        for (const f of filters) {
          const key = `${f.filter}|${f.exposureSeconds}|${f.template}`;
          const row = rows.get(key);
          if (!row) {
            rows.set(key, { ...f });
            continue;
          }
          for (const k of [
            "desired",
            "acquired",
            "accepted",
            "ungraded",
            "remaining",
            "remainingSeconds",
          ])
            row[k] = (row[k] || 0) + (f[k] || 0);
        }
        const list = [...rows.values()];
        const seen = new Map();
        for (const r of list) {
          const k = `${r.filter}|${r.exposureSeconds}`;
          seen.set(k, (seen.get(k) || 0) + 1);
        }
        for (const r of list) {
          const dup = seen.get(`${r.filter}|${r.exposureSeconds}`) > 1;
          r.label =
            dup && r.template && r.template !== r.filter
              ? `${r.filter} · ${r.template}`
              : (r.filter ?? r.template ?? "");
        }
        return list;
      };

      const filterTable = (rows, stats, loading) => {
        const statFor = (r) =>
          stats?.find(
            (s) =>
              s.filter === r.filter && s.exposureSeconds === r.exposureSeconds,
          );
        const q = (m, sd) => (loading ? "…" : meanSd(m, sd, 2));
        return el(
          "table",
          { class: "ts-filters" },
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ...[
                ["Filter"],
                ["Exp", "num"],
                ["Progress"],
                ["Accepted", "num"],
                ["Acquired", "num"],
                ["Remaining", "num"],
                ["HFR", "num"],
                ["FWHM", "num"],
                ["Ecc.", "num"],
              ].map(([h, c]) => el("th", { class: c, text: h })),
            ),
          ),
          el(
            "tbody",
            null,
            ...rows.map((r) => {
              const s = statFor(r);
              return el(
                "tr",
                { class: r.remaining > 0 ? null : "muted" },
                el("td", { text: r.label }),
                el("td", {
                  class: "num",
                  text: fmt.num(r.exposureSeconds, 0, "s") ?? "",
                }),
                el(
                  "td",
                  { class: "bar-cell" },
                  bar(r.desired ? (100 * r.accepted) / r.desired : 100),
                ),
                el("td", {
                  class: "num",
                  text: `${r.accepted} / ${r.desired}`,
                }),
                el("td", {
                  class: "num",
                  text: `${r.acquired}${r.ungraded ? ` (${r.ungraded} ungraded)` : ""}`,
                }),
                el("td", {
                  class: "num",
                  text:
                    r.remaining > 0
                      ? `${r.remaining}×${r.remainingSeconds ? ` · ${fmt.duration(r.remainingSeconds)}` : ""}`
                      : "✓",
                }),
                el("td", { class: "num", text: q(s?.hfrMean, s?.hfrStDev) }),
                el("td", { class: "num", text: q(s?.fwhmMean, s?.fwhmStDev) }),
                el("td", {
                  class: "num",
                  text: q(s?.eccentricityMean, s?.eccentricityStDev),
                }),
              );
            }),
          ),
        );
      };

      const loadStats = async (targetId) => {
        try {
          statsCache.set(
            targetId,
            await api(
              feed.dev,
              `/api/v1/scheduler/targets/${encodeURIComponent(targetId)}/statistics`,
              30000,
            ),
          );
        } catch {
          statsCache.set(targetId, []);
        }
      };

      // pr is passed when a single-target project is shown as one row.
      const targetBlock = (t, pr) => {
        const merged = mergeFilters(t.filters);
        const remaining = merged.filter((f) => f.remaining > 0);
        const rows = showDone.checked ? merged : remaining;
        const summary = remaining.length
          ? `${remaining.map((f) => `${f.label} ${f.remaining}×`).join(" · ")} · ${fmt.long(t.remainingSeconds)} left`
          : merged.length
            ? "complete ✓"
            : "no exposure plans";

        const open = expanded.has(t.id);
        const details = el("div", { class: "ts-details", hidden: !open });
        const fill = () => {
          const cached = statsCache.get(t.id);
          details.replaceChildren(
            rows.length
              ? filterTable(rows, cached, !cached)
              : el("div", { class: "muted small", text: "No exposure plans." }),
          );
          if (!cached)
            loadStats(t.id).then(() => {
              if (expanded.has(t.id)) withZone(feed, fill);
            });
        };
        if (open) fill();
        const toggle = el(
          "button",
          { type: "button", class: "small-btn" },
          open ? "Hide" : "Details",
        );
        toggle.addEventListener("click", () => {
          const nowOpen = !expanded.has(t.id);
          if (nowOpen) expanded.add(t.id);
          else expanded.delete(t.id);
          details.hidden = !nowOpen;
          toggle.textContent = nowOpen ? "Hide" : "Details";
          if (nowOpen) fill();
        });

        const name =
          pr && pr.name !== t.name ? `${pr.name} · ${t.name}` : t.name;
        const running = runningKey === `${pr?.name ?? t.projectName}|${t.name}`;
        return el(
          "div",
          {
            class: `ts-target${t.active ? "" : " off"}${running ? " now" : ""}`,
          },
          el(
            "div",
            { class: "ts-target-head" },
            el("strong", { text: name, title: name }),
            running ? el("span", { class: "pill ok", text: "Imaging" }) : null,
            pr && pr.state !== "Active"
              ? el("span", { class: "pill", text: pr.state })
              : null,
            pr
              ? el("span", {
                  class: "muted small",
                  text: priorityLabel(pr.priority),
                })
              : null,
            bar(t.percentComplete ?? 0),
            el("span", {
              class: "small ts-pct",
              text:
                t.percentComplete == null
                  ? "—"
                  : `${fmt.num(t.percentComplete, 0)}%`,
            }),
            el("span", {
              class: "small ts-remaining",
              text: summary,
              title: summary,
            }),
            toggle,
          ),
          details,
        );
      };

      const comparator = () => {
        const pct = (x) => x.percentComplete ?? -1;
        switch (sortBy.value) {
          case "progress":
            return (a, b) => pct(b) - pct(a) || a.name.localeCompare(b.name);
          case "left":
            return (a, b) =>
              (a.remainingSeconds || 0) - (b.remainingSeconds || 0) ||
              a.name.localeCompare(b.name);
          case "name":
            return (a, b) => a.name.localeCompare(b.name);
          default:
            return (a, b) =>
              (b.priority ?? 0) - (a.priority ?? 0) ||
              pct(b) - pct(a) ||
              a.name.localeCompare(b.name);
        }
      };

      const render = () => {
        const p = feed.progress;
        if (!p) {
          info.textContent = "Loading…";
          return;
        }
        if (!p.enabled) {
          info.textContent = "";
          container.replaceChildren(
            el("div", {
              class: "muted",
              text: "Target Scheduler integration is turned off in the plugin options.",
            }),
          );
          return;
        }
        info.textContent = p.updatedUtc
          ? `Updated ${fmt.hm(p.updatedUtc)}`
          : "Loading projects…";
        err.textContent = p.apiReachable
          ? ""
          : `Target Scheduler API not reachable${p.apiError ? ` (${p.apiError})` : ""}`;

        // Open the target that is imaging right now, once per target change.
        if (runningKey && runningKey !== autoExpandedKey) {
          for (const pr of p.projects || [])
            for (const t of pr.targets)
              if (`${pr.name}|${t.name}` === runningKey) expanded.add(t.id);
          autoExpandedKey = runningKey;
        }

        const sort = comparator();
        const projects = (p.projects || [])
          .filter((pr) => showAll.checked || pr.state === "Active")
          .map((pr) => ({
            ...pr,
            visible: pr.targets
              .filter(
                (t) =>
                  `${pr.name}|${t.name}` === runningKey ||
                  ((showAll.checked || t.active) &&
                    (showDone.checked || !isDone(t))),
              )
              .sort(sort),
          }))
          .filter(
            (pr) => pr.visible.length || (showDone.checked && showAll.checked),
          )
          .sort(sort);

        const active = (p.projects || []).filter((pr) => pr.state === "Active");
        const openTargets = active.flatMap((pr) =>
          pr.targets.filter((t) => t.active && !isDone(t)),
        );
        const doneTargets = active.flatMap((pr) =>
          pr.targets.filter((t) => t.active && t.percentComplete >= 100),
        );
        const left = openTargets.reduce(
          (s, t) => s + (t.remainingSeconds || 0),
          0,
        );
        summaryLine.textContent = `${openTargets.length} target${openTargets.length === 1 ? "" : "s"} in progress · ${fmt.long(left) || "0m"} of exposures left · ${doneTargets.length} complete`;

        if (!projects.length) {
          container.replaceChildren(
            el("div", {
              class: "muted",
              text: p.updatedUtc
                ? "Nothing left to image in active projects. Tick “show completed” to see finished work."
                : "",
            }),
          );
          return;
        }
        container.replaceChildren(
          ...projects.map((pr) => {
            const hasRunning = pr.visible.some(
              (t) => `${pr.name}|${t.name}` === runningKey,
            );
            // A project with a single target reads better as one row.
            if (pr.targets.length === 1 && pr.visible.length === 1)
              return el(
                "section",
                { class: `ts-project single${hasRunning ? " now" : ""}` },
                targetBlock({ ...pr.visible[0], projectName: pr.name }, pr),
              );
            return el(
              "section",
              { class: `ts-project${hasRunning ? " now" : ""}` },
              el(
                "header",
                null,
                el("strong", { text: pr.name }),
                pr.state !== "Active"
                  ? el("span", { class: "pill", text: pr.state })
                  : null,
                el("span", {
                  class: "muted small",
                  text: priorityLabel(pr.priority),
                }),
                bar(pr.percentComplete ?? 0),
                el("span", {
                  class: "small",
                  text:
                    pr.percentComplete == null
                      ? "no exposures planned"
                      : `${fmt.num(pr.percentComplete, 0)}% · ${pr.remainingSeconds > 0 ? `${fmt.long(pr.remainingSeconds)} left` : "complete"}`,
                }),
              ),
              ...(pr.visible.length
                ? pr.visible.map((t) =>
                    targetBlock({ ...t, projectName: pr.name }),
                  )
                : [
                    el("div", {
                      class: "muted small",
                      text: "No targets to show.",
                    }),
                  ]),
            );
          }),
        );
      };

      for (const ctl of [showDone, showAll, sortBy]) {
        ctl.addEventListener("change", () => {
          localStorage.setItem(
            prefKey,
            JSON.stringify({
              done: showDone.checked,
              inactive: showAll.checked,
              sort: sortBy.value,
            }),
          );
          withZone(feed, render);
        });
      }
      return (kind) => {
        if (kind === "status") {
          const ts = feed.status.scheduler;
          const key =
            ts?.enabled && ts.state === "imaging" && ts.target
              ? `${ts.project}|${ts.target}`
              : null;
          if (key === runningKey) return;
          runningKey = key;
          render();
          return;
        }
        if (kind === "progress" || kind === "all") render();
      };
    },
  },

  sequenceTargets: {
    title: "Sequence targets",
    span: 4,
    needs: ["seqTargets"],
    // Hidden in Full view when the sequence has no Deep Sky Object containers.
    available: (feed) =>
      !feed.seqTargets || feed.seqTargets.targets?.length > 0,
    mount(body, feed) {
      const prefKey = "nina-remote-telemetry.sequenceFilters";
      const showDone = el("input", {
        type: "checkbox",
        checked: readJson(prefKey, { done: false }).done,
      });
      const info = el("span", { class: "muted small" });
      const err = el("span", { class: "error small" });
      const summary = el("div", { class: "small ts-summary" });
      const list = el("div", { class: "ts-projects" });
      body.append(
        el(
          "div",
          { class: "toolbar" },
          el("label", { class: "small" }, showDone, " show finished"),
          info,
          err,
        ),
        summary,
        list,
      );
      const expanded = new Set();
      const ICONS = {
        RUNNING: "▶",
        FINISHED: "✓",
        FAILED: "✕",
        SKIPPED: "⤼",
        DISABLED: "⊘",
      };
      const finished = (s) => ["FINISHED", "SKIPPED", "DISABLED"].includes(s);

      const bar = (pct) => {
        const fill = el("div", {
          class: `bar-fill${pct >= 100 ? " done" : ""}`,
        });
        fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        return el("div", { class: "bar compact" }, fill);
      };

      const blocksTable = (blocks) =>
        el(
          "table",
          { class: "ts-filters" },
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ...[
                "Instruction",
                "Filter",
                "Exp",
                "Progress",
                "Done",
                "Imaged",
                "Remaining",
              ].map((h) => el("th", { text: h })),
            ),
          ),
          el(
            "tbody",
            null,
            ...blocks.map((b) =>
              el(
                "tr",
                { class: b.status === "FINISHED" ? "muted" : null },
                el("td", { text: `${ICONS[b.status] ?? "•"} ${b.name}` }),
                el("td", { text: b.filter ?? "(current)" }),
                el("td", { text: fmt.num(b.exposureSeconds, 0, "s") ?? "" }),
                el(
                  "td",
                  { class: "bar-cell" },
                  b.total
                    ? bar((100 * b.done) / b.total)
                    : el("span", {
                        class: "muted small",
                        text: b.condition ?? "open-ended",
                      }),
                ),
                el("td", {
                  text: b.total ? `${b.done} / ${b.total}` : String(b.done),
                }),
                el("td", { text: fmt.duration(b.imagedSeconds) ?? "" }),
                el("td", {
                  text:
                    b.remainingSeconds == null
                      ? "—"
                      : b.remainingSeconds > 0
                        ? fmt.duration(b.remainingSeconds)
                        : "✓",
                }),
              ),
            ),
          ),
        );

      const schedulerRow = (t) => {
        const ts = feed.status?.scheduler;
        const running = t.status === "RUNNING";
        let text = "Targets are picked by Target Scheduler at run time.";
        if (running && ts?.enabled && ts.state === "imaging" && ts.target) {
          text = `Imaging ${ts.target}${ts.project ? ` (${ts.project})` : ""}`;
        } else if (running && ts?.enabled && ts.state === "waiting") {
          text = ts.waitUntilUtc
            ? `Waiting${ts.target ? ` for ${ts.target}` : ""} until ${fmt.hm(ts.waitUntilUtc)}`
            : "Waiting for the next target";
        }
        const hint = tsAvailable(feed)
          ? "Plan and progress are on the Target Scheduler tab."
          : null;
        return el(
          "div",
          {
            class: `ts-target${running ? " now" : ""}${finished(t.status) ? " off" : ""}`,
          },
          el(
            "div",
            { class: "ts-target-head" },
            el("span", {
              class: "seq-icon",
              text: ICONS[t.status] ?? "•",
              title: t.status,
            }),
            el("strong", { text: t.name || "Target Scheduler" }),
            el("span", { class: "pill", text: "Target Scheduler" }),
            el("span", { class: "small ts-remaining", text, title: text }),
          ),
          hint ? el("div", { class: "muted small", text: hint }) : null,
        );
      };

      const targetRow = (t, i) => {
        if (t.scheduler) return schedulerRow(t);
        const key = `${i}:${t.name}`;
        const open = expanded.has(key);
        const total = (t.imagedSeconds || 0) + (t.remainingSeconds || 0);
        const pct = finished(t.status)
          ? 100
          : total > 0
            ? (100 * t.imagedSeconds) / total
            : 0;
        const text = t.error
          ? t.error
          : [
              `${fmt.duration(t.imagedSeconds) || "0m"} imaged`,
              t.remainingSeconds > 0
                ? `${fmt.duration(t.remainingSeconds)} left`
                : null,
              t.openEnded ? "plus open-ended blocks" : null,
            ]
              .filter(Boolean)
              .join(" · ");
        const captured = t.captured?.length
          ? `Captured so far: ${t.captured.map((c) => `${c.filter || "?"} ${c.count}× ${fmt.num(c.exposureSeconds, 0)}s`).join(", ")}`
          : null;
        const details = el(
          "div",
          { class: "ts-details", hidden: !open },
          t.blocks?.length
            ? blocksTable(t.blocks)
            : el("div", {
                class: "muted small",
                text: "No exposure instructions in this target.",
              }),
          t.conditions
            ? el("div", { class: "muted small", text: `Loop: ${t.conditions}` })
            : null,
          captured ? el("div", { class: "muted small", text: captured }) : null,
        );
        const toggle = el(
          "button",
          { type: "button", class: "small-btn" },
          open ? "Hide" : "Details",
        );
        toggle.addEventListener("click", () => {
          const nowOpen = !expanded.has(key);
          if (nowOpen) expanded.add(key);
          else expanded.delete(key);
          details.hidden = !nowOpen;
          toggle.textContent = nowOpen ? "Hide" : "Details";
        });
        return el(
          "div",
          {
            class: `ts-target${t.status === "RUNNING" ? " now" : ""}${finished(t.status) ? " off" : ""}`,
          },
          el(
            "div",
            { class: "ts-target-head" },
            el("span", {
              class: "seq-icon",
              text: ICONS[t.status] ?? "•",
              title: t.status,
            }),
            el("strong", {
              text: t.name,
              title: t.ra ? `${t.ra}  ${t.dec}` : t.name,
            }),
            bar(pct),
            el("span", { class: "small ts-pct", text: `${fmt.num(pct, 0)}%` }),
            el("span", { class: "small ts-remaining", text, title: text }),
            toggle,
          ),
          details,
        );
      };

      const render = () => {
        const s = feed.seqTargets;
        if (!s) {
          info.textContent = "Loading…";
          return;
        }
        info.textContent = `Updated ${fmt.hm(s.updatedUtc)} · refreshes every 30 s`;
        err.textContent = s.error ?? "";
        const targets = s.targets || [];
        if (!targets.length) {
          summary.textContent = "";
          list.replaceChildren(
            el("div", {
              class: "muted",
              text: "No Deep Sky Object targets in the Advanced Sequence.",
            }),
          );
          return;
        }
        const fixed = targets.filter((t) => !t.scheduler);
        const pending = fixed.filter((t) => !finished(t.status)).length;
        const state = s.isRunning ? "Sequence running" : "Sequence idle";
        summary.textContent = fixed.length
          ? `${state} · ${fixed.length} targets (${pending} to go) · ${fmt.duration(s.imagedSeconds) || "0m"} imaged · ~${fmt.duration(s.remainingSeconds) || "0m"} left${s.openEnded ? " + open-ended blocks" : ""}${fixed.length < targets.length ? " · plus Target Scheduler" : ""}`
          : `${state} · targets chosen by Target Scheduler`;
        const shown = targets
          .map((t, i) => [t, i])
          .filter(([t]) => showDone.checked || !finished(t.status));
        list.replaceChildren(
          ...(shown.length
            ? shown.map(([t, i]) => targetRow(t, i))
            : [
                el("div", {
                  class: "muted small",
                  text: "All targets finished. Tick “show finished” to see them.",
                }),
              ]),
        );
      };
      showDone.addEventListener("change", () => {
        localStorage.setItem(
          prefKey,
          JSON.stringify({ done: showDone.checked }),
        );
        withZone(feed, render);
      });
      return (kind) => {
        if (kind === "seqTargets" || kind === "all") render();
        else if (
          kind === "status" &&
          feed.seqTargets?.targets?.some((t) => t.scheduler)
        )
          render();
      };
    },
  },

  allsky: {
    title: "All-sky",
    span: 2,
    tall: true,
    needs: [],
    mount(body, feed, onDispose) {
      const storeKey = `nina-remote-telemetry.allsky.${feed.dev.id}`;
      const interval = el(
        "select",
        { "aria-label": "Update interval" },
        ...[1, 5, 10, 15, 30, 60].map((m) =>
          el("option", {
            value: String(m),
            text: m === 60 ? "every 1 h" : `every ${m} min`,
          }),
        ),
      );
      interval.value = localStorage.getItem(storeKey) || "30";
      const btn = el("button", { type: "button" }, "Refresh");
      const info = el("span", { class: "muted small" });
      const err = el("div", { class: "error small" });
      const img = el("img", { alt: "All-sky camera image", hidden: true });
      const empty = el("div", { class: "muted", text: "Loading…" });
      img.addEventListener("click", () => img.classList.toggle("zoom"));
      img.addEventListener("load", () => {
        img.hidden = false;
        empty.hidden = true;
      });
      img.addEventListener("error", () => {
        empty.hidden = false;
        empty.textContent = "Image failed to load.";
      });
      body.append(
        el("div", { class: "toolbar" }, interval, btn, info),
        el("div", { class: "preview" }, img, empty),
        err,
      );

      let timer = null;
      let nextAt = null;
      let shownId = null;
      let last = null;

      const renderInfo = () => {
        if (!last?.configured) {
          info.textContent = "";
          return;
        }
        info.textContent = [
          last.imageTimeUtc
            ? `Image from ${fmt.hm(last.imageTimeUtc, feed.tz ?? null)} (${fmt.ago(last.imageTimeUtc)})`
            : null,
          nextAt ? `next update ${fmt.hm(nextAt, null)} (your time)` : null,
        ]
          .filter(Boolean)
          .join(" · ");
      };

      const show = (data, force) => {
        last = data;
        if (!data.configured) {
          img.hidden = true;
          empty.hidden = false;
          empty.textContent =
            "No all-sky source set. Configure it in NINA → Options → Plugins → Remote Telemetry.";
          err.textContent = "";
          renderInfo();
          return;
        }
        err.textContent = data.error ?? "";
        if (!data.imageId) {
          empty.hidden = false;
          empty.textContent = "No image yet.";
        } else if (force || data.imageId !== shownId) {
          // New image id busts the cache when the picture changes; t forces a re-fetch on manual refresh.
          const params = new URLSearchParams({
            v: data.imageId,
            t: String(Date.now()),
          });
          if (feed.dev.key) params.set("key", feed.dev.key);
          img.src = `${feed.dev.url}/api/v1/allsky/image?${params}`;
          shownId = data.imageId;
        }
        renderInfo();
      };

      const schedule = () => {
        clearTimeout(timer);
        const ms = Number(interval.value) * 60000;
        nextAt = new Date(Date.now() + ms).toISOString();
        timer = setTimeout(() => load(false), ms);
      };

      const load = async (force) => {
        btn.disabled = true;
        if (force) btn.textContent = "Refreshing…";
        try {
          const data = await api(
            feed.dev,
            force ? "/api/v1/allsky/refresh" : "/api/v1/allsky",
            35000,
            force ? "POST" : "GET",
          );
          schedule();
          show(data, force);
        } catch (e) {
          schedule();
          err.textContent = `Couldn't load the all-sky image: ${e.message}`;
        } finally {
          btn.disabled = false;
          btn.textContent = "Refresh";
        }
      };

      btn.addEventListener("click", () => load(true));
      interval.addEventListener("change", () => {
        localStorage.setItem(storeKey, interval.value);
        schedule();
        renderInfo();
      });
      onDispose(() => clearTimeout(timer));
      load(false);

      // Status ticks only keep the "x min ago" text current.
      return () => renderInfo();
    },
  },

  frame: {
    title: "Last frame",
    span: 2,
    tall: true,
    needs: [],
    mount(body, feed) {
      const img = el("img", {
        alt: "Preview of the last saved frame",
        hidden: true,
      });
      const empty = el("div", { class: "muted", text: "No frame saved yet." });
      const dl = el("dl", { class: "kv" });
      img.addEventListener("click", () => img.classList.toggle("zoom"));
      img.addEventListener("load", () => {
        img.hidden = false;
        empty.hidden = true;
      });
      img.addEventListener("error", () => {
        empty.textContent = "Preview unavailable.";
      });
      body.append(el("div", { class: "preview" }, img, empty), dl);
      let shownId = null;
      return () => {
        const i = feed.status.lastImage;
        if (!i) {
          kv(dl, []);
          return;
        }
        if (i.hasPreview && shownId !== i.id) {
          shownId = i.id;
          img.src = previewUrl(feed.dev, i.id);
        }
        kv(dl, [
          ["Saved", `${fmt.time(i.timestampUtc)} (${fmt.ago(i.timestampUtc)})`],
          ["Type", i.imageType],
          ["Target", i.target],
          ["Coordinates", i.ra ? `${i.ra}  ${i.dec}` : null],
          ["Filter", i.filter],
          ["Exposure", fmt.num(i.exposureSeconds, 1, "s")],
          [
            "HFR",
            i.hfr != null
              ? `${fmt.num(i.hfr, 2)} ± ${fmt.num(i.hfrStDev, 2)}`
              : null,
          ],
          ["Stars", i.stars],
          [
            "Mean / Median",
            i.mean != null
              ? `${fmt.num(i.mean, 0)} / ${fmt.num(i.median, 0)}`
              : null,
          ],
          [
            "Camera",
            [
              fmt.num(i.cameraTemperature, 1, "°C"),
              i.gain != null ? `gain ${i.gain}` : null,
              i.offset != null ? `offset ${i.offset}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          ],
          ["File", i.fileName],
        ]);
      };
    },
  },

  equipment: {
    title: "Equipment",
    span: 2,
    needs: [],
    mount(body, feed) {
      const grid = el("div", { class: "equipment" });
      body.append(grid);
      return () => {
        const eq = feed.status.devices;
        grid.replaceChildren(
          ...Object.entries(DEVICE_VIEWS)
            .filter(([k]) => eq[k])
            .map(([k, [label, rows, render]]) => {
              const d = eq[k];
              const dl = el("dl", { class: "kv" });
              if (d.connected) kv(dl, rows(d));
              return el(
                "div",
                {
                  class: `device${d.connected ? "" : " off"}${render && d.connected ? " wide" : ""}`,
                },
                el(
                  "header",
                  null,
                  el("span", { class: `dot ${d.connected ? "ok" : ""}` }),
                  label,
                ),
                el(
                  "div",
                  { class: "name", title: d.name || "" },
                  d.connected ? d.name : "Not connected",
                ),
                render && d.connected ? render(d) : dl,
              );
            }),
        );
      };
    },
  },

  weather: {
    title: "Weather",
    span: 1,
    needs: [],
    mount(body, feed) {
      const dl = el("dl", { class: "kv" });
      body.append(dl);
      return () => {
        const w = feed.status.devices.weather;
        if (!w?.connected) {
          kv(dl, [["Status", "No weather source connected"]]);
          return;
        }
        kv(dl, [
          ["Source", w.name],
          ["Temperature", fmt.num(w.temperature, 1, "°C")],
          ["Dew point", fmt.num(w.dewPoint, 1, "°C")],
          ["Humidity", fmt.num(w.humidity, 0, "%")],
          ["Pressure", fmt.num(w.pressure, 0, " hPa")],
          ["Clouds", fmt.num(w.cloudCover, 0, "%")],
          ["Rain", fmt.num(w.rainRate, 1, " mm/h")],
          [
            "Wind",
            w.windSpeed != null
              ? `${fmt.num(w.windSpeed, 1, " m/s")}${w.windGust != null ? ` (gust ${fmt.num(w.windGust, 1)})` : ""}${w.windDirection != null ? ` ${fmt.num(w.windDirection, 0)}°` : ""}`
              : null,
          ],
          ["Sky temp", fmt.num(w.skyTemperature, 1, "°C")],
          ["SQM", fmt.num(w.skyQuality, 2, " mag/″²")],
          ["Star FWHM", fmt.num(w.starFwhm, 2, "″")],
        ]);
      };
    },
  },

  guiding: {
    title: "Guiding",
    span: 2,
    needs: ["guiding"],
    mount(body, feed, onDispose) {
      const opt = (v, t, sel) =>
        el("option", { value: v, text: t, selected: sel });
      const range = el(
        "select",
        { "aria-label": "Y scale" },
        opt("0", "Auto"),
        opt("0.5", "±0.5"),
        opt("1", "±1"),
        opt("2", "±2", true),
        opt("4", "±4"),
        opt("8", "±8"),
      );
      const count = el(
        "select",
        { "aria-label": "Steps shown" },
        opt("50", "50 steps"),
        opt("100", "100 steps", true),
        opt("200", "200 steps"),
        opt("400", "400 steps"),
      );
      const pulses = el("input", { type: "checkbox", checked: true });
      const canvas = el("canvas", { height: 200 });
      const stats = el("div", { class: "muted small" });
      const dl = el("dl", { class: "kv" });
      body.append(
        el(
          "div",
          { class: "toolbar" },
          range,
          count,
          el("label", { class: "small" }, pulses, " corrections"),
        ),
        canvas,
        el(
          "div",
          { class: "legend" },
          el("span", { class: "sw ra" }),
          "RA",
          el("span", { class: "sw dec" }),
          "Dec",
          el("span", { class: "sw dither" }),
          "Dither",
        ),
        stats,
        dl,
      );

      const draw = () => {
        stats.textContent = drawGuideGraph(
          canvas,
          feed,
          Number(range.value),
          Number(count.value),
          pulses.checked,
        );
      };
      [range, count, pulses].forEach((c) => c.addEventListener("change", draw));
      const observer = new ResizeObserver(draw);
      observer.observe(canvas);
      onDispose(() => observer.disconnect());

      return (kind) => {
        if (kind === "guiding" || kind === "all") draw();
        if (kind !== "status" && kind !== "all") return;
        const g = feed.status.devices.guider;
        if (!g?.connected) {
          kv(dl, [["Status", "Guider not connected"]]);
          return;
        }
        const r = g.rms || {};
        kv(dl, [
          ["Guider", `${g.name}${feed.isGuiding ? " — guiding" : ""}`],
          [
            "RMS total",
            r.totalArcsec != null
              ? `${fmt.num(r.totalArcsec, 2)}″ (${fmt.num(r.totalPixels, 2)} px)`
              : null,
          ],
          [
            "RMS RA / Dec",
            r.raArcsec != null
              ? `${fmt.num(r.raArcsec, 2)}″ / ${fmt.num(r.decArcsec, 2)}″`
              : null,
          ],
          [
            "Peak RA / Dec",
            r.peakRaArcsec != null
              ? `${fmt.num(r.peakRaArcsec, 2)}″ / ${fmt.num(r.peakDecArcsec, 2)}″`
              : null,
          ],
          ["Pixel scale", fmt.num(g.pixelScale, 2, "″/px")],
        ]);
      };
    },
  },

  chart: {
    title: "HFR & stars",
    span: 2,
    needs: ["history"],
    mount(body, feed, onDispose) {
      const canvas = el("canvas", { height: 180 });
      body.append(
        canvas,
        el(
          "div",
          { class: "legend" },
          el("span", { class: "sw hfr" }),
          "HFR",
          el("span", { class: "sw stars" }),
          "Stars",
        ),
      );
      const draw = () =>
        drawChart(
          canvas,
          feed.history.filter(
            (i) => (i.imageType || "").toUpperCase() === "LIGHT",
          ),
          feed.tz ?? null,
        );
      const observer = new ResizeObserver(draw);
      observer.observe(canvas);
      onDispose(() => observer.disconnect());
      return (kind) => {
        if (kind === "history" || kind === "all") draw();
      };
    },
  },

  autofocus: {
    title: "Autofocus",
    span: 2,
    needs: ["autofocus"],
    // Hidden in Full view until NINA has written at least one autofocus report.
    available: (feed) => !feed.autofocus || feed.autofocus.available,
    mount(body, feed, onDispose) {
      const head = el("div", { class: "muted small" });
      const canvas = el("canvas", { height: 200 });
      const dl = el("dl", { class: "kv" });
      const recent = el("div", { class: "tablewrap" });
      body.append(head, canvas, dl, recent);

      const draw = () => drawFocusCurve(canvas, feed.autofocus?.latest);
      let shownId;
      const render = () => {
        const af = feed.autofocus;
        if (!af) {
          head.textContent = "Loading…";
          return;
        }
        shownId = af.latest?.id ?? null;
        const r = af.latest;
        if (!r) {
          head.textContent = af.error
            ? `Could not read autofocus reports: ${af.error}`
            : "No autofocus runs recorded yet.";
          kv(dl, []);
          recent.replaceChildren();
          draw();
          return;
        }
        head.textContent = `${fmt.hm(r.timestampUtc)} (${fmt.ago(r.timestampUtc)})${r.filter ? ` · ${r.filter}` : ""}`;
        const fit = (r.fitting || "").toLowerCase();
        const r2 = r.rSquares
          ? fit.includes("hyperbolic")
            ? r.rSquares.hyperbolic
            : fit.includes("parabolic") || fit.includes("quadratic")
              ? r.rSquares.quadratic
              : fit.includes("trend")
                ? Math.min(
                    r.rSquares.leftTrend ?? 1,
                    r.rSquares.rightTrend ?? 1,
                  )
                : null
          : null;
        const shift =
          r.calculated && r.previous
            ? Math.round(r.calculated.position - r.previous.position)
            : null;
        kv(dl, [
          [
            "Focus position",
            r.calculated
              ? `${Math.round(r.calculated.position)}${shift ? ` (${shift > 0 ? "+" : ""}${shift} vs previous)` : ""}`
              : "No focus point found",
          ],
          [
            /contrast/i.test(r.method || "") ? "Best contrast" : "Best HFR",
            fmt.num(r.calculated?.value, 2),
          ],
          ["Temperature", fmt.num(r.temperature, 1, "°C")],
          ["Method", [r.method, r.fitting].filter(Boolean).join(" · ") || null],
          ["R²", fmt.num(r2, 3)],
          ["Points", r.points?.length ? String(r.points.length) : null],
          [
            "Duration",
            r.durationSeconds != null
              ? `${Math.floor(r.durationSeconds / 60)}m ${String(Math.round(r.durationSeconds % 60)).padStart(2, "0")}s`
              : null,
          ],
        ]);
        recent.replaceChildren(
          af.recent?.length > 1
            ? el(
                "table",
                null,
                el(
                  "thead",
                  null,
                  el(
                    "tr",
                    null,
                    ...["Time", "Filter", "Position", "HFR", "Temp"].map((h) =>
                      el("th", { text: h }),
                    ),
                  ),
                ),
                el(
                  "tbody",
                  null,
                  ...af.recent.map((x) =>
                    el(
                      "tr",
                      null,
                      ...[
                        fmt.hm(x.timestampUtc),
                        x.filter,
                        x.position != null
                          ? String(Math.round(x.position))
                          : "—",
                        fmt.num(x.value, 2),
                        fmt.num(x.temperature, 1, "°C"),
                      ].map((v) => el("td", { text: v ?? "" })),
                    ),
                  ),
                ),
              )
            : null,
        );
        draw();
      };
      const observer = new ResizeObserver(draw);
      observer.observe(canvas);
      onDispose(() => observer.disconnect());
      return (kind) => {
        // The report can arrive before the first status, when updates are not delivered yet.
        if (
          kind === "autofocus" ||
          kind === "all" ||
          (feed.autofocus && shownId === undefined)
        )
          render();
      };
    },
  },

  issues: {
    title: "Errors & warnings",
    span: 2,
    needs: ["issues"],
    mount(body, feed) {
      const list = el("ol", { class: "loglist" });
      body.append(list);
      return (kind) => {
        if (kind !== "issues" && kind !== "all") return;
        list.replaceChildren(
          ...(feed.issues.length
            ? feed.issues.slice().reverse().map(logItem)
            : [
                el("li", {
                  class: "muted",
                  text: "No errors or warnings logged.",
                }),
              ]),
        );
      };
    },
  },

  logs: {
    title: "Log",
    span: 4,
    needs: ["logs"],
    mount(body, feed) {
      const level = el(
        "select",
        { "aria-label": "Minimum log level" },
        ...["Info", "Warning", "Error"].map((l) =>
          el("option", { value: l, text: `${l}+` }),
        ),
      );
      const follow = el("input", { type: "checkbox", checked: true });
      const list = el("ol", { class: "loglist tall" });
      body.append(
        el(
          "div",
          { class: "toolbar" },
          level,
          el("label", { class: "small" }, follow, " follow"),
        ),
        list,
      );
      const visible = (e) => LEVEL_RANK[e.level] >= LEVEL_RANK[level.value];
      const scroll = () => {
        if (follow.checked) list.scrollTop = list.scrollHeight;
      };
      const rebuild = () => {
        list.replaceChildren(...feed.logs.filter(visible).map(logItem));
        scroll();
      };
      level.addEventListener("change", () => withZone(feed, rebuild));
      return (kind, entries) => {
        if (kind === "all" || (kind === "logs" && !entries)) return rebuild();
        if (kind !== "logs") return;
        list.append(...entries.filter(visible).map(logItem));
        while (list.children.length > MAX_LOGS) list.firstChild.remove();
        scroll();
      };
    },
  },

  history: {
    title: "Image history",
    span: 4,
    needs: ["history"],
    mount(body, feed) {
      const tbody = el("tbody");
      body.append(
        el(
          "div",
          { class: "tablewrap" },
          el(
            "table",
            null,
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                ...[
                  "Time",
                  "Type",
                  "Target",
                  "Filter",
                  "Exp",
                  "HFR",
                  "Stars",
                  "Median",
                  "Temp",
                  "File",
                ].map((h) => el("th", { text: h })),
              ),
            ),
            tbody,
          ),
        ),
      );
      return (kind) => {
        if (kind !== "history" && kind !== "all") return;
        tbody.replaceChildren(
          ...feed.history
            .slice()
            .reverse()
            .map((i) =>
              el(
                "tr",
                null,
                ...[
                  fmt.time(i.timestampUtc),
                  i.imageType,
                  i.target,
                  i.filter,
                  fmt.num(i.exposureSeconds, 1, "s"),
                  fmt.num(i.hfr, 2),
                  i.stars,
                  fmt.num(i.median, 0),
                  fmt.num(i.cameraTemperature, 1),
                  i.fileName,
                ].map((v) => el("td", { text: v ?? "" })),
              ),
            ),
        );
      };
    },
  },
};

function drawChart(canvas, points, tz) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 180;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted");
  ctx.font = "11px system-ui";
  ctx.fillStyle = muted;

  if (points.length < 2) {
    ctx.fillText("Not enough light frames yet.", 10, h / 2);
    return;
  }

  const pad = { l: 36, r: 40, t: 8, b: 18 };
  const series = (key, color, right) => {
    const vals = points.map((p) => p[key]).filter((v) => v != null);
    if (!vals.length) return;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    points.forEach((p, i) => {
      if (p[key] == null) return;
      if (started) ctx.lineTo(x(i), y(p[key]));
      else {
        ctx.moveTo(x(i), y(p[key]));
        started = true;
      }
    });
    ctx.stroke();
    ctx.fillStyle = color;
    const digits = key === "hfr" ? 2 : 0;
    const lx = right ? w - pad.r + 4 : 2;
    ctx.fillText(max.toFixed(digits), lx, pad.t + 9);
    ctx.fillText(min.toFixed(digits), lx, h - pad.b);
  };
  series("hfr", style.getPropertyValue("--accent"), false);
  series("stars", style.getPropertyValue("--warn"), true);
  ctx.fillStyle = muted;
  ctx.fillText(fmt.time(points[0].timestampUtc, tz), pad.l, h - 3);
  const last = fmt.time(points.at(-1).timestampUtc, tz);
  ctx.fillText(last, w - pad.r - ctx.measureText(last).width, h - 3);
}

/** Plots the measured focus points of an autofocus report with the chosen focus position. */
function drawFocusCurve(canvas, report) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 200;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted");
  const accent = style.getPropertyValue("--accent");
  const good = style.getPropertyValue("--ok");
  ctx.font = "11px system-ui";
  ctx.fillStyle = muted;

  const pts = (report?.points || []).filter((p) => p.value != null);
  if (pts.length < 2) {
    ctx.fillText(
      report ? "No measured points in this report." : "No autofocus data.",
      10,
      h / 2,
    );
    return;
  }

  const best = report.calculated;
  const xs = pts.map((p) => p.position).concat(best ? [best.position] : []);
  const ys = pts.flatMap((p) => [
    p.value + (p.error || 0),
    Math.max(0, p.value - (p.error || 0)),
  ]);
  if (best?.value != null) ys.push(best.value);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const pad = { l: 40, r: 10, t: 10, b: 20 };
  const x = (v) => pad.l + ((v - xMin) / xSpan) * (w - pad.l - pad.r);
  const y = (v) =>
    pad.t +
    (1 - (v - (yMin - ySpan * 0.05)) / (ySpan * 1.1)) * (h - pad.t - pad.b);

  // Axes labels and light grid.
  ctx.strokeStyle = "#ffffff14";
  ctx.lineWidth = 1;
  for (const f of [0, 0.5, 1]) {
    const v = yMin + f * ySpan;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
    ctx.fillText(v.toFixed(2), 2, y(v) + 4);
  }
  ctx.fillText(String(Math.round(xMin)), pad.l, h - 4);
  const xMaxLabel = String(Math.round(xMax));
  ctx.fillText(xMaxLabel, w - pad.r - ctx.measureText(xMaxLabel).width, h - 4);

  if (report.previous) {
    ctx.strokeStyle = muted;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x(report.previous.position), pad.t);
    ctx.lineTo(x(report.previous.position), h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) =>
    i
      ? ctx.lineTo(x(p.position), y(p.value))
      : ctx.moveTo(x(p.position), y(p.value)),
  );
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const p of pts) {
    if (p.error) {
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(p.position), y(p.value - p.error));
      ctx.lineTo(x(p.position), y(p.value + p.error));
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x(p.position), y(p.value), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (best) {
    const bx = x(best.position);
    ctx.strokeStyle = good;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(bx, pad.t);
    ctx.lineTo(bx, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    if (best.value != null) {
      ctx.fillStyle = good;
      ctx.beginPath();
      ctx.arc(bx, y(best.value), 5, 0, Math.PI * 2);
      ctx.fill();
    }
    const label = String(Math.round(best.position));
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = good;
    ctx.fillText(
      label,
      Math.min(Math.max(bx - lw / 2, pad.l), w - pad.r - lw),
      pad.t + 9,
    );
  }
}

/** Draws RA/Dec error like NINA's guide graph. Returns an RMS summary of the shown window. */
function drawGuideGraph(canvas, feed, range, count, showPulses) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 200;
  if (!w) return "";
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted");
  const raColor = style.getPropertyValue("--ra");
  const decColor = style.getPropertyValue("--dec");
  ctx.font = "11px system-ui";

  const arcsec = feed.guideScale != null;
  const unit = arcsec ? "″" : "px";
  const pts = feed.guide.slice(-count);
  const raOf = (p) => (arcsec ? p.ra : p.raPx);
  const decOf = (p) => (arcsec ? p.dec : p.decPx);

  const peak = pts.reduce(
    (m, p) => Math.max(m, Math.abs(raOf(p)), Math.abs(decOf(p))),
    0,
  );
  const yMax =
    range > 0 ? range : Math.max(0.5, Math.ceil(peak * 1.15 * 2) / 2);
  const pad = { l: 34, r: 8, t: 6, b: 6 };
  const plotW = w - pad.l - pad.r;
  const mid = pad.t + (h - pad.t - pad.b) / 2;
  const half = (h - pad.t - pad.b) / 2;
  const x = (i) =>
    pad.l + (count > 1 ? (i + (count - pts.length)) / (count - 1) : 0) * plotW;
  const y = (v) => mid - Math.max(-1, Math.min(1, v / yMax)) * half;

  // Grid at 0, ±half and ±full scale.
  ctx.strokeStyle = "#ffffff14";
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  for (const f of [1, 0.5, 0, -0.5, -1]) {
    const gy = mid - f * half;
    ctx.beginPath();
    ctx.moveTo(pad.l, gy);
    ctx.lineTo(w - pad.r, gy);
    ctx.stroke();
    ctx.fillText(`${(f * yMax).toFixed(yMax < 2 ? 2 : 1)}`, 2, gy + 4);
  }

  if (!pts.length) {
    ctx.fillText(
      feed.isGuiding ? "Waiting for guide steps…" : "Not guiding.",
      pad.l + 8,
      mid - 8,
    );
    return "";
  }

  if (showPulses) {
    const maxPulse = Math.max(
      1,
      ...pts.map((p) =>
        Math.max(Math.abs(p.raPulseMs), Math.abs(p.decPulseMs)),
      ),
    );
    const barW = Math.max(1, plotW / count / 3);
    const bar = (p, i, key, color, offset) => {
      if (!p[key]) return;
      const len = (p[key] / maxPulse) * half * 0.5;
      ctx.fillStyle = color;
      ctx.fillRect(x(i) + offset, mid, barW, -len);
    };
    ctx.globalAlpha = 0.35;
    pts.forEach((p, i) => {
      bar(p, i, "raPulseMs", raColor, -barW);
      bar(p, i, "decPulseMs", decColor, 0);
    });
    ctx.globalAlpha = 1;
  }

  // Dither markers between the steps they occurred at.
  ctx.strokeStyle = style.getPropertyValue("--warn");
  ctx.setLineDash([4, 4]);
  for (const d of feed.dithers) {
    const i = pts.findIndex((p) => p.time >= d);
    if (i <= 0) continue;
    ctx.beginPath();
    ctx.moveTo(x(i), pad.t);
    ctx.lineTo(x(i), h - pad.b);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const line = (valueOf, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) =>
      i ? ctx.lineTo(x(i), y(valueOf(p))) : ctx.moveTo(x(i), y(valueOf(p))),
    );
    ctx.stroke();
  };
  line(raOf, raColor);
  line(decOf, decColor);

  const rms = (f) =>
    Math.sqrt(pts.reduce((s, p) => s + f(p) ** 2, 0) / pts.length);
  const ra = rms(raOf);
  const dec = rms(decOf);
  return `RMS (shown): RA ${ra.toFixed(2)}${unit} · Dec ${dec.toFixed(2)}${unit} · Total ${Math.hypot(ra, dec).toFixed(2)}${unit}`;
}

// ---------- views ----------

let unmounts = [];

function buildCard(cfg, custom) {
  const def = CARDS[cfg.type];
  const dev = deviceById(cfg.deviceId);
  const feed = feedFor(dev);
  const status = el("span", { class: "card-status" });
  const snap = el(
    "button",
    {
      type: "button",
      class: "snap-btn",
      title: "Take snapshot",
      "aria-label": "Take snapshot",
    },
    cameraIcon(),
  );
  const head = el(
    "h2",
    null,
    def.title,
    custom ? el("span", { class: "src-tag", text: dev.name }) : null,
    status,
    snap,
  );
  if (custom && editMode) head.append(editTools(cfg));
  const body = el("div", { class: "card-body" });
  const section = el(
    "section",
    { class: `card span-${cfg.span || def.span}${def.tall ? " row-2" : ""}` },
    head,
    body,
  );
  snap.addEventListener("click", () =>
    openSnapshot(section, `${dev.name} ${def.title}`, dev.name),
  );
  const update = def.mount(body, feed, (fn) => unmounts.push(fn));

  unmounts.push(
    feed.subscribe({
      needs: def.needs,
      update(kind, payload) {
        section.classList.toggle("stale", !!feed.error);
        status.textContent = feed.error ? `offline: ${feed.error.message}` : "";
        if (feed.status) withZone(feed, () => update(kind, payload));
        // Full view only: cards for features this NINA doesn't use stay hidden.
        if (!custom && def.available && feed.status)
          section.hidden = !def.available(feed);
      },
    }),
  );
  return section;
}

// ---------- card snapshots ----------

const SVG_NS = "http://www.w3.org/2000/svg";

function cameraIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs = {
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, a] of [
    [
      "path",
      {
        d: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z",
      },
    ],
    ["circle", { cx: "12", cy: "13", r: "3.5" }],
  ]) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
    svg.append(e);
  }
  return svg;
}

// Inherited text properties are always copied so the clone can't pick up a parent's value by mistake.
const SNAP_ALWAYS =
  /^(color|font|line-height|letter-spacing|text-|white-space|word-|overflow-wrap|visibility)/;

function snapshotStyler() {
  const sandbox = el("div");
  sandbox.style.setProperty("position", "absolute");
  sandbox.style.setProperty("left", "-99999px");
  sandbox.style.setProperty("top", "0");
  document.body.append(sandbox);
  const baselines = new Map();
  const baseline = (tag) => {
    let b = baselines.get(tag);
    if (!b) {
      const probe = document.createElement(tag);
      sandbox.append(probe);
      const cs = getComputedStyle(probe);
      b = {};
      for (const p of cs) b[p] = cs.getPropertyValue(p);
      probe.remove();
      baselines.set(tag, b);
    }
    return b;
  };
  let shorthands;
  return {
    copy(src, dst) {
      const cs = getComputedStyle(src);
      const base = baseline(src.tagName);
      const names = [...cs];
      // Chrome also lists a few shorthands (e.g. border-image) whose serialization differs; longhands suffice.
      shorthands ??= new Set(
        names.filter(
          (p) => p !== "text-align" && names.some((q) => q.startsWith(`${p}-`)),
        ),
      );
      // Table parts size themselves; fixed cell heights render taller in the SVG.
      const tablePart = cs.display.startsWith("table");
      for (const p of names) {
        // Prefixed aliases (e.g. -webkit-border-image) re-serialize with "fill" and paint over content.
        if (shorthands.has(p) || p.startsWith("-webkit-")) continue;
        if (tablePart && /^(height|block-size)$/.test(p)) continue;
        const v = cs.getPropertyValue(p);
        if (v !== base[p] || SNAP_ALWAYS.test(p)) dst.style.setProperty(p, v);
      }
    },
    dispose: () => sandbox.remove(),
  };
}

async function imageDataUrl(img) {
  const src = img.currentSrc || img.src;
  if (!src) return null;
  if (img.complete && img.naturalWidth) {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.width * c.height > 250000
        ? c.toDataURL("image/jpeg", 0.9)
        : c.toDataURL("image/png");
    } catch {
      /* cross-origin image: fetch it instead */
    }
  }
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function inlineTree(src, dst, styler) {
  const kids = [...src.childNodes];
  const dstKids = [...dst.childNodes];
  for (let i = 0; i < kids.length; i++) {
    const s = kids[i];
    const d = dstKids[i];
    if (s.nodeType !== Node.ELEMENT_NODE) continue;
    if (
      s.matches(".snap-btn, .tools") ||
      getComputedStyle(s).display === "none"
    ) {
      d.remove();
      continue;
    }
    if (s instanceof HTMLCanvasElement) {
      const img = document.createElement("img");
      try {
        img.setAttribute("src", s.toDataURL("image/png"));
      } catch {
        /* leave blank */
      }
      styler.copy(s, img);
      d.replaceWith(img);
      continue;
    }
    styler.copy(s, d);
    if (s instanceof HTMLImageElement) {
      d.removeAttribute("srcset");
      d.setAttribute("src", (await imageDataUrl(s)) ?? "");
      continue;
    }
    if (s instanceof HTMLInputElement) {
      d.toggleAttribute("checked", s.checked);
      d.setAttribute("value", s.value);
    } else if (s instanceof HTMLSelectElement) {
      [...d.options].forEach((o, j) =>
        o.toggleAttribute("selected", j === s.selectedIndex),
      );
    }
    await inlineTree(s, d, styler);
    // Scrollbars make no sense in a picture; keep what was scrolled into view (e.g. the end of the log).
    const ov = getComputedStyle(s);
    if (/auto|scroll/.test(ov.overflowX + ov.overflowY))
      d.style.setProperty("overflow", "hidden");
    if (s.scrollTop || s.scrollLeft)
      for (const k of d.children)
        k.style.setProperty(
          "transform",
          `translate(${-s.scrollLeft}px, ${-s.scrollTop}px)`,
        );
  }
}

async function renderSnapshot(card, deviceName) {
  const pad = 16;
  const footH = 24;
  const rect = card.getBoundingClientRect();
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  const W = w + pad * 2;
  const H = h + pad * 2 + footH;
  const bodyStyle = getComputedStyle(document.body);
  const bg =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim() || "#0c0b11";

  const styler = snapshotStyler();
  let markup;
  try {
    const clone = card.cloneNode(true);
    styler.copy(card, clone);
    await inlineTree(card, clone, styler);
    clone.style.setProperty("margin", "0");
    clone.style.setProperty("width", `${w}px`);
    clone.style.setProperty("height", `${h}px`);
    clone.style.setProperty("box-sizing", "border-box");

    const muted = getComputedStyle(document.documentElement)
      .getPropertyValue("--muted")
      .trim();
    const foot = el(
      "div",
      null,
      el("span", {
        text: `${deviceName} · ${new Date().toLocaleString()}`,
      }),
      el("span", { text: "N.I.N.A. Remote Telemetry" }),
    );
    for (const [k, v] of [
      ["display", "flex"],
      ["justify-content", "space-between"],
      ["align-items", "flex-end"],
      ["height", `${footH}px`],
      ["font-size", "11px"],
      ["color", muted],
    ])
      foot.style.setProperty(k, v);

    const wrap = el("div", null, clone, foot);
    for (const [k, v] of [
      ["width", `${W}px`],
      ["height", `${H}px`],
      ["box-sizing", "border-box"],
      ["padding", `${pad}px`],
      ["background", bg],
      ["color", bodyStyle.color],
      ["font", bodyStyle.font],
    ])
      wrap.style.setProperty(k, v);
    markup = new XMLSerializer().serializeToString(wrap);
  } finally {
    styler.dispose();
  }

  const svg = `<svg xmlns="${SVG_NS}" width="${W}" height="${H}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
  // A blob: URL would taint the canvas in Chrome; a data: URL does not.
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not encode image."))),
      type,
      quality,
    ),
  );

let lastSnap = null;

function snapNote(text) {
  $("snapNote").textContent = text;
  $("snapNote").hidden = !text;
}

async function openSnapshot(card, name, deviceName) {
  const btn = card.querySelector(".snap-btn");
  btn.disabled = true;
  try {
    const canvas = await renderSnapshot(card, deviceName);
    const [jpg, png] = await Promise.all([
      toBlob(canvas, "image/jpeg", 0.92),
      toBlob(canvas, "image/png"),
    ]);
    if (lastSnap) URL.revokeObjectURL(lastSnap.url);
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    lastSnap = {
      jpg,
      png,
      url: URL.createObjectURL(jpg),
      file: `${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")}_${stamp}.jpg`,
    };
    $("snapImg").src = lastSnap.url;
    const canCopy = !!(
      window.isSecureContext &&
      navigator.clipboard?.write &&
      window.ClipboardItem
    );
    $("snapCopy").disabled = !canCopy;
    snapNote(
      canCopy
        ? ""
        : "Browsers only allow copying images on https:// or localhost pages. Use Save JPG, or right-click the preview and copy it.",
    );
    $("snapDialog").showModal();
  } catch (e) {
    console.error(e);
    alert(`Snapshot failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

$("snapCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": lastSnap.png }),
    ]);
    snapNote("Copied to clipboard.");
  } catch (e) {
    snapNote(`Copy failed: ${e.message}`);
  }
});

$("snapSave").addEventListener("click", () => {
  const a = el("a", { href: lastSnap.url, download: lastSnap.file });
  document.body.append(a);
  a.click();
  a.remove();
});

function editTools(cfg) {
  const move = (delta) => {
    const i = layout.indexOf(cfg);
    const j = i + delta;
    if (j < 0 || j >= layout.length) return;
    [layout[i], layout[j]] = [layout[j], layout[i]];
    saveLayout();
    renderView();
  };
  const resize = () => {
    const sizes = [1, 2, 4];
    cfg.span =
      sizes[
        (sizes.indexOf(cfg.span || CARDS[cfg.type].span) + 1) % sizes.length
      ];
    saveLayout();
    renderView();
  };
  const remove = () => {
    layout = layout.filter((c) => c !== cfg);
    saveLayout();
    renderView();
  };
  return el(
    "span",
    { class: "tools" },
    el(
      "button",
      { type: "button", title: "Move earlier", onclick: () => move(-1) },
      "◀",
    ),
    el(
      "button",
      { type: "button", title: "Move later", onclick: () => move(1) },
      "▶",
    ),
    el(
      "button",
      { type: "button", title: "Change width", onclick: resize },
      "⇔",
    ),
    el(
      "button",
      {
        type: "button",
        title: "Remove card",
        class: "danger",
        onclick: remove,
      },
      "✕",
    ),
  );
}

function renderViewSelect() {
  const sel = $("viewSelect");
  sel.replaceChildren(
    el("option", { value: "custom", text: "My dashboard" }),
    el(
      "optgroup",
      { label: "Full view" },
      ...devices.map((d) =>
        el("option", { value: `device:${d.id}`, text: d.name }),
      ),
    ),
  );
  sel.value = currentView;
}

function renderView() {
  unmounts.forEach((u) => u());
  unmounts = [];

  if (currentView !== "custom" && !deviceById(currentView.slice(7)))
    currentView = "custom";
  const custom = currentView === "custom";
  const hasDevices = devices.length > 0;

  $("empty").hidden = hasDevices;
  $("view").hidden = !hasDevices;
  $("editBtn").hidden = !custom || !hasDevices;
  $("editBtn").textContent = editMode ? "Done" : "Edit layout";
  $("addCardBtn").hidden = !custom || !editMode;
  document.body.classList.toggle("editing", custom && editMode);
  renderViewSelect();
  renderChips();

  const view = $("view");
  view.replaceChildren();
  if (!hasDevices) return;

  if (custom) {
    const cards = layout.filter((c) => deviceById(c.deviceId));
    if (!cards.length) {
      view.append(
        el(
          "section",
          { class: "card span-4 placeholder" },
          el(
            "p",
            null,
            "Your dashboard is empty. Add cards from any of your NINA devices — e.g. guiding from two rigs side by side.",
          ),
          el(
            "button",
            { type: "button", class: "primary", onclick: openCardDialog },
            "Add card",
          ),
        ),
      );
      return;
    }
    view.append(...cards.map((c) => buildCard(c, true)));
  } else {
    const deviceId = currentView.slice(7);
    const feed = feedFor(deviceById(deviceId));
    const tabButton = (id, label) => {
      const b = el(
        "button",
        { type: "button", class: `tab${deviceTab === id ? " active" : ""}` },
        label,
      );
      b.addEventListener("click", () => {
        deviceTab = id;
        localStorage.setItem(KEYS.tab, id);
        renderView();
      });
      return b;
    };
    const tsTab = tabButton("ts", "Target Scheduler");
    const nav = el(
      "nav",
      { class: "tabs span-4" },
      tabButton("overview", "Overview"),
      tsTab,
    );
    // The tab only appears once this NINA reports a reachable Target Scheduler.
    const syncTsTab = () => {
      tsTab.hidden = deviceTab !== "ts" && !tsAvailable(feed);
      nav.hidden = tsTab.hidden;
    };
    syncTsTab();
    unmounts.push(feed.subscribe({ needs: [], update: syncTsTab }));
    view.append(
      nav,
      ...Object.entries(CARDS)
        .filter(([, def]) => (def.tabs ?? ["overview"]).includes(deviceTab))
        .map(([type, def]) =>
          buildCard({ type, deviceId, span: def.span }, false),
        ),
    );
  }
}

function setView(view) {
  currentView = view;
  editMode = false;
  saveView();
  renderView();
}

// ---------- dialogs ----------

function openCardDialog() {
  $("cardType").replaceChildren(
    ...Object.entries(CARDS).map(([k, d]) =>
      el("option", { value: k, text: d.title }),
    ),
  );
  $("cardDevice").replaceChildren(
    ...devices.map((d) => el("option", { value: d.id, text: d.name })),
  );
  $("cardDialog").showModal();
}

function addCard() {
  const type = $("cardType").value;
  const deviceId = $("cardDevice").value;
  if (!CARDS[type] || !deviceById(deviceId)) return;
  layout.push({ id: newId(), type, deviceId, span: CARDS[type].span });
  saveLayout();
  $("cardDialog").close();
  editMode = true;
  renderView();
}

function renderDeviceList() {
  $("deviceList").replaceChildren(
    ...devices.map((d) =>
      el(
        "li",
        null,
        el("span", { class: `dot ${healthClass(health.get(d.id))}` }),
        el(
          "div",
          { class: "grow" },
          el("div", { text: d.name }),
          el("div", { class: "url", text: d.url }),
        ),
        el(
          "button",
          {
            type: "button",
            onclick: () => {
              $("devicesDialog").close();
              setView(`device:${d.id}`);
            },
          },
          "View",
        ),
        el(
          "button",
          {
            type: "button",
            class: "danger",
            onclick: () => removeDevice(d.id),
          },
          "Remove",
        ),
      ),
    ),
  );
}

function removeDevice(id) {
  const d = deviceById(id);
  if (!d || !confirm(`Remove "${d.name}" and its cards?`)) return;
  devices = devices.filter((x) => x.id !== id);
  layout = layout.filter((c) => c.deviceId !== id);
  feeds.get(id)?.stop();
  feeds.delete(id);
  health.delete(id);
  saveDevices();
  saveLayout();
  renderDeviceList();
  renderView();
}

async function addDevice() {
  const err = $("addError");
  err.hidden = true;
  let url;
  try {
    url = normalizeUrl($("newUrl").value);
  } catch (e) {
    err.textContent = `Invalid address: ${e.message}`;
    err.hidden = false;
    return;
  }
  if (devices.some((d) => d.url === url)) {
    err.textContent = `${url} is already in the list.`;
    err.hidden = false;
    return;
  }
  const mixed = mixedContentProblem(url);
  if (mixed) {
    err.textContent = mixed;
    err.hidden = false;
    return;
  }
  const dev = {
    id: newId(),
    url,
    key: $("newKey").value.trim(),
    name: $("newName").value.trim(),
  };
  $("addBtn").disabled = true;
  try {
    const info = await api(dev, "/api/v1/info");
    dev.name ||= info.machineName || url;
  } catch (e) {
    err.textContent = `Could not reach ${url}: ${e.message}. Check the address, port, API key and that the plugin is enabled.`;
    err.hidden = false;
    return;
  } finally {
    $("addBtn").disabled = false;
  }
  devices.push(dev);
  saveDevices();
  $("newName").value = $("newUrl").value = $("newKey").value = "";
  $("devicesDialog").close();
  setView(`device:${dev.id}`);
}

async function autoAddCurrentHost() {
  if (HOSTED || devices.length || !location.protocol.startsWith("http")) return;
  const self = { id: newId(), url: location.origin, key: "", name: "" };
  try {
    const info = await api(self, "/api/v1/info", 4000);
    self.name = info.machineName || "This NINA";
    devices.push(self);
    saveDevices();
    currentView = `device:${self.id}`;
    saveView();
  } catch {
    $("newUrl").value = location.origin;
  }
}

// ---------- config export / import ----------

const CONFIG_FORMAT = "nina-remote-telemetry-config";
const PREFIX = "nina-remote-telemetry.";
const CORE_KEYS = new Set([KEYS.devices, KEYS.layout, KEYS.view]);

function exportConfig() {
  const withKeys = $("cfgIncludeKeys").checked;
  const settings = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith(PREFIX) && !CORE_KEYS.has(k))
      settings[k.slice(PREFIX.length)] = localStorage.getItem(k);
  }
  const config = {
    format: CONFIG_FORMAT,
    version: 1,
    exportedUtc: new Date().toISOString(),
    devices: devices.map(({ id, name, url, key }) =>
      withKeys && key ? { id, name, url, key } : { id, name, url },
    ),
    layout,
    view: currentView,
    settings,
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], {
    type: "application/json",
  });
  const href = URL.createObjectURL(blob);
  const a = el("a", {
    href,
    download: `nina-remote-telemetry-config_${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
  cfgNote(
    withKeys
      ? "Downloaded. The file contains API keys: store it somewhere private."
      : "Downloaded (without API keys).",
  );
}

/** Validates an imported file; throws with a readable message when it isn't a usable config. */
function parseConfig(text) {
  let c;
  try {
    c = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (c?.format !== CONFIG_FORMAT || !Array.isArray(c.devices))
    throw new Error("This is not a Remote Telemetry config file.");
  const str = (v, max = 500) =>
    typeof v === "string" && v.length <= max ? v : null;
  const devs = c.devices.map((d, i) => {
    let url;
    try {
      url = normalizeUrl(str(d?.url) ?? "");
    } catch {
      throw new Error(`Device ${i + 1} has an invalid address.`);
    }
    const id = str(d?.id, 40) || newId();
    if (!/^[\w-]+$/.test(id)) throw new Error(`Device ${i + 1} has a bad id.`);
    return {
      id,
      url,
      name: str(d?.name, 120) || url,
      key: str(d?.key, 200) ?? "",
    };
  });
  const ids = new Set(devs.map((d) => d.id));
  const cards = (Array.isArray(c.layout) ? c.layout : [])
    .filter((x) => CARDS[x?.type] && ids.has(x?.deviceId))
    .map((x) => ({
      id: str(x.id, 40) || newId(),
      type: x.type,
      deviceId: x.deviceId,
      span: [1, 2, 4].includes(x.span) ? x.span : CARDS[x.type].span,
    }));
  const settings = {};
  for (const [k, v] of Object.entries(c.settings ?? {}))
    if (/^[\w.-]{1,80}$/.test(k) && str(v, 2000) != null) settings[k] = v;
  const view = str(c.view, 60);
  return {
    devices: devs,
    layout: cards,
    view:
      view === "custom" ||
      (view?.startsWith("device:") && ids.has(view.slice(7)))
        ? view
        : "custom",
    settings,
  };
}

async function importConfig(file) {
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error("The file is too large.");
    const cfg = parseConfig(await file.text());
    const keyless = cfg.devices.filter((d) => !d.key).length;
    if (
      !confirm(
        `Replace your current ${devices.length} device(s) and layout with ${cfg.devices.length} device(s) and ${cfg.layout.length} card(s) from "${file.name}"?`,
      )
    )
      return;
    // Keep API keys already saved in this browser for the same addresses.
    for (const d of cfg.devices)
      d.key ||= devices.find((x) => x.url === d.url)?.key ?? "";
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
    for (const [k, v] of Object.entries(cfg.settings))
      localStorage.setItem(PREFIX + k, v);
    localStorage.setItem(KEYS.devices, JSON.stringify(cfg.devices));
    localStorage.setItem(KEYS.layout, JSON.stringify(cfg.layout));
    localStorage.setItem(KEYS.view, cfg.view);
    const stillKeyless = cfg.devices.filter((d) => !d.key).length;
    if (keyless && stillKeyless)
      alert(
        `${stillKeyless} device(s) have no API key. If those NINAs require one, add it in Devices.`,
      );
    location.reload();
  } catch (e) {
    cfgNote(`Import failed: ${e.message}`);
  } finally {
    $("cfgFile").value = "";
  }
}

function cfgNote(text) {
  // Import can also start from the empty-state button, when the dialog is closed.
  if (text && !$("configDialog").open) {
    alert(text);
    return;
  }
  $("cfgNote").textContent = text;
  $("cfgNote").hidden = !text;
}

function openConfig() {
  cfgNote("");
  $("cfgSummary").textContent =
    `${devices.length} device(s), ${layout.length} card(s) in "My dashboard".`;
  $("configDialog").showModal();
}

// ---------- boot ----------

async function init() {
  if (localStorage.getItem(KEYS.night) === "1")
    document.body.classList.add("night");
  $("nightBtn").addEventListener("click", () => {
    localStorage.setItem(
      KEYS.night,
      document.body.classList.toggle("night") ? "1" : "0",
    );
  });
  $("timeMode").value = timeMode;
  $("timeMode").addEventListener("change", (e) => {
    timeMode = e.target.value;
    localStorage.setItem(KEYS.timeMode, timeMode);
    renderView();
  });
  const openDevices = () => {
    renderDeviceList();
    $("devicesDialog").showModal();
  };
  $("manageBtn").addEventListener("click", openDevices);
  $("emptyAddBtn").addEventListener("click", openDevices);
  $("addBtn").addEventListener("click", addDevice);
  $("viewSelect").addEventListener("change", (e) => setView(e.target.value));
  $("editBtn").addEventListener("click", () => {
    editMode = !editMode;
    renderView();
  });
  $("addCardBtn").addEventListener("click", openCardDialog);
  $("cardAddBtn").addEventListener("click", addCard);
  $("configBtn").addEventListener("click", openConfig);
  $("cfgExport").addEventListener("click", exportConfig);
  $("cfgImport").addEventListener("click", () => $("cfgFile").click());
  $("cfgFile").addEventListener("change", (e) =>
    importConfig(e.target.files?.[0]),
  );
  $("emptyImportBtn").addEventListener("click", () => $("cfgFile").click());
  if (HOSTED)
    $("emptyHint").textContent =
      "Add a NINA running the Remote Telemetry plugin by its https address, e.g. https://observatory.your-tailnet.ts.net:8788 (turn on “Serve the dashboard over HTTPS on my tailnet” in the plugin options), or import a config file you exported earlier.";

  loadState();
  await autoAddCurrentHost();
  renderView();
  pollIdleDevices();
  setInterval(pollIdleDevices, 20000);
}

init();
