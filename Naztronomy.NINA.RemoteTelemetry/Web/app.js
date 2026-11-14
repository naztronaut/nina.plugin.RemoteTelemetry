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
  time: (iso) => (iso ? new Date(iso).toLocaleTimeString() : null),
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
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("Only http(s) addresses are supported.");
  if (!u.port && u.protocol === "http:") u.port = "8787";
  return u.origin;
}

// ---------- persisted state ----------

const KEYS = {
  devices: "nina-remote-telemetry.devices",
  layout: "nina-remote-telemetry.layout",
  view: "nina-remote-telemetry.view",
  night: "nina-remote-telemetry.night",
};

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

async function api(dev, path, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = dev.key ? { "X-Api-Key": dev.key } : {};
    const res = await fetch(dev.url + path, {
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
    this.statusTimer = setInterval(() => this.poll(), STATUS_MS);
    this.logTimer = setInterval(() => this.pollLogs(), LOG_MS);
    this.guideTimer = setInterval(() => this.pollGuiding(), GUIDE_MS);
  }

  stop() {
    clearInterval(this.statusTimer);
    clearInterval(this.logTimer);
    clearInterval(this.guideTimer);
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
  switch: [
    "Switches",
    (d) =>
      (d.switches || []).slice(0, 8).map((s) => [s.name, fmt.num(s.value, 2)]),
  ],
};

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
        kv(dl, [
          ["Machine", info.machineName],
          ["Profile", info.profile],
          ["NINA", info.ninaVersion],
          ["Target", sequence.activeTarget],
          ["Camera", exposing || cam?.state],
          [
            "Mount",
            eq.mount?.connected ? `${eq.mount.ra}  ${eq.mount.dec}` : null,
          ],
          [
            "Meridian flip",
            eq.mount?.connected ? eq.mount.timeToMeridianFlip : null,
          ],
          ["Updated", new Date(feed.updatedAt).toLocaleTimeString()],
        ]);
        running.replaceChildren(
          ...(sequence.runningItems || []).map((i) =>
            el("span", { title: i.category || "" }, i.name),
          ),
        );
      };
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
            .map(([k, [label, rows]]) => {
              const d = eq[k];
              const dl = el("dl", { class: "kv" });
              if (d.connected) kv(dl, rows(d));
              return el(
                "div",
                { class: `device${d.connected ? "" : " off"}` },
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
                dl,
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
        );
      const observer = new ResizeObserver(draw);
      observer.observe(canvas);
      onDispose(() => observer.disconnect());
      return (kind) => {
        if (kind === "history" || kind === "all") draw();
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
      level.addEventListener("change", rebuild);
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

function drawChart(canvas, points) {
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
  ctx.fillText(fmt.time(points[0].timestampUtc), pad.l, h - 3);
  const last = fmt.time(points.at(-1).timestampUtc);
  ctx.fillText(last, w - pad.r - ctx.measureText(last).width, h - 3);
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
  const head = el(
    "h2",
    null,
    def.title,
    custom ? el("span", { class: "src-tag", text: dev.name }) : null,
    status,
  );
  if (custom && editMode) head.append(editTools(cfg));
  const body = el("div", { class: "card-body" });
  const section = el(
    "section",
    { class: `card span-${cfg.span || def.span}${def.tall ? " row-2" : ""}` },
    head,
    body,
  );
  const update = def.mount(body, feed, (fn) => unmounts.push(fn));

  unmounts.push(
    feed.subscribe({
      needs: def.needs,
      update(kind, payload) {
        section.classList.toggle("stale", !!feed.error);
        status.textContent = feed.error ? `offline: ${feed.error.message}` : "";
        if (feed.status) update(kind, payload);
      },
    }),
  );
  return section;
}

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
    view.append(
      ...Object.entries(CARDS).map(([type, def]) =>
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
  if (devices.length || !location.protocol.startsWith("http")) return;
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

  loadState();
  await autoAddCurrentHost();
  renderView();
  pollIdleDevices();
  setInterval(pollIdleDevices, 20000);
}

init();
