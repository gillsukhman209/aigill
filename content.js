// Content script — relay.amazon.com/loadboard/* (isolated world)
// Replaces Amazon's load cards in-place with enhanced cards

// ============================================================
// STATE
// ============================================================
let allLoads = [];
let knownIds = new Set();
let currentSort = "score";
let currentSortDir = "desc";
let aiModeActive = false;
let amazonContainer = null;
let ourHost = null;
let shadowRoot = null;

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
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || undefined });
    const diff = Math.floor((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz || undefined });
    return `${label} ${time}`;
  } catch { return iso; }
}
function fmtTimeShort(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || undefined }); } catch { return ""; }
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
// CSS — light theme matching Amazon Relay
// ============================================================
const CSS = `
:host { all: initial; font-family: "Amazon Ember", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; color: #0f1111; }
* { box-sizing: border-box; margin: 0; padding: 0; }

.rfx-toolbar {
  display: flex; align-items: center; gap: 6px; padding: 8px 0 10px 0; flex-wrap: wrap;
  border-bottom: 1px solid #e7e7e7; margin-bottom: 8px;
}
.rfx-toolbar-label { font-size: 13px; color: #565959; margin-right: 4px; }
.rfx-sort-btn {
  padding: 4px 10px; font-size: 12px; border: 1px solid #d5d9d9; border-radius: 8px;
  background: #fff; color: #0f1111; cursor: pointer; font-family: inherit;
}
.rfx-sort-btn:hover { background: #f7fafa; }
.rfx-sort-btn.active { background: #232f3e; color: #fff; border-color: #232f3e; }
.rfx-count { font-size: 13px; color: #565959; margin-left: auto; }

.rfx-card {
  background: #fff; border: 1px solid #d5d9d9; border-radius: 8px;
  padding: 12px 16px; margin-bottom: 8px; cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.rfx-card:hover { box-shadow: 0 1px 5px rgba(0,0,0,0.12); border-color: #c0c0c0; }
.rfx-card.version-warn { border-left: 3px solid #cc3333; }
.rfx-card.new-load { animation: rfxFlash 2s ease-out; }
@keyframes rfxFlash { 0% { background: #e6f7e6; } 100% { background: #fff; } }

/* Two-column layout */
.rfx-body { display: flex; gap: 16px; }
.rfx-left { flex: 1; min-width: 0; }
.rfx-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; min-width: 130px; text-align: right; }
.rfx-payout { font-size: 22px; font-weight: 700; color: #067d62; line-height: 1.1; }
.rfx-stat { font-size: 13px; color: #565959; margin-top: 2px; }
.rfx-stat b { color: #0f1111; font-weight: 600; }
.rfx-stats-group { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.rfx-version { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; margin-top: 4px; }
.rfx-version.ok { background: #f0f0f0; color: #565959; }
.rfx-version.bad { background: #fdecea; color: #cc3333; }

/* Score bar */
.rfx-score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.rfx-score-bg { flex: 1; height: 5px; background: #e7e7e7; border-radius: 3px; overflow: hidden; max-width: 200px; }
.rfx-score-fill { height: 100%; border-radius: 3px; }
.rfx-score-label { font-size: 12px; font-weight: 700; min-width: 22px; }
.rfx-score-tag { font-size: 11px; padding: 1px 8px; border-radius: 4px; font-weight: 600; margin-left: 4px; }

/* Stop timeline */
.rfx-stops { margin: 4px 0 0 0; }
.rfx-stop { display: flex; align-items: flex-start; gap: 10px; position: relative; }
.rfx-stop-line { display: flex; flex-direction: column; align-items: center; width: 24px; flex-shrink: 0; }
.rfx-stop-dot {
  width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.rfx-stop-dot.pickup { background: #2563eb; }
.rfx-stop-dot.dropoff { background: #7c3aed; }
.rfx-stop-conn { width: 2px; flex: 1; background: #d5d9d9; min-height: 10px; }
.rfx-stop-info { flex: 1; padding-bottom: 4px; }
.rfx-stop-name { font-size: 13px; font-weight: 600; color: #0f1111; }
.rfx-stop-addr { font-size: 11px; color: #888; }
.rfx-stop-meta { display: flex; gap: 6px; align-items: center; margin-top: 2px; flex-wrap: wrap; }
.rfx-stop-time { font-size: 12px; color: #565959; }
.rfx-stop-dwell { font-size: 11px; color: #888; }
.rfx-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase;
}
.rfx-badge.preloaded { background: #e6f7f2; color: #067d62; }
.rfx-badge.live { background: #fef3cd; color: #856404; }
.rfx-badge.drop { background: #e8f0fe; color: #1a56db; }
.rfx-leg-dist { font-size: 11px; color: #888; padding: 1px 0 3px 34px; }

/* Footer */
.rfx-footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 6px; border-top: 1px solid #f0f0f0; }
.rfx-tag { font-size: 12px; color: #565959; }
.rfx-tag b { color: #0f1111; }
.rfx-book-btn {
  margin-left: auto; padding: 5px 16px; font-size: 13px; font-weight: 600;
  background: #ff9900; color: #0f1111; border: none; border-radius: 6px; cursor: pointer;
  font-family: inherit;
}
.rfx-book-btn:hover { background: #e88b00; }

.rfx-empty { text-align: center; color: #888; padding: 40px 20px; font-size: 14px; }
`;

