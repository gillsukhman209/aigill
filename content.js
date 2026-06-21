// Content script — relay.amazon.com/loadboard/* (isolated world)
// Custom UI + Bot polling + Detection logic

// ============================================================
// INJECT INTERCEPTOR INTO MAIN WORLD
// Safari doesn't support "world": "MAIN" in manifest, so we inject manually
// ============================================================
(function injectInterceptor() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("interceptor.js");
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).prepend(script);
})();

// ============================================================
// STATE
// ============================================================
let allLoads = [];
let knownIds = new Set();
let currentSort = "score";
let currentSortDir = "desc";
let aiModeActive = true;
let amazonContainer = null;
let ourHost = null;
let shadowRoot = null;
let carrierDetails = null;
let currentSearchAuditId = null;

// Settings (persisted to localStorage)
const SETTINGS_KEY = "rfx_settings";
const DEFAULT_SETTINGS = {
  hideAmazonLoads: false,
  pollMinSeconds: 2,
  pollMaxSeconds: 5,
  showScoreBar: true,
  showPerHr: true,
  showPerMi: true,
  showDistance: true,
  showDuration: true,
  showVersionBadge: true,
  showStopAddress: true,
  showLegDistance: true,
  showDwellTime: true,
  showCheckoutTime: false,
  showLoadTypeBadge: true,
  showPostedAge: true,
  showDriverType: true,
  showEquipment: true,
  showStopCount: true,
  showStopCode: true,
  showExtraStopMeta: true,
  fastBook: false,
  autoBook: false,
  minPriceIncrease: 0,
};
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (s) settings = { ...DEFAULT_SETTINGS, ...s }; } catch {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
loadSettings();

// Negotiation state
const negotiationState = new Map();

// Booking state — key: woId, value: 'idle'|'pending'|'failed'
const bookingState = new Map();

// Bot state
let botRunning = false;
let settingsOpen = false;
let botTimer = null;
let lastPollTime = null;
let lastRefreshInterval = null;
let isFirstPoll = true;
const seenLoads = new Map(); // id -> { version, payout, pickupTime }
const missingCounts = new Map(); // id -> consecutive miss count
let alertedLoads = []; // loads in the "new load detected" section
let goneLoads = new Set(); // ids fading out

// ============================================================
// UTILITIES
// ============================================================
function fmt$(v) { return v != null ? `$${v.toFixed(2)}` : "N/A"; }
function fmtDur(ms) {
  if (!ms) return "N/A";
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`;
}
function fmtTime(iso, tz) {
  if (!iso) return "N/A";
  try {
    const d = new Date(iso), now = new Date();
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/Los_Angeles" });
    const diff = Math.floor((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz || "America/Los_Angeles" });
    return `${label} ${time}`;
  } catch { return iso; }
}
function fmtTimeShort(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/Los_Angeles" }); } catch { return ""; }
}
function fmtStopDateTime(iso, tz) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: tz || "America/Los_Angeles" });
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/Los_Angeles" }).toLowerCase();
    return `${date} ${time}`;
  } catch { return ""; }
}
function fmtStopTimeWindow(checkin, checkout, tz) {
  const start = fmtStopDateTime(checkin, tz);
  if (!start) return "";
  if (!settings.showCheckoutTime || !checkout) return start;
  const end = fmtStopDateTime(checkout, tz);
  return end ? `${start} → ${end}` : start;
}
function fmtAge(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just posted";
  if (min < 60) return `posted ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `posted ${hr}h ${min % 60}m ago`;
  return `posted ${Math.floor(hr / 24)}d ago`;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function getAllStops(wo) {
  const stops = [];
  if (!wo.loads) return stops;
  for (const load of wo.loads) { if (load.stops) for (const s of load.stops) stops.push(s); }
  stops.sort((a, b) => (a.stopSequenceNumber || 0) - (b.stopSequenceNumber || 0));
  const seen = new Set();
  return stops.filter((s) => {
    const k = (s.location?.stopCode || "") + "_" + (s.stopSequenceNumber || 0);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function getLoadsForStop(wo, stop) {
  const matches = [];
  for (const load of wo.loads || []) {
    if ((load.stops || []).some(s =>
      (s.stopSequenceNumber || 0) === (stop.stopSequenceNumber || 0) &&
      (s.location?.stopCode || "") === (stop.location?.stopCode || "")
    )) {
      matches.push(load);
    }
  }
  return matches;
}

function isSameStop(a, b) {
  const aLoc = a.location || {};
  const bLoc = b.location || {};
  if ((a.stopSequenceNumber || 0) !== (b.stopSequenceNumber || 0)) return false;
  if (aLoc.stopCode && bLoc.stopCode) return aLoc.stopCode === bLoc.stopCode;
  if (aLoc.label && bLoc.label) return aLoc.label === bLoc.label;
  return [aLoc.line1, aLoc.city, aLoc.state].join("|") === [bLoc.line1, bLoc.city, bLoc.state].join("|");
}

function getPickupLoadTypesForStop(wo, stop) {
  const types = [];
  for (const load of wo.loads || []) {
    if ((load.stops || []).some(s => s.stopType === "PICKUP" && isSameStop(s, stop))) {
      types.push(load.loadType);
    }
  }
  return uniqTruthy(types).map(titleCaseValue);
}

function hasPreloadedStop(wo) {
  return (wo.loads || []).some(load =>
    (load.stops || []).some(stop => stop.loadingType === "PRELOADED")
  );
}

function uniqTruthy(values) {
  return [...new Set(values.filter(Boolean))];
}

function titleCaseValue(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDisplaySettingsSignature() {
  return [
    settings.showScoreBar,
    settings.showPerHr,
    settings.showPerMi,
    settings.showDistance,
    settings.showDuration,
    settings.showVersionBadge,
    settings.showStopAddress,
    settings.showLegDistance,
    settings.showDwellTime,
    settings.showCheckoutTime,
    settings.showLoadTypeBadge,
    settings.showPostedAge,
    settings.showDriverType,
    settings.showEquipment,
    settings.showStopCount,
    settings.showStopCode,
    settings.showExtraStopMeta,
    settings.fastBook,
  ].map(Boolean).join("");
}

function formatPriceDelta(delta) {
  if (delta == null || Math.abs(delta) < 0.01) return "";
  const sign = delta > 0 ? "+" : "-";
  const abs = Math.abs(delta);
  const amount = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.00$/, "");
  return `${sign}${amount}`;
}

// ============================================================
// SCORING (0-100)
// ============================================================
function scoreLoad(wo) {
  const pay = wo.payout?.value || 0, dist = wo.totalDistance?.value || 0;
  const durH = (wo.totalDuration || 0) / 3600000, ver = wo.version || 1, lay = wo.totalLayover || 0;
  const perHr = durH > 0 ? pay / durH : 0, perMi = dist > 0 ? pay / dist : 0;
  const hrS = Math.min(100, (perHr / 100) * 100);
  const miS = Math.min(100, (perMi / 4) * 100);
  let distB = 0;
  if (dist >= 200 && dist <= 500) distB = 15;
  else if (dist >= 100 && dist < 200) distB = 8;
  else if (dist > 500 && dist <= 700) distB = 5;
  const vP = Math.min(30, (ver - 1) * 3);
  const lP = Math.min(20, (lay / 3600000) * 10);
  return Math.max(0, Math.min(100, Math.round(hrS * 0.4 + miS * 0.3 + distB - vP - lP)));
}
function scoreColor(s) { return s >= 70 ? "#067d62" : s >= 40 ? "#b8860b" : "#cc3333"; }
function scoreBg(s) { return s >= 70 ? "#e6f7f2" : s >= 40 ? "#fef9e7" : "#fdecea"; }

// ============================================================
// SOUND — mp3 files from Sounds folder
// ============================================================
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function playSound(filename) {
  try {
    const url = chrome.runtime.getURL(`Sounds/${filename}`);
    const audio = new Audio(url);
    audio.volume = 1.0;
    audio.play().catch(e => console.warn("[Sound] Play failed:", e));
  } catch (e) { console.warn("[Sound] Error:", e); }
}

function playAlert() { playSound("new_load.mp3"); }
function playBookedSound() { playSound("successbook.mp3"); }

// ============================================================
// DETECTION LOGIC
// ============================================================
function detectChanges(newLoads) {
  // Deduplicate by ID — if same load appears twice, keep the one with higher payout
  const dedupMap = new Map();
  for (const wo of newLoads) {
    const existing = dedupMap.get(wo.id);
    if (!existing || (wo.payout?.value || 0) > (existing.payout?.value || 0)) {
      dedupMap.set(wo.id, wo);
    }
  }
  const deduped = Array.from(dedupMap.values());
  if (deduped.length !== newLoads.length) {
    console.log(`[Bot:Detect] Deduplicated: ${newLoads.length} → ${deduped.length} (${newLoads.length - deduped.length} duplicates removed)`);
  }
  newLoads = deduped;

  console.log(`[Bot:Detect] --- Detection run --- isFirstPoll=${isFirstPoll}, seenLoads=${seenLoads.size}, incoming=${newLoads.length}`);

  if (isFirstPoll) {
    for (const wo of newLoads) {
      seenLoads.set(wo.id, {
        version: wo.version || 1,
        payout: wo.payout?.value || 0,
        pickupTime: wo.firstPickupTime || "",
      });
      console.log(`[Bot:Detect] FIRST POLL — seeded: ${wo.id.substring(0, 8)}... pay=${wo.payout?.value?.toFixed(2)}`);
    }
    isFirstPoll = false;
    console.log(`[Bot:Detect] First poll done. seenLoads=${seenLoads.size}. No alerts.`);
    return [];
  }

  const alerts = [];
  const currentIds = new Set();

  for (const wo of newLoads) {
    currentIds.add(wo.id);
    const prev = seenLoads.get(wo.id);
    const newPay = wo.payout?.value || 0;
    const newVer = wo.version || 1;
    const newPickup = wo.firstPickupTime || "";
    const shortId = wo.id.substring(0, 8);

    if (!prev) {
      console.log(`[Bot:Detect] ★ NEW load: ${shortId}... pay=$${newPay.toFixed(2)} ver=${newVer}`);
      alerts.push({ wo, badge: "NEW", badgeClass: "badge-new" });
      seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
    } else {
      const payChanged = Math.abs(newPay - prev.payout) > 1;
      const verChanged = newVer !== prev.version;
      const timeChanged = newPickup !== prev.pickupTime;

      if (payChanged || verChanged || timeChanged) {
        let badge, badgeClass;
        const priceIncrease = newPay - prev.payout;

        if (payChanged && newPay > prev.payout) {
          // Check min price increase threshold
          if (settings.minPriceIncrease > 0 && priceIncrease < settings.minPriceIncrease) {
            console.log(`[Bot:Detect] — SKIPPED price increase: ${shortId}... +$${priceIncrease.toFixed(2)} below min $${settings.minPriceIncrease}`);
            seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
            missingCounts.delete(wo.id);
            continue;
          }
          badge = `PRICE UP ${fmt$(prev.payout)} → ${fmt$(newPay)}`;
          badgeClass = "badge-price-up";
        } else if (payChanged && newPay < prev.payout) {
          badge = `PRICE DOWN ${fmt$(prev.payout)} → ${fmt$(newPay)}`;
          badgeClass = "badge-price-down";
        } else if (timeChanged) {
          badge = `TIME CHANGED ${fmtTimeShort(prev.pickupTime)} → ${fmtTimeShort(newPickup)}`;
          badgeClass = "badge-time";
        } else {
          badge = "UPDATED";
          badgeClass = "badge-updated";
        }
        console.log(`[Bot:Detect] ★ CHANGED load: ${shortId}... ${badge} (pay:${prev.payout.toFixed(2)}→${newPay.toFixed(2)} ver:${prev.version}→${newVer} time:${prev.pickupTime !== newPickup ? "changed" : "same"})`);
        alerts.push({ wo, badge, badgeClass, priceDelta: payChanged ? priceIncrease : null });
        seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
      } else {
        console.log(`[Bot:Detect] — SAME load: ${shortId}... (no change)`);
      }
      missingCounts.delete(wo.id);
    }
  }

  // Case 4: Disappeared loads
  for (const [id] of seenLoads) {
    if (!currentIds.has(id)) {
      const count = (missingCounts.get(id) || 0) + 1;
      missingCounts.set(id, count);
      console.log(`[Bot:Detect] ✕ MISSING load: ${id.substring(0, 8)}... miss count=${count}`);
      if (count >= 2) {
        console.log(`[Bot:Detect] ✕ GONE confirmed: ${id.substring(0, 8)}...`);
        goneLoads.add(id);
        setTimeout(() => {
          seenLoads.delete(id);
          missingCounts.delete(id);
          goneLoads.delete(id);
          allLoads = allLoads.filter(w => w.id !== id);
          if (aiModeActive) injectCards();
        }, 5000);
      }
    }
  }

  console.log(`[Bot:Detect] Result: ${alerts.length} alerts, seenLoads=${seenLoads.size}`);
  return alerts;
}

// ============================================================
// CSS
// ============================================================
const CSS = `
:host { all: initial; font-family: "Amazon Ember", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; color: #0f1111; }
* { box-sizing: border-box; margin: 0; padding: 0; }

/* Bot status bar */
.rfx-status-bar {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 14px;
  background: #f7f7f7; border: 1px solid #e7e7e7; border-radius: 10px; flex-wrap: wrap;
  position: sticky; top: 0; z-index: 100;
}
.rfx-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.rfx-dot.green { background: #067d62; animation: rfxPulse 1.5s infinite; }
.rfx-dot.amber { background: #b8860b; animation: rfxPulse 1s infinite; }
.rfx-dot.red { background: #cc3333; }
.rfx-dot.grey { background: #aaa; }
@keyframes rfxPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.rfx-status-text { font-size: 13px; color: #565959; }
.rfx-status-text b { color: #0f1111; }
.rfx-last-refresh { font-size: 12px; color: #888; margin-left: auto; }
.rfx-bot-btn {
  padding: 8px 22px; font-size: 14px; font-weight: 600; border-radius: 8px; cursor: pointer;
  font-family: inherit; border: none;
}
.rfx-start-btn { background: #067d62; color: #fff; }
.rfx-start-btn:hover { background: #055d4a; }
.rfx-start-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rfx-stop-btn { background: #cc3333; color: #fff; }
.rfx-stop-btn:hover { background: #a82a2a; }
.rfx-stop-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rfx-fastbook-warn {
  display: inline-flex; align-items: center; gap: 4px;
  background: #cc3333; color: #fff; font-size: 12px; font-weight: 600;
  padding: 4px 12px; border-radius: 6px; animation: rfxWarnPulse 2s infinite;
  width: 100%; margin-top: 6px; justify-content: center;
}
@keyframes rfxWarnPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
.rfx-autobook-warn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  background: #8b0000; color: #fff; font-size: 13px; font-weight: 700;
  padding: 8px 16px; border-radius: 8px; margin-bottom: 10px;
  animation: rfxAutoBookPulse 1.5s infinite;
  text-transform: uppercase; letter-spacing: 0.5px;
}
@keyframes rfxAutoBookPulse { 0%,100% { background: #8b0000; } 50% { background: #cc0000; } }

.rfx-alert-card {
  background: #fff; border: 2px solid #ff9900; border-radius: 8px;
  padding: 12px 16px; margin-bottom: 8px;
}
.rfx-change-badge {
  display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-bottom: 6px;
}
.badge-new { background: #067d62; color: #fff; }
.badge-price-up { background: #067d62; color: #fff; }
.badge-price-down { background: #cc3333; color: #fff; }
.badge-time { background: #b8860b; color: #fff; }
.badge-updated { background: #565959; color: #fff; }
.badge-gone { background: #e7e7e7; color: #888; }

/* Toolbar */
.rfx-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 10px 0 14px 0; flex-wrap: wrap;
  border-bottom: 1px solid #e7e7e7; margin-bottom: 14px;
}
.rfx-toolbar-label { font-size: 13px; color: #565959; margin-right: 4px; }
.rfx-sort-btn {
  padding: 6px 14px; font-size: 13px; border: 1px solid #d5d9d9; border-radius: 8px;
  background: #fff; color: #0f1111; cursor: pointer; font-family: inherit;
}
.rfx-sort-btn:hover { background: #f7fafa; }
.rfx-sort-btn.active { background: #232f3e; color: #fff; border-color: #232f3e; }
.rfx-count { font-size: 13px; color: #565959; margin-left: auto; }

/* Cards */
.rfx-card {
  background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
  padding: 18px 22px; margin-bottom: 14px; cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.5s;
}
.rfx-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-color: #b0b0b0; }
.rfx-card.new-load { background: #fff5e0; border-color: #ff9900; box-shadow: 0 0 12px rgba(255,153,0,0.25); }
.rfx-card.gone { opacity: 0.4; }

.rfx-body { display: flex; gap: 24px; }
.rfx-left { flex: 1; min-width: 0; }
.rfx-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; min-width: 140px; text-align: right; gap: 10px; }
.rfx-payout { font-size: 26px; font-weight: 700; color: #067d62; line-height: 1.2; }
.rfx-price-delta { font-size: 15px; font-weight: 800; line-height: 1; margin-bottom: 3px; }
.rfx-price-delta.up { color: #067d62; }
.rfx-price-delta.down { color: #cc3333; }
.rfx-stat { font-size: 14px; color: #565959; margin-top: 3px; }
.rfx-stat b { color: #0f1111; font-weight: 600; }
.rfx-stats-group { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.rfx-version { font-size: 12px; padding: 3px 8px; border-radius: 4px; font-weight: 600; margin-top: 6px; }
.rfx-version.ok { background: #f0f0f0; color: #565959; }
.rfx-version.bad { background: #fdecea; color: #cc3333; }

.rfx-score-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rfx-score-bg { flex: 1; height: 6px; background: #e7e7e7; border-radius: 3px; overflow: hidden; max-width: 220px; }
.rfx-score-fill { height: 100%; border-radius: 3px; }
.rfx-score-label { font-size: 14px; font-weight: 700; min-width: 26px; }
.rfx-score-tag { font-size: 12px; padding: 2px 10px; border-radius: 4px; font-weight: 600; margin-left: 4px; }

.rfx-stops { margin: 8px 0 4px 0; }
.rfx-stop { display: flex; align-items: flex-start; gap: 12px; position: relative; }
.rfx-stop-line { display: flex; flex-direction: column; align-items: center; width: 28px; flex-shrink: 0; }
.rfx-stop-dot {
  width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.rfx-stop-dot.pickup { background: #2563eb; }
.rfx-stop-dot.dropoff { background: #7c3aed; }
.rfx-stop-conn { width: 2px; flex: 1; background: #d5d9d9; min-height: 14px; }
.rfx-stop-info { flex: 1; padding-bottom: 8px; }
.rfx-stop-name { font-size: 14px; font-weight: 600; color: #0f1111; line-height: 1.4; }
.rfx-stop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.rfx-stop-datetime { font-size: 13px; color: #565959; white-space: nowrap; font-weight: 500; display: inline-flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rfx-stop-addr { font-size: 12px; color: #888; margin-top: 2px; }
.rfx-stop-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
.rfx-stop-time { font-size: 13px; color: #565959; }
.rfx-stop-dwell { font-size: 12px; color: #888; }
.rfx-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
.rfx-badge.preloaded { background: #e6f7f2; color: #067d62; }
.rfx-badge.live { background: #fef3cd; color: #856404; }
.rfx-badge.drop { background: #e8f0fe; color: #1a56db; }
.rfx-leg-dist { font-size: 12px; color: #888; padding: 4px 0 6px 40px; }

.rfx-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 10px; margin-top: 6px; border-top: 1px solid #f0f0f0; }
.rfx-tag { font-size: 13px; color: #565959; }
.rfx-tag b { color: #0f1111; }
.rfx-book-btn {
  margin-left: auto; padding: 8px 22px; font-size: 14px; font-weight: 600;
  background: #ff9900; color: #0f1111; border: none; border-radius: 8px; cursor: pointer; font-family: inherit;
}
.rfx-book-btn:hover { background: #e88b00; }

/* Negotiation */
.rfx-neg-btn {
  padding: 6px 16px; font-size: 13px; font-weight: 600;
  background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: inherit;
  margin-top: 6px;
}
.rfx-neg-btn:hover { background: #1d4ed8; }
.rfx-neg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rfx-neg-btn.done { background: #067d62; cursor: default; }
.rfx-neg-btn.ineligible { background: #888; cursor: default; }
.rfx-neg-section {
  margin-top: 8px; padding: 8px 12px; border-radius: 8px; font-size: 13px;
}
.rfx-neg-section.running { background: #eff6ff; border: 1px solid #bfdbfe; }
.rfx-neg-section.done { background: #e6f7f2; border: 1px solid #a7f3d0; }
.rfx-neg-section.ineligible { background: #f5f5f5; border: 1px solid #e5e5e5; color: #888; }
.rfx-neg-round { font-weight: 600; color: #2563eb; }
.rfx-neg-prices { margin-top: 4px; color: #0f1111; font-size: 14px; }
.rfx-neg-prices span { transition: all 0.3s; }
.rfx-neg-result { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.rfx-neg-gain { font-weight: 700; color: #067d62; font-size: 15px; }
.rfx-neg-final { font-weight: 700; font-size: 18px; color: #067d62; }
.rfx-neg-rounds-count { color: #565959; font-size: 12px; }
@keyframes rfxNegPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
.rfx-neg-pulsing { animation: rfxNegPulse 1s infinite; }

/* Booking */
.rfx-book-btn.pending {
  background: #b8860b; color: #fff; cursor: default;
}
.rfx-card.booking-pending {
  border-color: #ff9900;
  animation: rfxBookPulse 2s infinite;
}
@keyframes rfxBookPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,153,0,0); } 50% { box-shadow: 0 0 8px 2px rgba(255,153,0,0.3); } }
.rfx-toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  background: #232f3e; color: #fff; padding: 10px 20px; border-radius: 8px;
  font-size: 14px; z-index: 9999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  font-family: inherit; animation: rfxToastIn 0.3s;
}
@keyframes rfxToastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

.rfx-empty { text-align: center; color: #888; padding: 40px 20px; font-size: 14px; }

/* Settings */
.rfx-gear-btn {
  background: none; border: 1px solid #d5d9d9; border-radius: 6px; cursor: pointer;
  font-size: 16px; padding: 2px 8px; line-height: 1; color: #565959;
}
.rfx-gear-btn:hover { background: #f7fafa; }
.rfx-settings-panel {
  background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
  padding: 16px; margin-bottom: 10px; display: none;
}
.rfx-settings-panel.open { display: block; }
.rfx-settings-title { font-size: 15px; font-weight: 700; color: #0f1111; margin-bottom: 12px; }
.rfx-settings-section { margin-bottom: 14px; }
.rfx-settings-section-title { font-size: 12px; font-weight: 700; color: #565959; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.rfx-setting-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 0;
}
.rfx-setting-row label { font-size: 13px; color: #0f1111; cursor: pointer; flex: 1; }
.rfx-setting-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #067d62; }
.rfx-range-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.rfx-range-row label { font-size: 13px; color: #0f1111; min-width: 80px; }
.rfx-range-row input[type="range"] { flex: 1; accent-color: #ff9900; }
.rfx-range-val { font-size: 13px; font-weight: 600; color: #0f1111; min-width: 30px; text-align: right; }

/* Responsive — tablet */
@media (max-width: 900px) {
  .rfx-right { min-width: 110px; }
  .rfx-payout { font-size: 18px; }
  .rfx-stat { font-size: 12px; }
}

/* Responsive — mobile */
@media (max-width: 640px) {
  .rfx-status-bar {
    position: sticky; top: 0; z-index: 100;
    padding: 10px 12px; gap: 8px; border-radius: 0;
    margin: 0 -16px 10px -16px; width: calc(100% + 32px);
    border-left: none; border-right: none;
  }
  .rfx-status-text { font-size: 12px; }
  .rfx-last-refresh { font-size: 11px; display: none; }
  .rfx-bot-btn { padding: 10px 20px; font-size: 15px; min-height: 44px; }
  .rfx-gear-btn { font-size: 20px; padding: 6px 10px; min-height: 44px; }
  .rfx-body { flex-direction: column; gap: 6px; }
  .rfx-right {
    flex-direction: row; align-items: center; gap: 10px;
    min-width: 0; text-align: left; flex-wrap: wrap;
    border-top: 1px solid #f0f0f0; padding-top: 8px;
  }
  .rfx-stats-group { flex-direction: row; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  .rfx-payout { font-size: 22px; }
  .rfx-stat { font-size: 13px; margin-top: 0; }
  .rfx-book-btn { margin-left: auto; padding: 10px 20px; font-size: 15px; min-height: 44px; }
  .rfx-card { padding: 12px; margin-bottom: 10px; }
  .rfx-toolbar { gap: 4px; padding: 8px 0; }
  .rfx-sort-btn { padding: 6px 10px; font-size: 12px; min-height: 36px; }
  .rfx-count { font-size: 12px; }
  .rfx-stop-name { font-size: 14px; }
  .rfx-stop-time { font-size: 13px; }
  .rfx-badge { font-size: 11px; padding: 2px 8px; }
  .rfx-footer { gap: 8px; padding-top: 8px; }
  .rfx-tag { font-size: 13px; }
  .rfx-score-row { margin-bottom: 8px; }
  .rfx-version { font-size: 12px; }
  .rfx-settings-panel { padding: 12px; }
  .rfx-setting-row label { font-size: 14px; }
  .rfx-setting-row input[type="checkbox"] { width: 20px; height: 20px; }
  .rfx-range-row label { font-size: 14px; }
  .rfx-fastbook-warn { font-size: 11px; padding: 6px 10px; }
  .rfx-autobook-warn { font-size: 12px; padding: 8px 12px; }
}

/* Responsive — small phone */
@media (max-width: 400px) {
  .rfx-stop-addr { display: none; }
  .rfx-leg-dist { display: none; }
  .rfx-payout { font-size: 20px; }
  .rfx-stat { font-size: 12px; }
  .rfx-bot-btn { padding: 8px 16px; font-size: 14px; }
  .rfx-sort-btn { padding: 5px 8px; font-size: 11px; }
}
`;

// ============================================================
// CARD HTML
// ============================================================
function renderCard(wo, extraClass, changeBadge) {
  const pay = wo.payout?.value || 0, dist = wo.totalDistance?.value || 0;
  const durMs = wo.totalDuration || 0, durH = durMs / 3600000;
  const perHr = durH > 0 ? pay / durH : 0, perMi = dist > 0 ? pay / dist : 0;
  const ver = wo.version || 1, score = scoreLoad(wo), sc = scoreColor(score);
  const stops = getAllStops(wo);
  const driver = wo.transitOperatorType === "TEAM_DRIVER" ? "Team" : "Solo";
  const firstTz = stops[0]?.location?.timeZone || "America/Los_Angeles";
  const bState = bookingState.get(wo.id) || "idle";
  const cls = [
    "rfx-card",
    goneLoads.has(wo.id) ? "gone" : "",
    bState === "pending" ? "booking-pending" : "",
    extraClass || "",
  ].filter(Boolean).join(" ");

  let vBadge = "";
  if (settings.showVersionBadge) {
    if (ver > 3) vBadge = `<span class="rfx-version bad">v${ver} ⚠</span>`;
    else if (ver > 1) vBadge = `<span class="rfx-version ok">v${ver}</span>`;
  }

  const priceDeltaText = changeBadge?.priceDelta ? formatPriceDelta(changeBadge.priceDelta) : "";
  const priceDeltaClass = changeBadge?.priceDelta > 0 ? "up" : "down";
  let badgeHtml = changeBadge && !priceDeltaText ? `<span class="rfx-change-badge ${changeBadge.cls}">${changeBadge.text}</span>` : "";
  if (goneLoads.has(wo.id)) badgeHtml = `<span class="rfx-change-badge badge-gone">GONE</span>`;
  const firstStopDetails = [
    settings.showDriverType ? driver : "",
    settings.showEquipment ? "53' Trailer" : "",
    settings.showLoadTypeBadge && hasPreloadedStop(wo) ? "Preloaded" : "",
  ].filter(Boolean).map(v => `<span class="rfx-tag">${v}</span>`).join("");

  let stopsHtml = "";
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], loc = s.location || {};
    const dotCls = s.stopType === "PICKUP" ? "pickup" : "dropoff";
    const checkin = s.actions?.find(a => a.type === "CHECKIN")?.plannedTime;
    const checkout = s.actions?.find(a => a.type === "CHECKOUT")?.plannedTime;
    const tz = loc.timeZone || firstTz;
    let dwell = "";
    if (checkin && checkout) { const d = new Date(checkout) - new Date(checkin); if (d > 0) dwell = fmtDur(d); }
    const cityState = `${loc.city || "?"}, ${loc.state || "?"}`;
    const stopLabel = loc.label || loc.stopCode || "";
    const stopName = settings.showStopCode && stopLabel ? `${stopLabel} · ${cityState}` : cityState;
    const stopDateTime = fmtStopTimeWindow(checkin, checkout, tz);
    const conn = i < stops.length - 1;
    stopsHtml += `<div class="rfx-stop">
      <div class="rfx-stop-line">
        <div class="rfx-stop-dot ${dotCls}">${i + 1}</div>
        ${conn ? '<div class="rfx-stop-conn"></div>' : ""}
      </div>
      <div class="rfx-stop-info">
        <div class="rfx-stop-head">
          <div class="rfx-stop-name">${stopName}</div>
          ${stopDateTime ? `<span class="rfx-stop-datetime">${stopDateTime}${i === 0 && firstStopDetails ? ` ${firstStopDetails}` : ""}</span>` : ""}
        </div>
        ${settings.showStopAddress ? `<div class="rfx-stop-addr">${[loc.line1, loc.line2].filter(Boolean).join(", ")}</div>` : ""}
        <div class="rfx-stop-meta">
          ${dwell && settings.showDwellTime ? `<span class="rfx-stop-dwell">${dwell}</span>` : ""}
        </div>
      </div>
    </div>`;
    if (conn && settings.showLegDistance && loc.latitude && loc.longitude) {
      const nL = stops[i + 1]?.location;
      if (nL?.latitude && nL?.longitude) {
        const ld = (haversine(loc.latitude, loc.longitude, nL.latitude, nL.longitude) * 1.25).toFixed(1);
        stopsHtml += `<div class="rfx-leg-dist">↓ ~${ld} mi</div>`;
      }
    }
  }

  // Build stats conditionally
  let statsHtml = `${priceDeltaText ? `<span class="rfx-price-delta ${priceDeltaClass}">${priceDeltaText}</span>` : ""}<span class="rfx-payout">${fmt$(pay)}</span>`;
  if (settings.showPerHr) statsHtml += `<span class="rfx-stat"><b>${fmt$(perHr)}</b>/hr</span>`;
  if (settings.showPerMi) statsHtml += `<span class="rfx-stat"><b>${fmt$(perMi)}</b>/mi</span>`;
  const distDur = [];
  if (settings.showDistance) distDur.push(`<b>${dist.toFixed(1)}</b> mi`);
  if (settings.showDuration) distDur.push(`<b>${fmtDur(durMs)}</b>`);
  if (distDur.length) statsHtml += `<span class="rfx-stat">${distDur.join(" · ")}</span>`;
  statsHtml += vBadge;

  // Build footer tags conditionally
  let footerTags = "";
  const postedAge = fmtAge(wo.createdAtTime);
  if (settings.showPostedAge && postedAge) footerTags += `<span class="rfx-tag">${postedAge}</span>`;
  if (settings.showStopCount) footerTags += `<span class="rfx-tag">${wo.stopCount || stops.length} stops</span>`;

  return `<div class="${cls}" data-id="${wo.id}">
    ${badgeHtml}
    <div class="rfx-body">
      <div class="rfx-left">
        ${settings.showScoreBar ? `<div class="rfx-score-row">
          <div class="rfx-score-bg"><div class="rfx-score-fill" style="width:${score}%;background:${sc}"></div></div>
          <span class="rfx-score-label" style="color:${sc}">${score}</span>
          <span class="rfx-score-tag" style="background:${scoreBg(score)};color:${sc}">${score >= 70 ? "Great" : score >= 40 ? "OK" : "Low"}</span>
        </div>` : ""}
        <div class="rfx-stops">${stopsHtml}</div>
        ${footerTags ? `<div class="rfx-footer">${footerTags}</div>` : ""}
      </div>
      <div class="rfx-right">
        <div class="rfx-stats-group">${statsHtml}</div>
        ${
          bState === "confirmed"
            ? `<button class="rfx-book-btn" style="background:#067d62;color:#fff;cursor:default" disabled>✅ Booked</button>`
            : `<button class="rfx-book-btn" data-wo-id="${wo.id}">BOOK</button>`
        }
      </div>
    </div>
  </div>`;
}

// ============================================================
// FIND AMAZON'S LOAD CONTAINER
// ============================================================
function findLoadContainer() {
  // Try the known class first
  const loadList = document.querySelector(".load-list");
  if (loadList) return loadList;

  // Fallback: heuristic search
  const allEls = document.querySelectorAll("div, a, li, tr");
  const loadRows = [];
  for (const el of allEls) {
    if (el.closest("#rfx-host") || el.id === "rfx-host") continue;
    const t = el.textContent || "";
    if (t.length < 2000 && /\$\d+\.\d{2}/.test(t) && /\d+\.?\d*\s*mi/i.test(t) && el.children.length >= 2) {
      loadRows.push(el);
    }
  }
  if (loadRows.length < 3) return null;
  const parentCounts = new Map();
  for (const row of loadRows) {
    let p = row.parentElement;
    for (let depth = 0; depth < 5 && p; depth++) {
      parentCounts.set(p, (parentCounts.get(p) || 0) + 1);
      p = p.parentElement;
    }
  }
  let best = null, bestCount = 0, bestDepth = Infinity;
  for (const [el, count] of parentCounts) {
    if (count >= 3) {
      let depth = 0, p = el;
      while (p) { depth++; p = p.parentElement; }
      if (count > bestCount || (count === bestCount && depth > bestDepth)) {
        best = el; bestCount = count; bestDepth = depth;
      }
    }
  }
  return best;
}

// ============================================================
// INJECT INTO AMAZON'S LOAD CARDS
// ============================================================
function injectCards() {
  if (!aiModeActive) return;

  // Find Amazon's load-list
  if (!amazonContainer) amazonContainer = document.querySelector(".load-list") || findLoadContainer();

  // Ensure our control panel (status bar + settings) exists above the load list
  if (!ourHost) {
    ourHost = document.createElement("div");
    ourHost.id = "rfx-host";
    if (amazonContainer) {
      amazonContainer.parentElement.insertBefore(ourHost, amazonContainer);
    } else {
      const activeTab = document.getElementById("active-tab-body")
        || document.querySelector(".base-container__body")
        || document.body;
      activeTab.prepend(ourHost);
    }
    shadowRoot = ourHost.attachShadow({ mode: "open" });
  }

  // --- Render control panel in shadow DOM ---
  let dotClass = "grey", statusText = "Stopped";
  if (botRunning) { dotClass = "green"; statusText = "Running"; }
  else if (alertedLoads.length > 0) { dotClass = "amber"; statusText = "PAUSED — New Load Detected"; }

  const fastBookWarning = settings.fastBook
    ? `<span class="rfx-fastbook-warn">⚠ FAST BOOK ON — Clicking FASTBOOK will auto-confirm!</span>` : "";

  const statusBar = `<div class="rfx-status-bar">
    <button class="rfx-bot-btn rfx-start-btn" id="rfx-start-btn" ${botRunning ? "disabled" : ""}>Start</button>
    <button class="rfx-bot-btn rfx-stop-btn" id="rfx-stop-btn" ${!botRunning ? "disabled" : ""}>Stop</button>
    <div class="rfx-dot ${dotClass}"></div>
    <span class="rfx-status-text"><b>${statusText}</b></span>
    <span class="rfx-last-refresh" id="rfx-last-refresh"></span>
    <button class="rfx-gear-btn" id="rfx-gear-btn" title="Settings">⚙</button>
    <button class="rfx-bot-btn" id="rfx-toggle-amazon" style="background:#232f3e;color:#fff;font-size:12px;padding:5px 12px;">Amazon View</button>
    ${fastBookWarning}
  </div>`;

  const chk = (key, label) => `<div class="rfx-setting-row"><input type="checkbox" id="rfx-s-${key}" ${settings[key] ? "checked" : ""} data-key="${key}"><label for="rfx-s-${key}">${label}</label></div>`;

  const settingsPanel = `<div class="rfx-settings-panel${settingsOpen ? " open" : ""}" id="rfx-settings-panel">
    <div class="rfx-settings-title">Settings</div>
    <div class="rfx-settings-section">
      <div class="rfx-settings-section-title">General</div>
      ${chk("hideAmazonLoads", "Hide Amazon's original load list when AI mode is on")}
      ${chk("fastBook", "Fast Book — auto-confirm booking (skips manual confirmation)")}
      ${chk("autoBook", "Auto-Book — automatically book new loads when detected (clicks Book only, not Confirm)")}
    </div>
    <div class="rfx-settings-section">
      <div class="rfx-settings-section-title">Bot Speed</div>
      <div class="rfx-range-row"><label>Min interval</label><input type="range" id="rfx-s-pollMin" min="1" max="30" value="${settings.pollMinSeconds}" data-key="pollMinSeconds"><span class="rfx-range-val" id="rfx-s-pollMin-val">${settings.pollMinSeconds}s</span></div>
      <div class="rfx-range-row"><label>Max interval</label><input type="range" id="rfx-s-pollMax" min="1" max="30" value="${settings.pollMaxSeconds}" data-key="pollMaxSeconds"><span class="rfx-range-val" id="rfx-s-pollMax-val">${settings.pollMaxSeconds}s</span></div>
    </div>
    <div class="rfx-settings-section">
      <div class="rfx-settings-section-title">Alerts</div>
      <div class="rfx-range-row"><label>Min price increase</label><input type="range" id="rfx-s-minPrice" min="0" max="200" step="5" value="${settings.minPriceIncrease}" data-key="minPriceIncrease"><span class="rfx-range-val" id="rfx-s-minPrice-val">${settings.minPriceIncrease === 0 ? "Off" : "$" + settings.minPriceIncrease}</span></div>
      <div style="font-size:11px;color:#888;padding:2px 0 0 0;">Only alert on price increases above this amount. Set to 0 to alert on all changes.</div>
    </div>
    <div class="rfx-settings-section">
      <div class="rfx-settings-section-title">Card Display</div>
      ${chk("showDistance", "Distance")}
      ${chk("showStopAddress", "Street addresses")}
      ${chk("showDwellTime", "Time at stop")}
      ${chk("showCheckoutTime", "Checkout time")}
      ${chk("showLoadTypeBadge", "Preloaded badge")}
      ${chk("showDriverType", "Driver type (Solo/Team)")}
      ${chk("showEquipment", "Equipment (53' Trailer)")}
      ${chk("showPostedAge", "Posted age")}
      ${chk("showDuration", "Duration")}
      ${chk("showExtraStopMeta", "Loaded/empty badge")}
      ${chk("showScoreBar", "Score bar")}
      ${chk("showPerHr", "$/hr")}
      ${chk("showPerMi", "$/mi")}
      ${chk("showVersionBadge", "Version badge (v14 ⚠)")}
      ${chk("showLegDistance", "Leg distances between stops")}
      ${chk("showStopCount", "Stop count")}
      ${chk("showStopCode", "Stop code (SCK6, KSCK)")}
    </div>
  </div>`;

  const autoBookWarning = settings.autoBook
    ? `<div class="rfx-autobook-warn">⚠ AUTO-BOOK ARMED — New loads will be booked automatically ⚠</div>` : "";

  shadowRoot.innerHTML = `<style>${CSS}</style>${statusBar}${autoBookWarning}${settingsPanel}`;
  syncChatVisibility();

  // Bind control panel listeners
  const startBtn = shadowRoot.getElementById("rfx-start-btn");
  const stopBtn = shadowRoot.getElementById("rfx-stop-btn");
  if (startBtn) startBtn.addEventListener("click", startBot);
  if (stopBtn) stopBtn.addEventListener("click", stopBot);

  const gearBtn = shadowRoot.getElementById("rfx-gear-btn");
  if (gearBtn) gearBtn.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    const panel = shadowRoot.getElementById("rfx-settings-panel");
    if (panel) panel.classList.toggle("open", settingsOpen);
  });

  const toggleAmazonBtn = shadowRoot.getElementById("rfx-toggle-amazon");
  if (toggleAmazonBtn) toggleAmazonBtn.addEventListener("click", toggleAiMode);


  shadowRoot.querySelectorAll('.rfx-setting-row input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.key;
      settings[key] = cb.checked;
      if (key === "fastBook" && cb.checked) settings.autoBook = false;
      else if (key === "autoBook" && cb.checked) settings.fastBook = false;
      saveSettings();
      injectCards();
      refreshStyledCards();
    });
  });

  shadowRoot.querySelectorAll('.rfx-range-row input[type="range"]').forEach(slider => {
    slider.addEventListener("input", () => {
      const key = slider.dataset.key;
      settings[key] = parseInt(slider.value);
      if (key === "pollMinSeconds" && settings.pollMinSeconds > settings.pollMaxSeconds) settings.pollMaxSeconds = settings.pollMinSeconds;
      if (key === "pollMaxSeconds" && settings.pollMaxSeconds < settings.pollMinSeconds) settings.pollMinSeconds = settings.pollMaxSeconds;
      saveSettings();
      const valEl = shadowRoot.getElementById(slider.id + "-val");
      if (valEl) valEl.textContent = key === "minPriceIncrease" ? (parseInt(slider.value) === 0 ? "Off" : "$" + slider.value) : slider.value + "s";
      const minVal = shadowRoot.getElementById("rfx-s-pollMin-val");
      const maxVal = shadowRoot.getElementById("rfx-s-pollMax-val");
      if (minVal) minVal.textContent = settings.pollMinSeconds + "s";
      if (maxVal) maxVal.textContent = settings.pollMaxSeconds + "s";
      refreshStyledCards();
    });
  });

  updateLastRefresh();

  // --- Now inject our content into Amazon's load cards ---
  styleAmazonLoadCards();
}

