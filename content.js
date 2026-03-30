// Content script — runs on relay.amazon.com/loadboard/* (isolated world)
// UI + logging only. Actual fetch is done by interceptor.js in MAIN world.

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function getAllStops(wo) {
  const stops = [];
  if (!wo.loads) return stops;
  for (const load of wo.loads) {
    if (!load.stops) continue;
    for (const stop of load.stops) {
      stops.push(stop);
    }
  }
  // Sort by sequence number and deduplicate by location code
  stops.sort((a, b) => (a.stopSequenceNumber || 0) - (b.stopSequenceNumber || 0));
  const seen = new Set();
  return stops.filter((s) => {
    const key = s.location?.stopCode || s.location?.label || JSON.stringify(s.location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatStop(stop) {
  const loc = stop.location;
  if (!loc) return "???";
  const code = loc.label || loc.stopCode || "";
  const city = loc.city || "";
  const state = loc.state || "";
  return `${code} (${city}, ${state})`;
}

function fetchLoads() {
  return new Promise((resolve) => {
    updateStatus("Fetching all pages...", false);

    const payload = {
      workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP", "HOSTLER_SHUTTLE"],
      originCity: null,
      liveCity: null,
      originCities: [
        {
          displayValue: "TRACY, CA",
          stateCode: "CA",
          isCityLive: false,
          latitude: 37.724328,
          longitude: -121.444622,
          name: "TRACY",
        },
      ],
      startCityName: null,
      startCityStateCode: null,
      startCityLatitude: null,
      startCityLongitude: null,
      startCityDisplayValue: null,
      isOriginCityLive: null,
      startCityRadius: 50,
      destinationCity: null,
      originCitiesRadiusFilters: [
        {
          cityLatitude: 37.724328,
          cityLongitude: -121.444622,
          cityName: "TRACY",
          cityStateCode: "CA",
          cityDisplayValue: "TRACY, CA",
          radius: 50,
        },
      ],
      destinationCitiesRadiusFilters: [],
      exclusionCitiesFilter: null,
      endCityName: null,
      endCityStateCode: null,
      endCityDisplayValue: null,
      endCityLatitude: null,
      endCityLongitude: null,
      isDestinationCityLive: null,
      endCityRadius: 5,
      startDate: null,
      endDate: null,
      minDistance: null,
      maxDistance: null,
      minimumDurationInMillis: null,
      maximumDurationInMillis: null,
      minPayout: null,
      minPricePerDistance: null,
      driverTypeFilters: ["SINGLE_DRIVER", "TEAM_DRIVER"],
      uiiaCertificationsFilter: [],
      workOpportunityOperatingRegionFilter: [],
      loadingTypeFilters: ["LIVE", "DROP"],
      maximumNumberOfStops: 3,
      workOpportunityAccessType: null,
      sortByField: "relevanceForSearchTab",
      sortOrder: "asc",
      visibilityStatusType: "ALL",
      categorizedEquipmentTypeList: [
        {
          equipmentCategory: "PROVIDED",
          equipmentsList: [
            "FIFTY_THREE_FOOT_TRUCK",
            "SKIRTED_FIFTY_THREE_FOOT_TRUCK",
            "FIFTY_THREE_FOOT_DRY_VAN",
            "FIFTY_THREE_FOOT_A5_AIR_TRAILER",
            "FORTY_FIVE_FOOT_TRUCK",
            "FIFTY_THREE_FOOT_CONTAINER",
          ],
        },
      ],
      categorizedEquipmentTypeListForFilterPills: [
        {
          equipmentCategory: "PROVIDED",
          equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"],
        },
      ],
      nextItemToken: 0,
      resultSize: 50,
      searchURL: "",
      isAutoRefreshCall: false,
      notificationId: "",
      auditContextMap: JSON.stringify({
        rlbChannel: "EXACT_MATCH",
        isOriginCityLive: "false",
        isDestinationCityLive: "false",
        userAgent: navigator.userAgent,
        source: "AVAILABLE_WORK",
      }),
    };

    // Listen for progress updates
    function onProgress(e) {
      const { page, fetched, total } = JSON.parse(e.detail);
      updateStatus(`Fetching page ${page}... (${fetched}/${total} loads)`, false);
    }
    window.addEventListener("relay-fetcher-progress", onProgress);

    // Listen for the final result from MAIN world
    function onResult(e) {
      window.removeEventListener("relay-fetcher-result", onResult);
      window.removeEventListener("relay-fetcher-progress", onProgress);
      const { status, data, error } = JSON.parse(e.detail);

      if (error) {
        console.error("[Relay Fetcher] Fetch failed:", error);
        updateStatus(`Fetch failed: ${error}`, true);
        resolve({ success: false, error });
        return;
      }

      if (data.errorCode) {
        console.error("[Relay Fetcher] API Error:", data.defaultErrorMessage);
        updateStatus(`Error: ${data.defaultErrorMessage}`, true);
        resolve({ success: false, error: data.defaultErrorMessage });
        return;
      }

      const loads = data.workOpportunities || [];
      const totalResults = data.totalResultsSize || loads.length;

      console.log("[Relay Fetcher] ========== FULL RAW RESPONSE ==========");
      console.log(JSON.stringify(data, null, 2));
      console.log("[Relay Fetcher] ========== END RAW RESPONSE ==========");

      console.log("[Relay Fetcher] ========== LOAD SUMMARY ==========");
      console.log(`[Relay Fetcher] Total loads fetched: ${loads.length} / ${totalResults} available`);

      loads.forEach((wo, i) => {
        const payout = wo.payout?.value ? `$${wo.payout.value.toFixed(2)}` : "N/A";
        const distance = wo.totalDistance?.value ? `${wo.totalDistance.value.toFixed(1)} mi` : "N/A";
        const duration = wo.totalDuration ? formatDuration(wo.totalDuration) : "N/A";

        let perMile = "N/A";
        if (wo.payout?.value && wo.totalDistance?.value && wo.totalDistance.value > 0) {
          perMile = `$${(wo.payout.value / wo.totalDistance.value).toFixed(2)}/mi`;
        }

        // Get ALL stops in order
        const stops = getAllStops(wo);
        const route = stops.map(formatStop).join(" -> ");

        // Log each stop with details
        const stopDetails = stops.map((s, si) => {
          const loc = s.location || {};
          const checkin = s.actions?.find((a) => a.type === "CHECKIN")?.plannedTime || "N/A";
          const checkout = s.actions?.find((a) => a.type === "CHECKOUT")?.plannedTime || "N/A";
          return `    Stop ${si + 1}: ${s.stopType} @ ${loc.label || "?"} (${loc.city}, ${loc.state}) | Loading: ${s.loadingType || s.unloadingType || "N/A"} | Checkin: ${checkin} | Checkout: ${checkout}`;
        });

        console.log(
          `[Relay Fetcher] #${i + 1} | ${payout} | ${perMile} | ${distance} | ${duration} | ${wo.transitOperatorType} | ${wo.stopCount} stops\n` +
          `  Route: ${route}\n` +
          stopDetails.join("\n")
        );
      });

      console.log("[Relay Fetcher] ========== END SUMMARY ==========");
      updateStatus(`All ${loads.length} loads fetched (${totalResults} total). See console (F12).`, false);
      resolve({ success: true, loadCount: loads.length, totalResults });
    }

    window.addEventListener("relay-fetcher-result", onResult);

    // Dispatch the fetch request to MAIN world (interceptor.js handles pagination)
    // Send our default payload as fallback — interceptor will prefer the captured page payload
    window.dispatchEvent(new CustomEvent("relay-fetcher-fetch", {
      detail: JSON.stringify({ payload }),
    }));
  });
}

// ============================================================
// IN-PAGE UI
// ============================================================
function injectUI() {
  if (document.getElementById("relay-fetcher-container")) return;

  const container = document.createElement("div");
  container.id = "relay-fetcher-container";
  container.innerHTML = `
    <style>
      #relay-fetcher-container {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #relay-fetcher-btn {
        padding: 10px 20px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        background: #ff9900;
        color: #111;
        border: none;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        transition: background 0.15s;
      }
      #relay-fetcher-btn:hover { background: #ffad33; }
      #relay-fetcher-btn:active { background: #e68a00; }
      #relay-fetcher-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      #relay-fetcher-status {
        max-width: 320px;
        padding: 6px 12px;
        font-size: 12px;
        color: #fff;
        background: rgba(0,0,0,0.75);
        border-radius: 4px;
        display: none;
        word-wrap: break-word;
      }
      #relay-fetcher-status.error { background: rgba(200,0,0,0.85); }
      #relay-fetcher-status.visible { display: block; }
    </style>
    <button id="relay-fetcher-btn">Fetch All Loads</button>
    <div id="relay-fetcher-status"></div>
  `;
  document.body.appendChild(container);

  document.getElementById("relay-fetcher-btn").addEventListener("click", async () => {
    const btn = document.getElementById("relay-fetcher-btn");
    btn.disabled = true;
    btn.textContent = "Fetching...";
    await fetchLoads();
    btn.disabled = false;
    btn.textContent = "Fetch All Loads";
  });
}

function updateStatus(text, isError) {
  const el = document.getElementById("relay-fetcher-status");
  if (!el) return;
  el.textContent = text;
  el.className = isError ? "visible error" : "visible";
  if (!isError) {
    setTimeout(() => { el.className = ""; }, 8000);
  }
}

if (document.body) {
  injectUI();
} else {
  document.addEventListener("DOMContentLoaded", injectUI);
}

console.log("[Relay Fetcher] Content script loaded on", window.location.href);