// ============================================================
// CARD HTML
// ============================================================
function renderCard(wo, isNew) {
  const pay = wo.payout?.value || 0, dist = wo.totalDistance?.value || 0;
  const durMs = wo.totalDuration || 0, durH = durMs / 3600000;
  const perHr = durH > 0 ? pay / durH : 0, perMi = dist > 0 ? pay / dist : 0;
  const ver = wo.version || 1, score = scoreLoad(wo), sc = scoreColor(score);
  const stops = getAllStops(wo);
  const driver = wo.transitOperatorType === "TEAM_DRIVER" ? "Team" : "Solo";
  const firstTz = stops[0]?.location?.timeZone;
  const warnCls = ver > 5 ? " version-warn" : "";
  const newCls = isNew ? " new-load" : "";

  let vBadge = "";
  if (ver > 3) vBadge = `<span class="rfx-version bad">v${ver} ⚠</span>`;
  else if (ver > 1) vBadge = `<span class="rfx-version ok">v${ver}</span>`;

  let stopsHtml = "";
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], loc = s.location || {};
    const dotCls = s.stopType === "PICKUP" ? "pickup" : "dropoff";
    const checkin = s.actions?.find(a => a.type === "CHECKIN")?.plannedTime;
    const checkout = s.actions?.find(a => a.type === "CHECKOUT")?.plannedTime;
    const tz = loc.timeZone || firstTz;
    let dwell = "";
    if (checkin && checkout) { const d = new Date(checkout) - new Date(checkin); if (d > 0) dwell = fmtDur(d); }
    const lt = s.loadingType || s.unloadingType || "";
    let ltBadge = "";
    if (lt) {
      const c = lt === "PRELOADED" ? "preloaded" : lt === "LIVE" ? "live" : "drop";
      ltBadge = `<span class="rfx-badge ${c}">${lt}</span>`;
    }
    const conn = i < stops.length - 1;

    stopsHtml += `<div class="rfx-stop">
      <div class="rfx-stop-line">
        <div class="rfx-stop-dot ${dotCls}">${i + 1}</div>
        ${conn ? '<div class="rfx-stop-conn"></div>' : ""}
      </div>
      <div class="rfx-stop-info">
        <div class="rfx-stop-name">${loc.label || loc.stopCode || "?"} · ${loc.city || "?"}, ${loc.state || "?"}</div>
        <div class="rfx-stop-addr">${loc.line1 || ""}</div>
        <div class="rfx-stop-meta">
          <span class="rfx-stop-time">${fmtTimeShort(checkin, tz)}</span>
          ${dwell ? `<span class="rfx-stop-dwell">${dwell}</span>` : ""}
          ${ltBadge}
        </div>
      </div>
    </div>`;
    if (conn && loc.latitude && loc.longitude) {
      const nL = stops[i + 1]?.location;
      if (nL?.latitude && nL?.longitude) {
        const ld = (haversine(loc.latitude, loc.longitude, nL.latitude, nL.longitude) * 1.25).toFixed(1);
        stopsHtml += `<div class="rfx-leg-dist">↓ ~${ld} mi</div>`;
      }
    }
  }

  return `<div class="rfx-card${warnCls}${newCls}" data-id="${wo.id}">
    <div class="rfx-body">
      <div class="rfx-left">
        <div class="rfx-score-row">
          <div class="rfx-score-bg"><div class="rfx-score-fill" style="width:${score}%;background:${sc}"></div></div>
          <span class="rfx-score-label" style="color:${sc}">${score}</span>
          <span class="rfx-score-tag" style="background:${scoreBg(score)};color:${sc}">${score >= 70 ? "Great" : score >= 40 ? "OK" : "Low"}</span>
        </div>
        <div class="rfx-stops">${stopsHtml}</div>
        <div class="rfx-footer">
          <span class="rfx-tag"><b>${fmtTime(wo.firstPickupTime, firstTz)}</b></span>
          <span class="rfx-tag">${driver}</span>
          <span class="rfx-tag">53' Trailer</span>
          <span class="rfx-tag">${wo.stopCount || stops.length} stops</span>
        </div>
      </div>
      <div class="rfx-right">
        <div class="rfx-stats-group">
          <span class="rfx-payout">${fmt$(pay)}</span>
          <span class="rfx-stat"><b>${fmt$(perHr)}</b>/hr</span>
          <span class="rfx-stat"><b>${fmt$(perMi)}</b>/mi</span>
          <span class="rfx-stat"><b>${dist.toFixed(1)}</b> mi · <b>${fmtDur(durMs)}</b></span>
          ${vBadge}
        </div>
        <button class="rfx-book-btn" data-wo-id="${wo.id}">BOOK</button>
      </div>
    </div>
  </div>`;
}