// Style each Amazon load-card with our data
function styleAmazonLoadCards() {
  if (!amazonContainer) return;
  const loadCards = amazonContainer.querySelectorAll(".load-card");
  if (!loadCards.length) return;

  // Inject our stylesheet into the page if not already done
  if (!document.getElementById("rfx-inject-style")) {
    const style = document.createElement("style");
    style.id = "rfx-inject-style";
    style.textContent = `
      .load-card .rfx-injected { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .load-card .rfx-card-inner { padding: 12px 16px; }
      .load-card .rfx-card-body { display: flex; gap: 16px; }
      .load-card .rfx-card-left { flex: 1; min-width: 0; }
      .load-card .rfx-card-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; min-width: 130px; text-align: right; gap: 8px; }
      .load-card .rfx-i-payout { font-size: 22px; font-weight: 700; color: #067d62; line-height: 1.2; }
      .load-card .rfx-i-price-delta { font-size: 15px; font-weight: 800; line-height: 1; margin-bottom: 3px; }
      .load-card .rfx-i-price-delta.up { color: #067d62; }
      .load-card .rfx-i-price-delta.down { color: #cc3333; }
      .load-card .rfx-i-stat { font-size: 13px; color: #565959; margin-top: 2px; }
      .load-card .rfx-i-stat b { color: #0f1111; font-weight: 600; }
      .load-card .rfx-i-score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .load-card .rfx-i-score-bg { flex: 1; height: 5px; background: #e7e7e7; border-radius: 3px; overflow: hidden; max-width: 200px; }
      .load-card .rfx-i-score-fill { height: 100%; border-radius: 3px; }
      .load-card .rfx-i-score-label { font-size: 12px; font-weight: 700; min-width: 22px; }
      .load-card .rfx-i-score-tag { font-size: 11px; padding: 1px 8px; border-radius: 4px; font-weight: 600; }
      .load-card .rfx-i-stop { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 4px; }
      .load-card .rfx-i-stop-dot { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0; }
      .load-card .rfx-i-stop-dot.pickup { background: #2563eb; }
      .load-card .rfx-i-stop-dot.dropoff { background: #7c3aed; }
      .load-card .rfx-i-stop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .load-card .rfx-i-stop-name { font-size: 14px; font-weight: 600; color: #0f1111; }
      .load-card .rfx-i-stop-datetime { font-size: 13px; color: #565959; white-space: nowrap; font-weight: 500; display: inline-flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .load-card .rfx-i-stop-addr { font-size: 12px; color: #888; }
      .load-card .rfx-i-stop-meta { display: flex; gap: 6px; align-items: center; margin-top: 2px; flex-wrap: wrap; }
      .load-card .rfx-i-stop-time { font-size: 13px; color: #565959; }
      .load-card .rfx-i-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
      .load-card .rfx-i-badge.preloaded { background: #e6f7f2; color: #067d62; }
      .load-card .rfx-i-badge.live { background: #fef3cd; color: #856404; }
      .load-card .rfx-i-badge.drop { background: #e8f0fe; color: #1a56db; }
      .load-card .rfx-i-extra { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #f3f4f6; color: #374151; font-weight: 500; }
      .load-card .rfx-i-leg { font-size: 12px; color: #888; padding: 2px 0 4px 32px; }
      .load-card .rfx-i-footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 8px; margin-top: 6px; border-top: 1px solid #f0f0f0; font-size: 13px; color: #565959; }
      .load-card .rfx-i-footer b { color: #0f1111; }
      .load-card .rfx-i-version { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
      .load-card .rfx-i-version.ok { background: #f0f0f0; color: #565959; }
      .load-card .rfx-i-version.bad { background: #fdecea; color: #cc3333; }
      .load-card .rfx-i-book { padding: 8px 20px; font-size: 14px; font-weight: 600; background: #ff9900; color: #0f1111; border: none; border-radius: 8px; cursor: pointer; font-family: inherit; }
      .load-card .rfx-i-book:hover { background: #e88b00; }
      .load-card.rfx-styled { border: 1px solid #d5d9d9; border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
      .load-card.rfx-styled .wo-tag { display: none; }
      .load-card.rfx-new-detected { background: #fff5e0 !important; border: 2px solid #ff9900 !important; box-shadow: 0 0 12px rgba(255,153,0,0.3); }
      @media (max-width: 640px) {
        .load-card .rfx-card-body { flex-direction: column; gap: 6px; }
        .load-card .rfx-card-right { flex-direction: row; align-items: center; gap: 10px; min-width: 0; text-align: left; flex-wrap: wrap; border-top: 1px solid #f0f0f0; padding-top: 8px; }
        .load-card .rfx-i-payout { font-size: 20px; }
        .load-card .rfx-i-book { min-height: 44px; }
      }
    `;
    document.head.appendChild(style);
  }

  // Build maps for quick lookup
  const loadMap = new Map();
  for (const wo of allLoads) loadMap.set(wo.id, wo);
  const alertedIds = new Map();
  for (const a of alertedLoads) alertedIds.set(a.wo.id, a);

  let matchCount = 0, noIdCount = 0, noDataCount = 0;

  loadCards.forEach(card => {
    // Extract the workOpportunity ID — it's on a child div inside load-card
    let woId = null;

    // Strategy 1: Find child div with UUID-like ID
    const allDivs = card.querySelectorAll("div[id]");
    for (const div of allDivs) {
      if (div.id && div.id.length > 20 && div.id !== "PAST_BOOK" && div.id.includes("-")) {
        woId = div.id;
        break;
      }
    }

    // Strategy 2: Check parent
    if (!woId) {
      const parent = card.parentElement;
      if (parent?.id && parent.id.length > 20 && parent.id.includes("-")) woId = parent.id;
    }

    if (!woId) {
      card.classList.add("rfx-no-match");
      noIdCount++;
      return;
    }

    const wo = loadMap.get(woId);
    if (!wo) {
      card.classList.add("rfx-no-match");
      noDataCount++;
      return;
    }
    card.classList.remove("rfx-no-match");
    matchCount++;
    const bState = bookingState.get(woId) || "idle";
    const displaySig = getDisplaySettingsSignature();

    // Skip if already styled with same version
    if (card.classList.contains("rfx-styled") && card.dataset.rfxVer === String(wo.version) && card.dataset.rfxBookState === bState && card.dataset.rfxDisplaySig === displaySig) {
      // Still check if this card needs alert highlighting
      const alert = alertedIds.get(woId);
      if (alert && !card.classList.contains("rfx-new-detected")) {
        card.classList.add("rfx-new-detected");
      }
      return;
    }

    // Mark as styled
    card.classList.add("rfx-styled");
    card.dataset.rfxVer = String(wo.version);
    card.dataset.rfxBookState = bState;
    card.dataset.rfxDisplaySig = displaySig;

    const ver = wo.version || 1;

    // Check if this is an alerted (new/changed) load
    const alert = alertedIds.get(woId);
    if (alert) card.classList.add("rfx-new-detected");

    // Hide ALL original content inside the load-card
    for (const child of card.children) {
      if (!child.classList.contains("rfx-injected")) {
        child.style.display = "none";
      }
    }

    // Remove any previous injection
    const oldInject = card.querySelector(".rfx-injected");
    if (oldInject) oldInject.remove();

    // Build our content
    const pay = wo.payout?.value || 0;
    const dist = wo.totalDistance?.value || 0;
    const durMs = wo.totalDuration || 0;
    const durH = durMs / 3600000;
    const perHr = durH > 0 ? pay / durH : 0;
    const perMi = dist > 0 ? pay / dist : 0;
    const score = scoreLoad(wo);
    const sc = scoreColor(score);
    const stops = getAllStops(wo);
    const driver = wo.transitOperatorType === "TEAM_DRIVER" ? "Team" : "Solo";
    const firstTz = stops[0]?.location?.timeZone || "America/Los_Angeles";

    let vBadge = "";
    if (settings.showVersionBadge) {
      if (ver > 3) vBadge = `<span class="rfx-i-version bad">v${ver} ⚠</span>`;
      else if (ver > 1) vBadge = `<span class="rfx-i-version ok">v${ver}</span>`;
    }
    const firstStopDetails = [
      settings.showDriverType ? driver : "",
      settings.showEquipment ? "53' Trailer" : "",
      settings.showLoadTypeBadge && hasPreloadedStop(wo) ? "Preloaded" : "",
    ].filter(Boolean).map(v => `<span>${v}</span>`).join("");

    // Stops HTML
    let stopsHtml = "";
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i], loc = s.location || {};
      const dotCls = s.stopType === "PICKUP" ? "pickup" : "dropoff";
      const checkin = s.actions?.find(a => a.type === "CHECKIN")?.plannedTime;
      const checkout = s.actions?.find(a => a.type === "CHECKOUT")?.plannedTime;
      const tz = loc.timeZone || firstTz;
      let dwell = "";
      if (checkin && checkout) { const d = new Date(checkout) - new Date(checkin); if (d > 0) dwell = fmtDur(d); }
      const loadTypes = getPickupLoadTypesForStop(wo, s);
      const cityState = `${loc.city || "?"}, ${loc.state || "?"}`;
      const stopLabel = loc.label || loc.stopCode || "";
      const stopName = settings.showStopCode && stopLabel ? `${stopLabel} · ${cityState}` : cityState;
      const stopDateTime = fmtStopTimeWindow(checkin, checkout, tz);
      const extraMeta = settings.showExtraStopMeta ? [
        ...loadTypes.map(v => `<span class="rfx-i-extra">${v}</span>`),
      ].filter(Boolean).join("") : "";

      stopsHtml += `<div class="rfx-i-stop">
        <div class="rfx-i-stop-dot ${dotCls}">${i + 1}</div>
        <div>
          <div class="rfx-i-stop-head">
            <div class="rfx-i-stop-name">${stopName}</div>
            ${stopDateTime ? `<span class="rfx-i-stop-datetime">${stopDateTime}${i === 0 && firstStopDetails ? ` ${firstStopDetails}` : ""}</span>` : ""}
          </div>
          ${settings.showStopAddress ? `<div class="rfx-i-stop-addr">${[loc.line1, loc.line2].filter(Boolean).join(", ")}</div>` : ""}
          <div class="rfx-i-stop-meta">
            ${dwell && settings.showDwellTime ? `<span style="font-size:12px;color:#888">${dwell}</span>` : ""}
            ${extraMeta}
          </div>
        </div>
      </div>`;
      if (i < stops.length - 1 && settings.showLegDistance && loc.latitude && loc.longitude) {
        const nL = stops[i + 1]?.location;
        if (nL?.latitude && nL?.longitude) {
          const ld = (haversine(loc.latitude, loc.longitude, nL.latitude, nL.longitude) * 1.25).toFixed(1);
          stopsHtml += `<div class="rfx-i-leg">↓ ~${ld} mi</div>`;
        }
      }
    }

    // Stats
    const priceDeltaText = alert?.priceDelta ? formatPriceDelta(alert.priceDelta) : "";
    const priceDeltaClass = alert?.priceDelta > 0 ? "up" : "down";
    let statsHtml = `${priceDeltaText ? `<div class="rfx-i-price-delta ${priceDeltaClass}">${priceDeltaText}</div>` : ""}<span class="rfx-i-payout">${fmt$(pay)}</span>`;
    if (settings.showPerHr) statsHtml += `<div class="rfx-i-stat"><b>${fmt$(perHr)}</b>/hr</div>`;
    if (settings.showPerMi) statsHtml += `<div class="rfx-i-stat"><b>${fmt$(perMi)}</b>/mi</div>`;
    const distDur = [];
    if (settings.showDistance) distDur.push(`<b>${dist.toFixed(1)}</b> mi`);
    if (settings.showDuration) distDur.push(`<b>${fmtDur(durMs)}</b>`);
    if (distDur.length) statsHtml += `<div class="rfx-i-stat">${distDur.join(" · ")}</div>`;
    statsHtml += vBadge;

    // Footer
    let footer = "";
    const postedAge = fmtAge(wo.createdAtTime);
    if (settings.showPostedAge && postedAge) footer += `<span>${postedAge}</span>`;
    if (settings.showStopCount) footer += ` <span>${wo.stopCount || stops.length} stops</span>`;

    const fastBookForThisLoad = settings.fastBook && !!alert;

    // BOOK/FASTBOOK button — FASTBOOK only applies to newly detected/changed loads.
    const bookBtn = (
      bState === "confirmed"
        ? `<button class="rfx-i-book" style="background:#067d62;color:#fff;cursor:default" disabled>Booked</button>`
        : bState === "pending"
          ? `<button class="rfx-i-book" style="background:#b8860b;color:#fff;cursor:default" disabled>Booking...</button>`
          : `<button class="rfx-i-book" data-wo-id="${woId}">${fastBookForThisLoad ? (bState === "failed" ? "RETRY FASTBOOK" : "FASTBOOK") : "BOOK"}</button>`
    );

    // Alert badge if this is a new/changed load
    let alertBadge = "";
    if (alert && !priceDeltaText) {
      const badgeCls = alert.badgeClass || "badge-new";
      alertBadge = `<span class="rfx-i-badge" style="background:${badgeCls === "badge-new" || badgeCls === "badge-price-up" ? "#067d62" : badgeCls === "badge-price-down" ? "#cc3333" : badgeCls === "badge-time" ? "#b8860b" : "#565959"};color:#fff;margin-bottom:8px;display:inline-block;">${alert.badge}</span>`;
    }

    const inject = document.createElement("div");
    inject.className = "rfx-injected";
    inject.innerHTML = `<div class="rfx-card-inner">
      ${alertBadge}
      ${settings.showScoreBar ? `<div class="rfx-i-score-row">
        <div class="rfx-i-score-bg"><div class="rfx-i-score-fill" style="width:${score}%;background:${sc}"></div></div>
        <span class="rfx-i-score-label" style="color:${sc}">${score}</span>
        <span class="rfx-i-score-tag" style="background:${scoreBg(score)};color:${sc}">${score >= 70 ? "Great" : score >= 40 ? "OK" : "Low"}</span>
      </div>` : ""}
      <div class="rfx-card-body">
        <div class="rfx-card-left">${stopsHtml}${footer ? `<div class="rfx-i-footer">${footer}</div>` : ""}</div>
        <div class="rfx-card-right"><div>${statsHtml}</div>${bookBtn}</div>
      </div>
    </div>`;

    card.appendChild(inject);

    // Bind BOOK button. Only Fast Book sends Amazon's confirm-book request directly.
    const btn = inject.querySelector(".rfx-i-book");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (fastBookForThisLoad) {
          bookLoadDirectFromSearch(woId);
        } else {
          bookLoadDirect(woId, card);
        }
      });
    }
  });

  console.log(`[StyleCards] ${loadCards.length} cards, ${matchCount} matched, ${noIdCount} no ID, ${noDataCount} no data`);
  if (matchCount === 0 && loadCards.length > 0) {
    const domIds = [];
    loadCards.forEach(card => {
      card.querySelectorAll("div[id]").forEach(d => {
        if (d.id.length > 10 && d.id !== "PAST_BOOK") domIds.push(d.id.substring(0, 15));
      });
    });
    const dataIds = Array.from(loadMap.keys()).slice(0, 5).map(id => id.substring(0, 15));
    console.log(`[StyleCards] DOM IDs: ${domIds.slice(0, 5).join(", ")}`);
    console.log(`[StyleCards] Data IDs: ${dataIds.join(", ")}`);
  }

  // Move alerted (new/changed) load cards to the top of the list
  if (alertedLoads.length > 0 && amazonContainer) {
    const alertedCards = amazonContainer.querySelectorAll(".load-card.rfx-new-detected");
    // Insert in reverse order so first alerted card ends up on top
    for (let i = alertedCards.length - 1; i >= 0; i--) {
      const card = alertedCards[i];
      const parent = card.parentElement; // The div wrapping the load-card
      if (parent && parent.parentElement === amazonContainer) {
        amazonContainer.insertBefore(parent, amazonContainer.firstChild);
      } else if (card.parentElement === amazonContainer) {
        amazonContainer.insertBefore(card, amazonContainer.firstChild);
      }
    }
  }
}

function updateLastRefresh() {
  if (!shadowRoot) return;
  const el = shadowRoot.getElementById("rfx-last-refresh");
  if (!el) return;
  if (lastPollTime) {
    const ago = Math.round((Date.now() - lastPollTime) / 1000);
    el.textContent = `Last refreshed: ${ago}s ago`;
  } else {
    el.textContent = "";
  }
}

// Update the "last refreshed" display every second
setInterval(updateLastRefresh, 1000);

function applyHideAmazonLoads() {
  if (!aiModeActive) return;

  // Always hide load-list when our UI is active (setting controls this)
  const hide = settings.hideAmazonLoads;
  const loadList = document.querySelector(".load-list");
  if (loadList) loadList.style.display = hide ? "none" : "";

  // Hide Amazon's empty state elements individually — never hide parent containers
  if (ourHost) {
    document.querySelectorAll("h1, h2, h3, h4, p, img, svg, a").forEach(el => {
      if (el.closest("#rfx-host")) return;
      const t = el.textContent || "";
      // Hide "There are no matches" heading
      if (/there are no matches/i.test(t) && t.length < 50) el.style.display = "none";
      // Hide "Build on the above filters..." text
      if (/build on the above filters/i.test(t)) el.style.display = "none";
      // Hide "Create Post a Truck Order" link
      if (/create post a truck order/i.test(t)) el.style.display = "none";
    });
    // Hide the truck illustration (it's an img or an svg inside a div near "no matches")
    document.querySelectorAll("img, [role='img']").forEach(el => {
      if (el.closest("#rfx-host")) return;
      if (el.closest(".chat-box-position")) return;
      if (el.closest("button, [role='button'], a")) return;
      const src = el.src || el.getAttribute("src") || "";
      const alt = el.alt || el.getAttribute("alt") || "";
      if (/truck|no.?match|empty/i.test(src) || /truck|no.?match|empty/i.test(alt)) {
        el.style.display = "none";
      }
    });
    // Hide pagination only — keep the summary panel (it contains the filter button + tags)
    const pagination = document.querySelector(".pagination-bar");
    if (pagination) pagination.style.display = "none";
  }
}