// ============================================================
// FIND AMAZON'S LOAD CONTAINER
// ============================================================
function findLoadContainer() {
  // Strategy: find clickable rows that contain "$" and "mi" — those are load cards
  // Their common parent is the load list container
  const allEls = document.querySelectorAll("div, a, li, tr");
  const loadRows = [];
  for (const el of allEls) {
    const t = el.textContent || "";
    // A load row has a price, distance, and is not too large (not the whole page)
    if (t.length < 2000 && /\$\d+\.\d{2}/.test(t) && /\d+\.?\d*\s*mi/i.test(t) && el.children.length >= 2) {
      loadRows.push(el);
    }
  }

  if (loadRows.length < 3) return null;

  // Find the deepest common parent that contains most of these rows as descendants
  // Usually the rows are direct children of a single container
  const parentCounts = new Map();
  for (const row of loadRows) {
    let p = row.parentElement;
    for (let depth = 0; depth < 5 && p; depth++) {
      parentCounts.set(p, (parentCounts.get(p) || 0) + 1);
      p = p.parentElement;
    }
  }

  // Find the most specific parent that contains most rows
  let best = null, bestCount = 0, bestDepth = Infinity;
  for (const [el, count] of parentCounts) {
    if (count >= 3) {
      let depth = 0; let p = el;
      while (p) { depth++; p = p.parentElement; }
      if (count > bestCount || (count === bestCount && depth > bestDepth)) {
        best = el; bestCount = count; bestDepth = depth;
      }
    }
  }

  return best;
}