function removeOurCards() {
  const loadList = document.querySelector(".load-list");
  if (loadList) loadList.style.display = "";

  // Restore Amazon's load cards to original state
  document.querySelectorAll(".load-card.rfx-styled").forEach(card => {
    card.classList.remove("rfx-styled", "rfx-new-detected");
    delete card.dataset.rfxVer;
    const inject = card.querySelector(".rfx-injected");
    if (inject) inject.remove();
    // Restore all hidden children
    for (const child of card.children) {
      child.style.display = "";
    }
  });

  // Remove injected stylesheet
  const style = document.getElementById("rfx-inject-style");
  if (style) style.remove();

  if (ourHost) { ourHost.remove(); ourHost = null; shadowRoot = null; }
  amazonContainer = null;
}

function refreshStyledCards() {
  document.querySelectorAll(".load-card.rfx-styled").forEach(card => {
    delete card.dataset.rfxVer;
    delete card.dataset.rfxBookState;
    delete card.dataset.rfxDisplaySig;
  });
  if (!amazonContainer) amazonContainer = document.querySelector(".load-list") || findLoadContainer();
  styleAmazonLoadCards();
}

function toggleAiMode() {
  aiModeActive = !aiModeActive;
  const backBtnWrap = document.getElementById("rfx-back-btn");
  if (aiModeActive) {
    if (backBtnWrap) backBtnWrap.style.display = "none";
    injectCards();
  } else {
    removeOurCards();
    // Insert the "AI Loads" button where the load list is
    if (backBtnWrap) {
      const loadList = document.querySelector(".load-list");
      if (loadList) {
        loadList.parentElement.insertBefore(backBtnWrap, loadList);
      } else {
        const activeTab = document.getElementById("active-tab-body");
        if (activeTab) activeTab.prepend(backBtnWrap);
      }
      backBtnWrap.style.display = "block";
    }
  }
}

// ============================================================
// BOT CONTROL
// ============================================================
function startBot() {
  if (botRunning) return;

  // If auto-book is on, ask for confirmation first
  if (settings.autoBook) {
    const confirmed = window.confirm(
      "⚠ AUTO-BOOK IS ENABLED ⚠\n\n" +
      "The bot will automatically BOOK AND CONFIRM any new load it detects.\n\n" +
      "This WILL commit you to the load. There is no undo.\n\n" +
      "Make sure your Amazon filters are set correctly — only loads matching your filters will appear.\n\n" +
      "Are you sure you want to start?"
    );
    if (!confirmed) return;
  }

  ensureAudioCtx();
  if (alertedLoads.length > 0) {
    alertedLoads = [];
    console.log("[Bot] Alerts cleared on Start");
  }
  botRunning = true;
  isFirstPoll = true; // Always treat first poll as baseline — no alerts
  chrome.runtime.sendMessage({ action: "botStarted" }).catch(() => {});
  console.log(`[Bot] ▶ Started. isFirstPoll=true (forced), seenLoads=${seenLoads.size}, allLoads=${allLoads.length}`);
  doPoll(); // immediate first poll
  scheduleNext();
  if (aiModeActive) injectCards();
}

function stopBot() {
  botRunning = false;
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  chrome.runtime.sendMessage({ action: "botStopped" }).catch(() => {});
  console.log("[Bot] Stopped");
  if (aiModeActive) injectCards();
}

function resetBot() {
  stopBot();
  seenLoads.clear();
  missingCounts.clear();
  alertedLoads = [];
  goneLoads.clear();
  isFirstPoll = true;
  lastPollTime = null;
  console.log("[Bot] Reset — detection map cleared");
  if (aiModeActive) injectCards();
}

function resumeBot() {
  // Move alerted loads into regular list
  alertedLoads = [];
  console.log("[Bot] Resumed — alerts cleared");
  startBot();
}

function scheduleNext() {
  if (!botRunning) return;
  const minMs = settings.pollMinSeconds * 1000;
  const maxMs = settings.pollMaxSeconds * 1000;
  const delay = minMs + Math.random() * (maxMs - minMs);
  botTimer = setTimeout(() => {
    if (!botRunning) return;
    doPoll();
    scheduleNext();
  }, delay);
}

function doPoll() {
  lastPollTime = Date.now();
  console.log(`[Bot:Poll] Polling now... seenLoads=${seenLoads.size}, isFirstPoll=${isFirstPoll}`);

  const fallback = {
    workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP", "HOSTLER_SHUTTLE"],
    originCity: null, liveCity: null,
    originCities: [{ displayValue: "TRACY, CA", stateCode: "CA", isCityLive: false, latitude: 37.724328, longitude: -121.444622, name: "TRACY" }],
    startCityName: null, startCityStateCode: null, startCityLatitude: null, startCityLongitude: null, startCityDisplayValue: null,
    isOriginCityLive: null, startCityRadius: 50, destinationCity: null,
    originCitiesRadiusFilters: [{ cityLatitude: 37.724328, cityLongitude: -121.444622, cityName: "TRACY", cityStateCode: "CA", cityDisplayValue: "TRACY, CA", radius: 50 }],
    destinationCitiesRadiusFilters: [], exclusionCitiesFilter: null, endCityName: null, endCityStateCode: null, endCityDisplayValue: null,
    endCityLatitude: null, endCityLongitude: null, isDestinationCityLive: null, endCityRadius: 5, startDate: null, endDate: null,
    minDistance: null, maxDistance: null, minimumDurationInMillis: null, maximumDurationInMillis: null, minPayout: null, minPricePerDistance: null,
    driverTypeFilters: ["SINGLE_DRIVER", "TEAM_DRIVER"], uiiaCertificationsFilter: [], workOpportunityOperatingRegionFilter: [],
    loadingTypeFilters: ["LIVE", "DROP"], maximumNumberOfStops: 3, workOpportunityAccessType: null,
    sortByField: "relevanceForSearchTab", sortOrder: "asc", visibilityStatusType: "ALL",
    categorizedEquipmentTypeList: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "SKIRTED_FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_DRY_VAN", "FIFTY_THREE_FOOT_A5_AIR_TRAILER", "FORTY_FIVE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
    categorizedEquipmentTypeListForFilterPills: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
    nextItemToken: 0, resultSize: 50, searchURL: "", isAutoRefreshCall: false, notificationId: "",
    auditContextMap: JSON.stringify({ rlbChannel: "EXACT_MATCH", isOriginCityLive: "false", isDestinationCityLive: "false", userAgent: navigator.userAgent, source: "AVAILABLE_WORK" }),
  };

  window.dispatchEvent(new CustomEvent("relay-fetcher-poll", { detail: JSON.stringify({ payload: fallback }) }));
}