// ============================================================
// INJECT OUR CARDS
// ============================================================
function injectCards() {
  if (!aiModeActive || allLoads.length === 0) return;

  // Find Amazon's container if we haven't yet
  if (!amazonContainer) {
    amazonContainer = findLoadContainer();
    if (!amazonContainer) {
      console.warn("[Relay Fetcher] Could not find Amazon's load container yet");
      return;
    }
  }

  // Hide Amazon's cards
  amazonContainer.style.display = "none";

  // Create our shadow host if needed
  if (!ourHost) {
    ourHost = document.createElement("div");
    ourHost.id = "rfx-host";
    amazonContainer.parentElement.insertBefore(ourHost, amazonContainer);
    shadowRoot = ourHost.attachShadow({ mode: "open" });
  }

  // Sort loads
  const sorted = [...allLoads];
  const dir = currentSortDir === "desc" ? -1 : 1;
  sorted.sort((a, b) => {
    let va, vb;
    switch (currentSort) {
      case "score": va = scoreLoad(a); vb = scoreLoad(b); break;
      case "perhr": { const dA = (a.totalDuration || 1) / 3600000, dB = (b.totalDuration || 1) / 3600000; va = (a.payout?.value || 0) / dA; vb = (b.payout?.value || 0) / dB; break; }
      case "permi": { va = (a.totalDistance?.value || 1) > 0 ? (a.payout?.value || 0) / a.totalDistance.value : 0; vb = (b.totalDistance?.value || 1) > 0 ? (b.payout?.value || 0) / b.totalDistance.value : 0; break; }
      case "pay": va = a.payout?.value || 0; vb = b.payout?.value || 0; break;
      case "dist": va = a.totalDistance?.value || 0; vb = b.totalDistance?.value || 0; break;
      case "pickup": va = a.firstPickupTime ? new Date(a.firstPickupTime).getTime() : Infinity; vb = b.firstPickupTime ? new Date(b.firstPickupTime).getTime() : Infinity; break;
      default: va = 0; vb = 0;
    }
    return (va - vb) * dir;
  });

  const newIds = new Set();
  for (const wo of sorted) { if (!knownIds.has(wo.id)) newIds.add(wo.id); }

  // Build toolbar
  const sortButtons = ["score", "perhr", "permi", "pay", "dist", "pickup"];
  const sortLabels = { score: "Score", perhr: "$/hr", permi: "$/mi", pay: "Payout", dist: "Distance", pickup: "Pickup" };
  const toolbar = `<div class="rfx-toolbar">
    <span class="rfx-toolbar-label">Sort:</span>
    ${sortButtons.map(s => `<button class="rfx-sort-btn${currentSort === s ? " active" : ""}" data-sort="${s}">${sortLabels[s]}${currentSort === s ? (currentSortDir === "desc" ? " ↓" : " ↑") : ""}</button>`).join("")}
    <span class="rfx-count">${sorted.length} loads</span>
  </div>`;

  shadowRoot.innerHTML = `<style>${CSS}</style>${toolbar}${sorted.map(wo => renderCard(wo, newIds.has(wo.id))).join("")}`;

  // Mark known
  for (const wo of sorted) knownIds.add(wo.id);

  // Sort button listeners
  shadowRoot.querySelectorAll(".rfx-sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = btn.dataset.sort;
      if (currentSort === s) currentSortDir = currentSortDir === "desc" ? "asc" : "desc";
      else { currentSort = s; currentSortDir = s === "pickup" ? "asc" : "desc"; }
      injectCards();
    });
  });

  // Book button listeners
  shadowRoot.querySelectorAll(".rfx-book-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      bookLoad(btn.dataset.woId);
    });
  });
}

function removeOurCards() {
  if (amazonContainer) amazonContainer.style.display = "";
  if (ourHost) { ourHost.remove(); ourHost = null; shadowRoot = null; }
}

function toggleAiMode() {
  aiModeActive = !aiModeActive;
  const btn = document.querySelector("#rfx-toggle-btn button");
  if (aiModeActive) {
    if (btn) btn.textContent = "Amazon UI";
    if (allLoads.length > 0) {
      injectCards();
    } else {
      // Trigger fetch if no loads yet
      fetchAllLoads();
    }
  } else {
    if (btn) btn.textContent = "AI Loads";
    removeOurCards();
  }
}

// ============================================================
// BOOK BUTTON
// ============================================================
function bookLoad(woId) {
  // Search Amazon's DOM for matching load element
  const allEls = document.querySelectorAll("a, div[role='button'], button, [data-testid]");
  for (const el of allEls) {
    if (el.innerHTML?.includes(woId) || el.href?.includes(woId)) {
      el.click();
      console.log("[Relay Fetcher] Clicked matching element for", woId);
      return;
    }
  }
  console.log("[Relay Fetcher] Could not find element for", woId);
  window.open(`https://relay.amazon.com/loadboard/loads/${woId}`, "_blank");
}