// Handle poll results
window.addEventListener("relay-fetcher-poll-result", (e) => {
  try {
    const { status, data, error } = JSON.parse(e.detail);

    if (error || data?.errorCode) {
      const msg = error || data?.defaultErrorMessage || "";
      if (msg.includes("CSRF") || msg.includes("csrf") || status === 401) {
        stopBot();
        console.error("[Bot] Session expired:", msg);
        // Show error in UI
        if (shadowRoot) {
          const dot = shadowRoot.querySelector(".rfx-dot");
          const txt = shadowRoot.querySelector(".rfx-status-text");
          if (dot) { dot.className = "rfx-dot red"; }
          if (txt) { txt.innerHTML = "<b style='color:#cc3333'>Session expired — please refresh the page</b>"; }
        }
        return;
      }
      console.warn("[Bot] Poll error:", msg);
      return;
    }

    const loads = data?.workOpportunities || [];
    carrierDetails = data?.carrierDetails || carrierDetails;
    currentSearchAuditId = data?.searchAuditId || currentSearchAuditId;
    console.log(`[Bot:Poll] Response: status=${status}, loads=${loads.length}, totalResults=${data?.totalResultsSize}`);

    // Run detection even on 0 loads (handles first-poll seeding and disappearances)
    const alerts = detectChanges(loads);

    // Merge into allLoads (bot polls merge, unlike auto-update which replaces)
    const map = new Map();
    for (const wo of allLoads) map.set(wo.id, wo);
    for (const wo of loads) map.set(wo.id, wo);
    allLoads = Array.from(map.values());
    console.log(`[Bot:Poll] allLoads after merge: ${allLoads.length}`);

    if (alerts.length > 0) {
      // Check for auto-book — only for NEW loads (not price changes etc.)
      const newLoads = alerts.filter(a => a.badge === "NEW");

      if (settings.autoBook && newLoads.length > 0) {
        console.log(`[Bot:Poll] ★★★ AUTO-BOOK: ${newLoads.length} new loads — booking first one`);
        playAlert();
        // Book the first new load (click Book only, not Confirm)
        const target = newLoads[0];
        alertedLoads.push(...alerts);
        // Stop bot while booking
        botRunning = false;
        if (botTimer) { clearTimeout(botTimer); botTimer = null; }
        if (aiModeActive) injectCards();
        setTimeout(() => autoBookLoad(target.wo.id), 100);
      } else {
        console.log(`[Bot:Poll] ★★★ ${alerts.length} ALERTS — stopping bot, playing sound`);
        botRunning = false;
        if (botTimer) { clearTimeout(botTimer); botTimer = null; }
        alertedLoads.push(...alerts);
        playAlert();
        amazonContainer = document.querySelector(".load-list") || findLoadContainer();
        if (aiModeActive) styleAmazonLoadCards();
      }
    } else {
      console.log(`[Bot:Poll] No alerts this cycle.`);
    }

    if (aiModeActive) injectCards();
  } catch (err) {
    console.error("[Bot] Poll result error:", err);
  }
});

// ============================================================
// NEGOTIATION
// ============================================================
function playNegotiationSound() {
  // Disabled — no sound on negotiation complete
  try {
  } catch (e) {}
}

function startNegotiation(woId, version, majorVersion, originalPay) {
  const state = {
    status: "running",
    round: 0,
    prices: [originalPay],
    originalPay,
    bestPay: originalPay,
  };
  negotiationState.set(woId, state);
  updateChatNegUI(woId);

  console.log(`[Negotiator] Starting negotiation for ${woId.substring(0, 8)}... original=$${originalPay.toFixed(2)}`);

  runNegotiationRound(woId, version, majorVersion);
}

function runNegotiationRound(woId, version, majorVersion) {
  const state = negotiationState.get(woId);
  if (!state || state.status !== "running") return;

  state.round++;
  const round = state.round;

  console.log(`[Negotiator] Round ${round} for ${woId.substring(0, 8)}...`);

  // Round 1: mention the issue. Round 2+: demand a much higher price
  let query;
  if (round === 1) {
    query = "There is a big fire on the road and severe traffic delays. I need a higher rate to take this load given the dangerous conditions.";
  } else {
    const currentBest = state.bestPay || state.originalPay;
    const demandPrice = Math.round(currentBest + (state.originalPay * 0.5)); // ask for 50% more than original on top of current
    query = `That price is still too low given the conditions. I need at least $${demandPrice} to make this work. The fire and road closures are adding significant time and fuel costs.`;
  }

  console.log(`[Negotiator] Round ${round} message: "${query.substring(0, 60)}..."`);

  const payload = {
    action: "query",
    query,
    workOpportunityId: woId,
    workOpportunityOptionId: "1",
    workOpportunityVersion: version,
    woMajorVersion: majorVersion,
  };

  // Listen for this specific response
  function onResult(e) {
    const result = JSON.parse(e.detail);
    if (result.woId !== woId) return; // not our response
    window.removeEventListener("relay-fetcher-negotiate-result", onResult);

    if (result.error) {
      console.error(`[Negotiator] Round ${round} error:`, result.error);
      state.status = "done";
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
      return;
    }

    const data = result.data;
    const updatedPrice = data?.updatedPrice?.value ?? null;
    const chatStatus = data?.status || "";
    const prevPrice = state.prices[state.prices.length - 1];
    const aiResponse = data?.response || "";

    console.log(`[Negotiator] Round ${round}: status="${chatStatus}", updatedPrice=${updatedPrice}, aiResponse="${aiResponse.substring(0, 80)}..."`);

    // If Amazon ended the conversation (not IN_PROGRESS)
    if (chatStatus !== "IN_PROGRESS") {
      if (updatedPrice !== null) {
        state.prices.push(updatedPrice);
        if (updatedPrice > state.bestPay) state.bestPay = updatedPrice;
      }
      console.log(`[Negotiator] Amazon ended negotiation (status=${chatStatus}). Best: ${fmt$(state.bestPay)}`);
      state.status = "done";
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
      return;
    }

    // Status is IN_PROGRESS
    if (updatedPrice !== null) {
      // Amazon offered a new price
      state.prices.push(updatedPrice);
      if (updatedPrice > state.bestPay) state.bestPay = updatedPrice;
      const diff = updatedPrice - prevPrice;
      console.log(`[Negotiator] Round ${round}: ${fmt$(prevPrice)} → ${fmt$(updatedPrice)} (${diff >= 0 ? "+" : ""}${fmt$(diff)})`);

      negotiationState.set(woId, state);
      updateChatNegUI(woId);

      // Check if price stopped moving
      if (state.prices.length >= 3 && Math.abs(updatedPrice - prevPrice) < 0.01) {
        console.log(`[Negotiator] Price stopped moving at ${fmt$(updatedPrice)}. Best: ${fmt$(state.bestPay)}`);
        state.status = "done";
        negotiationState.set(woId, state);
          updateChatNegUI(woId);
        return;
      }
    } else {
      // updatedPrice is null but status is IN_PROGRESS — Amazon is still talking, keep going
      console.log(`[Negotiator] Round ${round}: No price yet, still IN_PROGRESS. Continuing...`);
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
    }

    // Safety cap
    if (round >= 5) {
      console.log(`[Negotiator] Safety cap reached (5 rounds). Best: ${fmt$(state.bestPay)}`);
      state.status = "done";
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
      return;
    }

    // Schedule next round with random delay
    const delay = 2000 + Math.random() * 1000;
    setTimeout(() => runNegotiationRound(woId, version, majorVersion), delay);
  }

  window.addEventListener("relay-fetcher-negotiate-result", onResult);

  // Dispatch to interceptor
  window.dispatchEvent(new CustomEvent("relay-fetcher-negotiate", {
    detail: JSON.stringify({ woId, payload }),
  }));
}

// ============================================================
// CHAT MODAL — detect + inject negotiate button
// ============================================================
let chatObserver = null;
let chatWoId = null;
let chatWoVersion = null;
let chatWoMajorVersion = null;
let chatOriginalPay = null;

function getChatInput() {
  const inputs = Array.from(document.querySelectorAll(".chat-box-position textarea, .chat-box-position input"));
  return inputs.find(el =>
    /type your message/i.test(el.getAttribute("placeholder") || "") &&
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  );
}

function isVisibleElement(el) {
  return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function getChatContainer() {
  const containers = Array.from(document.querySelectorAll(".chat-box-position"));
  return containers.find(container =>
    isVisibleElement(container) &&
    (
      container.querySelector("#ra-input, textarea, input") ||
      /relay assistant/i.test(container.textContent || "")
    )
  ) || null;
}

function getChatInsertTarget() {
  const input = getChatInput();
  if (!input) return null;
  const inputRect = input.getBoundingClientRect();
  let node = input.parentElement;
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect();
    const isComposerSized = rect.height > 0 && rect.height <= 120 && Math.abs(rect.bottom - inputRect.bottom) < 80;
    if (isComposerSized && node.querySelector("textarea, input") && node.querySelector("button")) return node;
    if (node.classList?.contains("chat-box-position")) break;
    node = node.parentElement;
  }
  return input.parentElement;
}

function isAmazonChatOpen() {
  return !!getChatContainer();
}

function syncChatVisibility() {
  if (ourHost) ourHost.style.display = isAmazonChatOpen() ? "none" : "";
  restoreAmazonChatControls();
}

function restoreAmazonChatControls() {
  document.querySelectorAll(".chat-box-position .message-header button > span").forEach(el => {
    if (el.style.display === "none") el.style.display = "";
  });
}

function setupChatObserver() {
  if (chatObserver) return;
  chatObserver = new MutationObserver(() => {
    const modal = getChatContainer();
    syncChatVisibility();
    if (modal && !document.getElementById("rfx-chat-neg-container")) {
      injectChatNegButton();
    }
    // Clean up if modal closed
    if (!modal && document.getElementById("rfx-chat-neg-container")) {
      const el = document.getElementById("rfx-chat-neg-container");
      if (el) el.remove();
      chatWoId = null;
    }
  });
  chatObserver.observe(document.body, { childList: true, subtree: true });
  syncChatVisibility();
  if (getChatContainer() && !document.getElementById("rfx-chat-neg-container")) {
    injectChatNegButton();
  }
}

function injectChatNegButton() {
  const chat = getChatContainer();
  const insertTarget = getChatInsertTarget();
  if (!chat || !insertTarget || !chat.contains(insertTarget) || document.getElementById("rfx-chat-neg-container")) return;

  const container = document.createElement("div");
  container.id = "rfx-chat-neg-container";
  container.style.cssText = [
    "padding: 8px 0",
    "margin: 0 0 8px 0",
    "background: transparent",
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "position: relative",
    "z-index: 1",
  ].join(";");
  container.innerHTML = `
    <div style="display: flex; gap: 8px;">
      <button id="rfx-chat-neg-btn" style="
        padding: 8px 14px; font-size: 13px; font-weight: 600;
        background: #2563eb; color: #fff; border: none; border-radius: 8px;
        cursor: pointer; font-family: inherit; flex: 1; min-height: 36px;
      ">Auto-Negotiate</button>
      <button id="rfx-chat-neg-stop" style="
        padding: 8px 12px; font-size: 13px; font-weight: 600;
        background: #cc3333; color: #fff; border: none; border-radius: 8px;
        cursor: pointer; font-family: inherit; display: none; min-height: 36px;
      ">Stop</button>
    </div>
    <div id="rfx-chat-neg-status" style="margin-top: 6px; font-size: 13px; display: none;"></div>
  `;

  insertTarget.parentElement?.insertBefore(container, insertTarget);

  container.querySelector("#rfx-chat-neg-btn").addEventListener("click", () => {
    ensureAudioCtx();
    startChatNegotiation();
  });
  container.querySelector("#rfx-chat-neg-stop").addEventListener("click", () => {
    stopNegotiation();
  });
}

function stopNegotiation() {
  if (!chatWoId) return;
  const state = negotiationState.get(chatWoId);
  if (!state || state.status !== "running") return;
  console.log(`[Negotiator] Manually stopped at round ${state.round}. Best: ${fmt$(state.bestPay)}`);
  state.status = "done";
  negotiationState.set(chatWoId, state);
  playNegotiationSound();
  updateChatNegUI(chatWoId);
}

function startChatNegotiation() {
  const btn = document.getElementById("rfx-chat-neg-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Starting..."; }

  if (chatWoId) {
    startNegotiation(chatWoId, chatWoVersion, chatWoMajorVersion, chatOriginalPay);
    return;
  }

  // No data yet — send a quick initial query to get the load details
  console.log("[Negotiator] No chat data yet — sending initial query to get load details");
  if (btn) btn.textContent = "Getting load info...";

  // We need the WO ID to send the query, but we don't have it yet
  // Try to find it from the chat modal's content (Amazon renders the load ID somewhere)
  const chatBody = document.querySelector(".bot-play-area, [class*='bot-play-area']");
  if (!chatBody) {
    updateChatNegStatus("Could not find chat. Please send a message first, then try again.", "#cc3333");
    if (btn) { btn.disabled = false; btn.textContent = "Auto-Negotiate"; }
    return;
  }

  updateChatNegStatus("Send any message in the chat first so we can capture the load details, then click Auto-Negotiate again.", "#b8860b");
  if (btn) { btn.disabled = false; btn.textContent = "Auto-Negotiate"; }
}

function updateChatNegUI(woId) {
  const state = negotiationState.get(woId);
  if (!state) return;

  const statusEl = document.getElementById("rfx-chat-neg-status");
  const btn = document.getElementById("rfx-chat-neg-btn");
  const stopBtn = document.getElementById("rfx-chat-neg-stop");
  if (!statusEl) return;

  statusEl.style.display = "block";

  if (state.status === "running") {
    const priceChain = state.prices.map(p => fmt$(p)).join(" → ");
    statusEl.innerHTML = `
      <div style="font-weight:600; color:#2563eb; animation: rfxNegPulse 1s infinite;">Negotiating... Round ${state.round}</div>
      <div style="margin-top:4px; font-size:14px; color:#0f1111;">${priceChain}</div>
    `;
    statusEl.style.background = "#eff6ff";
    statusEl.style.padding = "8px";
    statusEl.style.borderRadius = "6px";
    if (btn) { btn.disabled = true; btn.textContent = "Negotiating..."; }
    if (stopBtn) { stopBtn.style.display = "block"; }
  } else if (state.status === "done") {
    const gain = state.bestPay - state.originalPay;
    const priceChain = state.prices.map(p => fmt$(p)).join(" → ");
    statusEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:18px">✅</span>
        <span style="font-weight:700; font-size:20px; color:#067d62;">${fmt$(state.bestPay)}</span>
        ${gain > 0.01 ? `<span style="font-weight:700; color:#067d62; font-size:15px;">+${fmt$(gain)} gained</span>` : ""}
        <span style="color:#565959; font-size:12px;">${state.round} rounds</span>
      </div>
      <div style="margin-top:4px; font-size:13px; color:#0f1111;">${priceChain}</div>
    `;
    statusEl.style.background = "#e6f7f2";
    statusEl.style.padding = "10px";
    statusEl.style.borderRadius = "6px";
    if (btn) { btn.disabled = true; btn.textContent = "Negotiation Complete"; btn.style.background = "#067d62"; }
    if (stopBtn) { stopBtn.style.display = "none"; }
  } else if (state.status === "ineligible") {
    statusEl.innerHTML = `<div style="color:#888;">Not eligible for negotiation</div>`;
    statusEl.style.background = "#f5f5f5";
    statusEl.style.padding = "8px";
    statusEl.style.borderRadius = "6px";
    if (btn) { btn.disabled = true; btn.textContent = "Not Eligible"; btn.style.background = "#888"; }
    if (stopBtn) { stopBtn.style.display = "none"; }
  }
}

function updateChatNegStatus(text, color) {
  const statusEl = document.getElementById("rfx-chat-neg-status");
  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.innerHTML = `<div style="color:${color || "#0f1111"}">${text}</div>`;
  }
}

// Intercept Amazon's own chat responses to capture workOpportunity details
window.addEventListener("relay-fetcher-chat-intercepted", (e) => {
  try {
    const { data } = JSON.parse(e.detail);
    if (data?.workOpportunity?.id) {
      chatWoId = data.workOpportunity.id;
      chatWoVersion = data.workOpportunity.version || 1;
      chatWoMajorVersion = data.workOpportunity.majorVersion || 1;
      // Get original price from the workOpportunity payout
      chatOriginalPay = data.workOpportunity?.payout?.value || data.updatedPrice?.value || 0;
      console.log(`[Negotiator] Chat intercepted — WO: ${chatWoId.substring(0, 8)}... ver=${chatWoVersion} major=${chatWoMajorVersion} pay=$${chatOriginalPay.toFixed(2)}`);
    }
  } catch (err) {
    console.error("[Negotiator] Chat intercept error:", err);
  }
});

// ============================================================
// AUTO-BOOK — clicks Book only, never Confirm
// ============================================================
async function autoBookLoad(woId) {
  console.log(`[AutoBook] ★ Auto-booking load: ${woId}`);
  const wo = allLoads.find(w => w.id === woId);

  // Close any open panel
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);

  // Refresh and search — up to 5 attempts
  const loadRow = await refreshUntilFound(woId, wo, 5);

  if (!loadRow) {
    console.warn("[AutoBook] Could not find load after 5 refresh attempts for:", woId);
    showToast("Auto-book: Could not find load after multiple refreshes");
    return;
  }

  console.log("[AutoBook] Found load row, clicking...");
  const clickTarget = loadRow.querySelector("a") || loadRow.querySelector("[role='button']") || loadRow;
  clickTarget.click();
  await sleep(500);

  // Find the Book button
  console.log("[AutoBook] Searching for Book button...");
  let bookBtn = null;
  const allButtons = document.querySelectorAll("button, [role='button']");
  for (const btn of allButtons) {
    if (btn.closest("#rfx-host")) continue;
    const txt = (btn.textContent || "").trim().toLowerCase();
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (txt === "book" || txt === "book load" || txt === "book this load" || label.includes("book")) {
      if (!txt.includes("confirm") && !txt.includes("accept")) {
        bookBtn = btn;
        break;
      }
    }
  }

  if (!bookBtn) {
    console.warn("[AutoBook] Could not find Book button");
    showToast("Auto-book: Could not find Book button");
    return;
  }

  // === BOOKING DISABLED FOR SAFETY — uncomment to enable ===
  // await sleep(200);
  // console.log("[AutoBook] ★ Clicking Book button...");
  // bookBtn.click();
  // console.log("[AutoBook] Book clicked — waiting for confirmation panel...");
  // await sleep(500);
  //
  // console.log("[AutoBook] Searching for Confirm button...");
  // let confirmBtn = null;
  // const confirmArea = document.querySelector("#confirmation-expander, [data-id='confirmation-expander']");
  // if (confirmArea) {
  //   const btns = confirmArea.querySelectorAll("button, [role='button']");
  //   for (const btn of btns) {
  //     const txt = (btn.textContent || "").trim().toLowerCase();
  //     if (txt.includes("book") || txt.includes("confirm") || txt.includes("yes") || txt.includes("accept")) {
  //       confirmBtn = btn; break;
  //     }
  //   }
  // }
  // if (!confirmBtn) {
  //   const allBtns2 = document.querySelectorAll("button, [role='button']");
  //   for (const btn of allBtns2) {
  //     if (btn.closest("#rfx-host")) continue;
  //     if (btn === bookBtn) continue;
  //     const txt = (btn.textContent || "").trim().toLowerCase();
  //     if (txt === "confirm" || txt === "yes" || txt === "book this trip" || txt === "confirm booking" || txt.includes("yes") || txt.includes("confirm")) {
  //       confirmBtn = btn; break;
  //     }
  //   }
  // }
  // if (!confirmBtn) {
  //   bookingState.set(woId, "pending");
  //   if (aiModeActive) injectCards();
  //   showToast("Auto-book: Book clicked but could not find Confirm — confirm manually");
  //   return;
  // }
  // await sleep(200);
  // console.log("[AutoBook] ★★★ Clicking Confirm button — BOOKING LOAD");
  // confirmBtn.click();
  // console.log("[AutoBook] ✅ LOAD BOOKED:", woId);
  // bookingState.set(woId, "confirmed");
  // if (aiModeActive) injectCards();
  // showToast("Auto-book: Load booked successfully!");
  // playBookedSound();
  // === END BOOKING DISABLED ===

  console.log("[AutoBook] Book/Confirm DISABLED for safety. Found load but did not click.");
  showToast("Auto-book: Found load but booking is disabled for safety");
}

// ============================================================
// BOOK — multi-step DOM automation (manual)
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showToast(text) {
  // Remove existing toast
  const old = document.getElementById("rfx-toast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.id = "rfx-toast";
  toast.className = "rfx-toast";
  // Toast is outside shadow DOM so it's always visible
  toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#232f3e;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function getLoadSearchIndex(woId) {
  const index = allLoads.findIndex(w => w.id === woId);
  return index >= 0 ? index : 0;
}

function buildBookingPayload(wo) {
  return {
    isCallFromRA: false,
    totalCost: {
      value: wo.payout?.value || 0,
      unit: wo.payout?.unit || "USD",
    },
    isCarrierEligibleForOneDayPayment: !!carrierDetails?.isCarrierEligibleForOneDayPayment,
    searchURL: "",
    auditContextMap: JSON.stringify({
      rlbChannel: "EXACT_MATCH",
      searchResultIndex: String(getLoadSearchIndex(wo.id)),
      userAgent: navigator.userAgent,
    }),
  };
}

function bookLoadDirectFromSearch(woId) {
  const wo = allLoads.find(w => w.id === woId);
  if (!wo) {
    console.warn("[DirectBook] Could not find load in search results:", woId);
    showToast("Direct book: load data not found. Refresh search first.");
    return;
  }

  const missing = [];
  if (!wo.id) missing.push("id");
  if (wo.version == null) missing.push("version");
  if (wo.majorVersion == null) missing.push("majorVersion");
  if (wo.workOpportunityOptionId == null) missing.push("workOpportunityOptionId");
  if (!wo.payout?.value) missing.push("payout");
  if (missing.length) {
    console.warn("[DirectBook] Missing required fields:", missing, wo);
    showToast(`Direct book: missing ${missing.join(", ")}`);
    return;
  }

  const url = `https://relay.amazon.com/api/loadboard/${wo.id}/${wo.version}/option/${wo.workOpportunityOptionId}/majorVersion/${wo.majorVersion}`;
  const payload = buildBookingPayload(wo);

  console.log("[DirectBook] Sending direct booking request:", { url, payload, wo });
  bookingState.set(woId, "pending");
  if (aiModeActive) injectCards();
  showToast(`Booking ${fmt$(wo.payout.value)} load directly...`);

  window.dispatchEvent(new CustomEvent("relay-fetcher-book-direct", {
    detail: JSON.stringify({ woId, url, payload }),
  }));
}

window.addEventListener("relay-fetcher-book-direct-result", (e) => {
  try {
    const { woId, status, ok, data, error } = JSON.parse(e.detail);
    if (error || !ok) {
      console.error("[DirectBook] Failed:", { woId, status, error, data });
      bookingState.set(woId, "failed");
      showToast(`Direct book failed${status ? ` (${status})` : ""}`);
      if (aiModeActive) injectCards();
      return;
    }

    console.log("[DirectBook] Booked:", { woId, status, data });
    bookingState.set(woId, "confirmed");
    alertedLoads = alertedLoads.filter(a => a.wo.id !== woId);
    seenLoads.delete(woId);
    playBookedSound();
    showToast("Load booked successfully!");
    if (aiModeActive) injectCards();
  } catch (err) {
    console.error("[DirectBook] Result handler error:", err);
  }
});

async function forceAmazonRefresh() {
  console.log("[Booker] Forcing Amazon UI refresh...");

  let clicked = false;

  const candidates = document.querySelectorAll("button[aria-label], button[title]");
  for (const btn of candidates) {
    if (btn.closest("#rfx-host")) continue;
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`.trim();
    if (/^refresh$/i.test(label) || /auto.?refresh/i.test(label)) {
      btn.click();
      clicked = true;
      console.log("[Booker] Clicked refresh via accessible label:", label);
      break;
    }
  }

  if (clicked) {
    await sleep(500);
    for (let i = 0; i < 3; i++) {
      const loadList = document.querySelector(".load-list");
      if (loadList && loadList.children.length > 0) break;
      await sleep(300);
    }
  } else {
    await sleep(1000);
  }
}

// Direct book — we already have the load-card element, no searching needed
async function bookLoadDirect(woId, loadCard) {
  console.log(`[Booker] Direct book for load: ${woId}`);

  // Close any open panel
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);

  // Click the load card to open Amazon's detail panel
  console.log("[Booker] Clicking load card to open panel...");
  const clickTarget = loadCard.querySelector(".wo-tag") || loadCard.querySelector("div[id]") || loadCard;
  clickTarget.click();
  await sleep(500);

  // Re-hide Amazon's content (React may have re-rendered and restored it)
  for (const child of loadCard.children) {
    if (!child.classList.contains("rfx-injected")) {
      child.style.display = "none";
    }
  }

  // Find the Book button in the panel
  console.log("[Booker] Searching for Book button...");
  let bookBtn = null;
  const allButtons = document.querySelectorAll("button, [role='button']");
  for (const btn of allButtons) {
    if (btn.closest("#rfx-host") || btn.closest(".rfx-injected")) continue;
    const txt = (btn.textContent || "").trim().toLowerCase();
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (txt === "book" || txt === "book load" || txt === "book this load" || label.includes("book")) {
      if (!txt.includes("confirm") && !txt.includes("accept")) {
        bookBtn = btn;
        console.log(`[Booker] Found Book button: "${btn.textContent.trim()}"`);
        break;
      }
    }
  }

  if (!bookBtn) {
    console.warn("[Booker] Could not find Book button in panel");
    showToast("Panel opened but could not find Book button");
    return;
  }

  // === BOOKING DISABLED FOR SAFETY — uncomment to enable ===
  // await sleep(200);
  // bookBtn.click();
  // console.log("[Booker] Book clicked");
  //
  // if (settings.fastBook) {
  //   await sleep(500);
  //   let confirmBtn = null;
  //   const confirmArea = document.querySelector("#confirmation-expander, [data-id='confirmation-expander']");
  //   if (confirmArea) {
  //     for (const btn of confirmArea.querySelectorAll("button, [role='button']")) {
  //       const txt = (btn.textContent || "").trim().toLowerCase();
  //       if (txt.includes("book") || txt.includes("confirm") || txt.includes("yes")) { confirmBtn = btn; break; }
  //     }
  //   }
  //   if (confirmBtn) {
  //     await sleep(200);
  //     confirmBtn.click();
  //     console.log("[Booker] ✅ CONFIRMED");
  //     bookingState.set(woId, "confirmed");
  //     if (aiModeActive) injectCards();
  //     playBookedSound();
  //     showToast("Load booked!");
  //     return;
  //   }
  // }
  // bookingState.set(woId, "pending");
  // if (aiModeActive) injectCards();
  // showToast("Book clicked — confirm in panel");
  // === END BOOKING DISABLED ===

  console.log("[Booker] Book/Confirm DISABLED for safety. Found Book button but did not click.");
  showToast("Booking disabled for safety — found Book button");
}

function findLoadInDOM(woId, wo) {
  const dataEls = document.querySelectorAll("[data-work-opportunity-id], [data-wo-id], [data-id]");
  for (const el of dataEls) {
    for (const attr of el.attributes) { if (attr.value === woId) return el; }
  }
  const candidates = document.querySelectorAll("a[href], [id], [aria-label]");
  for (const el of candidates) {
    if (el.closest("#rfx-host")) continue;
    if (el.href?.includes(woId) || el.id?.includes(woId) || el.getAttribute("aria-label")?.includes(woId)) return el;
  }
  if (wo) {
    const payText = wo.payout?.value?.toFixed(2);
    const ll = document.querySelector(".load-list");
    if (ll && payText) {
      for (const row of ll.querySelectorAll(":scope > div, :scope > a, :scope > li")) {
        const text = row.textContent || "";
        if (text.includes(payText)) {
          const city = wo.loads?.[0]?.stops?.[0]?.location?.city;
          if (!city || text.toUpperCase().includes(city.toUpperCase())) return row;
        }
      }
    }
  }
  const ll = document.querySelector(".load-list");
  if (ll) { for (const row of ll.querySelectorAll(":scope > *")) { if (row.innerHTML?.includes(woId)) return row; } }
  return null;
}

async function refreshUntilFound(woId, wo, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Booker] Refresh + search attempt ${attempt}/${maxAttempts}`);
    showToast(`Looking for load... (${attempt}/${maxAttempts})`);
    await forceAmazonRefresh();
    const row = findLoadInDOM(woId, wo);
    if (row) { console.log(`[Booker] Found load on attempt ${attempt}`); return row; }
    if (attempt < maxAttempts) await sleep(500);
  }
  return null;
}