// ============================================================
// FETCH ALL (paginated)
// ============================================================
function fetchAllLoads() {
  return new Promise((resolve) => {
    const btn = document.querySelector("#rfx-fetch-btn button");

    function onProgress(e) {
      const { fetched, total } = JSON.parse(e.detail);
      if (btn) btn.textContent = `${fetched}/${total}...`;
    }
    window.addEventListener("relay-fetcher-progress", onProgress);

    function onResult(e) {
      window.removeEventListener("relay-fetcher-result", onResult);
      window.removeEventListener("relay-fetcher-progress", onProgress);
      const { data, error } = JSON.parse(e.detail);
      if (btn) btn.textContent = "Fetch All";
      if (error || data?.errorCode) { console.error("[Relay Fetcher]", error || data?.defaultErrorMessage); resolve(); return; }
      allLoads = data?.workOpportunities || [];
      console.log(`[Relay Fetcher] Fetched all ${allLoads.length} loads`);
      if (aiModeActive) injectCards();
      if (!aiModeActive && allLoads.length > 0) toggleAiMode();
      resolve();
    }
    window.addEventListener("relay-fetcher-result", onResult);

    const fallback = {
      workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP", "HOSTLER_SHUTTLE"],
      originCity: null, liveCity: null,
      originCities: [{ displayValue: "TRACY, CA", stateCode: "CA", isCityLive: false, latitude: 37.724328, longitude: -121.444622, name: "TRACY" }],
      startCityName: null, startCityStateCode: null, startCityLatitude: null, startCityLongitude: null, startCityDisplayValue: null,
      isOriginCityLive: null, startCityRadius: 50, destinationCity: null,
      originCitiesRadiusFilters: [{ cityLatitude: 37.724328, cityLongitude: -121.444622, cityName: "TRACY", cityStateCode: "CA", cityDisplayValue: "TRACY, CA", radius: 50 }],
      destinationCitiesRadiusFilters: [], exclusionCitiesFilter: null, endCityName: null, endCityStateCode: null, endCityDisplayValue: null,
      endCityLatitude: null, endCityLongitude: null, isDestinationCityLive: null, endCityRadius: 5,
      startDate: null, endDate: null, minDistance: null, maxDistance: null, minimumDurationInMillis: null, maximumDurationInMillis: null,
      minPayout: null, minPricePerDistance: null, driverTypeFilters: ["SINGLE_DRIVER", "TEAM_DRIVER"],
      uiiaCertificationsFilter: [], workOpportunityOperatingRegionFilter: [], loadingTypeFilters: ["LIVE", "DROP"],
      maximumNumberOfStops: 3, workOpportunityAccessType: null, sortByField: "relevanceForSearchTab", sortOrder: "asc", visibilityStatusType: "ALL",
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
    if (data?.workOpportunities?.length) {
      const map = new Map();
      for (const wo of allLoads) map.set(wo.id, wo);
      for (const wo of data.workOpportunities) map.set(wo.id, wo);
      allLoads = Array.from(map.values());
      console.log(`[Relay Fetcher] Auto-update: ${data.workOpportunities.length} loads (${allLoads.length} total)`);
      if (aiModeActive) injectCards();
    }
  } catch (err) { console.error("[Relay Fetcher] Auto-update error:", err); }
});

// Retry finding the container when the page updates (SPA navigation)
const observer = new MutationObserver(() => {
  if (aiModeActive && !amazonContainer && allLoads.length > 0) {
    amazonContainer = findLoadContainer();
    if (amazonContainer) injectCards();
  }
});

// ============================================================
// INIT — inject toggle buttons
// ============================================================
function init() {
  // "AI Loads" toggle button
  const toggleWrap = document.createElement("div");
  toggleWrap.id = "rfx-toggle-btn";
  toggleWrap.innerHTML = `<style>
    #rfx-toggle-btn button, #rfx-fetch-btn button {
      position: fixed; z-index: 1000000;
      padding: 8px 16px; font-size: 13px; font-weight: 600;
      border-radius: 6px; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.15);
      font-family: "Amazon Ember", -apple-system, sans-serif; border: none;
    }
    #rfx-toggle-btn button { top: 12px; left: 12px; background: #232f3e; color: #fff; }
    #rfx-toggle-btn button:hover { background: #37475a; }
    #rfx-fetch-btn button { top: 12px; left: 110px; background: #fff; color: #232f3e; border: 1px solid #d5d9d9; }
    #rfx-fetch-btn button:hover { background: #f7fafa; }
  </style><button>AI Loads</button>`;
  document.body.appendChild(toggleWrap);
  toggleWrap.querySelector("button").addEventListener("click", toggleAiMode);

  // "Fetch All" button
  const fetchWrap = document.createElement("div");
  fetchWrap.id = "rfx-fetch-btn";
  fetchWrap.innerHTML = `<button>Fetch All</button>`;
  document.body.appendChild(fetchWrap);
  fetchWrap.querySelector("button").addEventListener("click", async () => {
    const b = fetchWrap.querySelector("button");
    b.disabled = true;
    await fetchAllLoads();
    b.disabled = false;
    b.textContent = "Fetch All";
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) init();
else document.addEventListener("DOMContentLoaded", init);

console.log("[Relay Fetcher] Content script loaded.");