async function bookLoad(woId) {
  const wo = allLoads.find(w => w.id === woId);
  console.log(`[Booker] Starting book flow for load ID: ${woId}`);

  // Close any open panel
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);

  // Refresh Amazon's UI and search — up to 5 attempts
  const loadRow = await refreshUntilFound(woId, wo, 5);

  if (!loadRow) {
    console.warn("[Booker] Could not find load after 5 refresh attempts for ID:", woId);
    showToast("Could not find load after multiple refreshes");
    bookingState.set(woId, "failed");
    if (aiModeActive) injectCards();
    return;
  }

  // Step 2 — Click the load row to open the detail panel
  console.log("[Booker] Clicking load row to open detail panel...");
  // Find the clickable element — might be the row itself, an anchor, or a child
  const clickTarget = loadRow.querySelector("a") || loadRow.querySelector("[role='button']") || loadRow;
  clickTarget.click();
  await sleep(500);

  // Step 3 — Find and click the Book button inside the detail panel
  console.log("[Booker] Searching for Book button in detail panel...");
  let bookBtn = null;

  // Search all buttons on the page for one that says "Book"
  const allButtons = document.querySelectorAll("button, [role='button']");
  for (const btn of allButtons) {
    if (btn.closest("#rfx-host")) continue; // skip our own buttons
    const txt = (btn.textContent || "").trim().toLowerCase();
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    // Match "Book" but NOT "Book Now", "Booked", "Book and Confirm", etc. — just "Book" or "Book load"
    if (txt === "book" || txt === "book load" || txt === "book this load" || label.includes("book")) {
      // Make sure it's not a confirm/accept button
      if (!txt.includes("confirm") && !txt.includes("accept")) {
        bookBtn = btn;
        console.log(`[Booker] Found Book button: "${btn.textContent.trim()}"`);
        break;
      }
    }
  }

  if (!bookBtn) {
    console.warn("[Booker] Could not find Book button in the detail panel");
    showToast("Load panel opened but could not find the Book button");
    return;
  }

  // === BOOKING DISABLED FOR SAFETY — uncomment to enable ===
  // await sleep(200);
  // console.log("[Booker] Clicking Book button...");
  // bookBtn.click();
  // console.log("[Booker] Book button clicked.");
  //
  // if (!settings.fastBook) {
  //   console.log("[Booker] Fast Book is OFF — waiting for manual confirmation.");
  //   bookingState.set(woId, "pending");
  //   if (aiModeActive) injectCards();
  //   showToast("Book clicked — review and confirm in Amazon's panel");
  //   return;
  // }
  //
  // console.log("[Booker] Fast Book is ON — auto-confirming...");
  // await sleep(500);
  //
  // console.log("[Booker] Searching for Confirm button...");
  // let confirmBtn = null;
  // const confirmArea = document.querySelector("#confirmation-expander, [data-id='confirmation-expander']");
  // if (confirmArea) {
  //   const btns = confirmArea.querySelectorAll("button, [role='button']");
  //   for (const btn of btns) {
  //     const txt = (btn.textContent || "").trim().toLowerCase();
  //     if (txt.includes("book") || txt.includes("confirm") || txt.includes("yes") || txt.includes("accept")) {
  //       confirmBtn = btn; break;
  //     }
  //   }
  // }
  // if (!confirmBtn) {
  //   const allBtns2 = document.querySelectorAll("button, [role='button']");
  //   for (const btn of allBtns2) {
  //     if (btn.closest("#rfx-host")) continue;
  //     if (btn === bookBtn) continue;
  //     const txt = (btn.textContent || "").trim().toLowerCase();
  //     if (txt === "confirm" || txt === "yes" || txt === "book this trip" || txt === "confirm booking" || txt.includes("yes") || txt.includes("confirm")) {
  //       confirmBtn = btn; break;
  //     }
  //   }
  // }
  // if (!confirmBtn) {
  //   bookingState.set(woId, "pending");
  //   if (aiModeActive) injectCards();
  //   showToast("Book clicked but could not find Confirm — confirm manually");
  //   return;
  // }
  // await sleep(200);
  // console.log("[Booker] Clicking Confirm button...");
  // confirmBtn.click();
  // console.log("[Booker] ✅ BOOKING CONFIRMED for load:", woId);
  // bookingState.set(woId, "confirmed");
  // if (aiModeActive) injectCards();
  // playBookedSound();
  // showToast("Load booked successfully!");
  // === END BOOKING DISABLED ===

  console.log("[Booker] Book/Confirm DISABLED for safety. Found Book button but did not click.");
  showToast("Booking is disabled for safety — found the load but did not book");
}

// ============================================================
// FETCH ALL (paginated, manual)
// ============================================================
function fetchAllLoads() {
  return new Promise((resolve) => {
    const btn = document.querySelector("#rfx-fetch-btn button");
    function onProgress(e) { const { fetched, total } = JSON.parse(e.detail); if (btn) btn.textContent = `${fetched}/${total}...`; }
    window.addEventListener("relay-fetcher-progress", onProgress);
    function onResult(e) {
      window.removeEventListener("relay-fetcher-result", onResult);
      window.removeEventListener("relay-fetcher-progress", onProgress);
      const { data, error } = JSON.parse(e.detail);
      if (btn) btn.textContent = "Fetch All";
      if (error || data?.errorCode) { resolve(); return; }
      carrierDetails = data?.carrierDetails || carrierDetails;
      currentSearchAuditId = data?.searchAuditId || currentSearchAuditId;
      allLoads = data?.workOpportunities || [];
      // Populate seenLoads map so detection works correctly from here
      for (const wo of allLoads) {
        if (!seenLoads.has(wo.id)) {
          seenLoads.set(wo.id, { version: wo.version || 1, payout: wo.payout?.value || 0, pickupTime: wo.firstPickupTime || "" });
        }
      }
      isFirstPoll = false;
      if (aiModeActive) injectCards();
      if (!aiModeActive && allLoads.length > 0) toggleAiMode();
      resolve();
    }
    window.addEventListener("relay-fetcher-result", onResult);

    const fallback = {
      workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP", "HOSTLER_SHUTTLE"], originCity: null, liveCity: null,
      originCities: [{ displayValue: "TRACY, CA", stateCode: "CA", isCityLive: false, latitude: 37.724328, longitude: -121.444622, name: "TRACY" }],
      startCityName: null, startCityStateCode: null, startCityLatitude: null, startCityLongitude: null, startCityDisplayValue: null,
      isOriginCityLive: null, startCityRadius: 50, destinationCity: null,
      originCitiesRadiusFilters: [{ cityLatitude: 37.724328, cityLongitude: -121.444622, cityName: "TRACY", cityStateCode: "CA", cityDisplayValue: "TRACY, CA", radius: 50 }],
      destinationCitiesRadiusFilters: [], exclusionCitiesFilter: null, endCityName: null, endCityStateCode: null, endCityDisplayValue: null,
      endCityLatitude: null, endCityLongitude: null, isDestinationCityLive: null, endCityRadius: 5, startDate: null, endDate: null,
      minDistance: null, maxDistance: null, minimumDurationInMillis: null, maximumDurationInMillis: null, minPayout: null, minPricePerDistance: null,
      driverTypeFilters: ["SINGLE_DRIVER", "TEAM_DRIVER"], uiiaCertificationsFilter: [], workOpportunityOperatingRegionFilter: [],
      loadingTypeFilters: ["LIVE", "DROP"], maximumNumberOfStops: 3, workOpportunityAccessType: null,
      sortByField: "relevanceForSearchTab", sortOrder: "asc", visibilityStatusType: "ALL",
      categorizedEquipmentTypeList: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "SKIRTED_FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_DRY_VAN", "FIFTY_THREE_FOOT_A5_AIR_TRAILER", "FORTY_FIVE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
      categorizedEquipmentTypeListForFilterPills: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
      nextItemToken: 0, resultSize: 50, searchURL: "", isAutoRefreshCall: false, notificationId: "",
      auditContextMap: JSON.stringify({ rlbChannel: "EXACT_MATCH", isOriginCityLive: "false", isDestinationCityLive: "false", userAgent: navigator.userAgent, source: "AVAILABLE_WORK" }),
    };
    window.dispatchEvent(new CustomEvent("relay-fetcher-fetch", { detail: JSON.stringify({ payload: fallback }) }));
  });
}

// ============================================================
// AUTO-UPDATE from page's own search
// ============================================================
window.addEventListener("relay-fetcher-auto-update", (e) => {
  try {
    const { data } = JSON.parse(e.detail);
    if (data?.workOpportunities) {
      carrierDetails = data?.carrierDetails || carrierDetails;
      currentSearchAuditId = data?.searchAuditId || currentSearchAuditId;
      console.log(`[Bot:AutoUpdate] Amazon page search returned ${data.workOpportunities.length} loads. botRunning=${botRunning}`);
      // Deduplicate — keep highest payout per ID
      const dedupMap = new Map();
      for (const wo of data.workOpportunities) {
        const existing = dedupMap.get(wo.id);
        if (!existing || (wo.payout?.value || 0) > (existing.payout?.value || 0)) {
          dedupMap.set(wo.id, wo);
        }
      }
      allLoads = Array.from(dedupMap.values());

      if (!botRunning) {
        seenLoads.clear();
        for (const wo of allLoads) {
          seenLoads.set(wo.id, { version: wo.version || 1, payout: wo.payout?.value || 0, pickupTime: wo.firstPickupTime || "" });
        }
        isFirstPoll = false;
        console.log(`[Bot:AutoUpdate] Bot stopped — reset seenLoads to ${seenLoads.size}. isFirstPoll=${isFirstPoll}`);
      } else {
        // Bot is running — do NOT touch seenLoads. Let the bot's own poll detect changes.
        console.log(`[Bot:AutoUpdate] Bot RUNNING — NOT touching seenLoads (${seenLoads.size}). Bot will detect changes on next poll.`);
      }
      if (aiModeActive) injectCards();
    }
  } catch (err) { console.error("[Relay Fetcher] Auto-update error:", err); }
});

// Keepalive handler
chrome.runtime.onMessage.addListener((msg) => { if (msg.action === "keepalive") return; });

// MutationObserver — injects our UI, re-injects if removed, hides Amazon content
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.target.id === "rfx-host" || m.target.closest?.("#rfx-host")) return;
  }
  if (!aiModeActive) return;

  // Check if our host got disconnected (Amazon re-rendered the page)
  if (ourHost && !document.contains(ourHost)) {
    console.log("[Relay Fetcher] Host disconnected — re-injecting");
    ourHost = null;
    shadowRoot = null;
    amazonContainer = null;
  }

  if (!ourHost) {
    injectCards();
  } else {
    // Only re-style if there are NEW unstyled load cards in the DOM
    const loadList = document.querySelector(".load-list");
    if (loadList && allLoads.length > 0) {
      const unstyled = loadList.querySelectorAll(".load-card:not(.rfx-styled):not(.rfx-no-match)");
      if (unstyled.length > 0) {
        console.log(`[Observer] ${unstyled.length} unstyled cards found, re-styling`);
        amazonContainer = loadList;
        styleAmazonLoadCards();
      }
    }
    applyHideAmazonLoads();
  }
});

// ============================================================
// INIT
// ============================================================
function init() {
  // Persistent "AI Loads" button — injected into the same area as the load list
  const backBtn = document.createElement("div");
  backBtn.id = "rfx-back-btn";
  backBtn.style.cssText = "display:none; padding:12px 0;";
  backBtn.innerHTML = `<button style="
    padding:10px 24px; font-size:14px; font-weight:600;
    border-radius:8px; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,0.15);
    font-family:'Amazon Ember',-apple-system,sans-serif; border:none;
    background:#232f3e; color:#fff;
  ">AI Loads</button>`;
  backBtn.querySelector("button").addEventListener("click", toggleAiMode);
  document.body.appendChild(backBtn);

  observer.observe(document.body, { childList: true, subtree: true });
  setupChatObserver();
  injectCards();
}

if (document.body) init();
else document.addEventListener("DOMContentLoaded", init);

console.log("[Relay Fetcher] Content script loaded.");
