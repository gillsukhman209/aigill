// Content script — runs on relay.amazon.com/loadboard/* (isolated world)
// UI + logging only. Actual fetch is done by interceptor.js in MAIN world.

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fetchLoads() {
  return new Promise((resolve) => {
    updateStatus("Fetching loads...", false);

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

    // Listen for the result from MAIN world
    function onResult(e) {
      window.removeEventListener("relay-fetcher-result", onResult);
      const { status, data, error } = JSON.parse(e.detail);

      if (error) {
        console.error("[Relay Fetcher] Fetch failed:", error);
        updateStatus(`Fetch failed: ${error}`, true);
        resolve({ success: false, error });
        return;
      }

      console.log("[Relay Fetcher] Response status:", status);
      console.log("[Relay Fetcher] ========== FULL RAW RESPONSE ==========");
      console.log(JSON.stringify(data, null, 2));
      console.log("[Relay Fetcher] ========== END RAW RESPONSE ==========");

      if (data.errorCode) {
        console.error("[Relay Fetcher] API Error:", data.defaultErrorMessage);
        updateStatus(`Error: ${data.defaultErrorMessage}`, true);
        resolve({ success: false, error: data.defaultErrorMessage });
        return;
      }

      const loads = data.workOpportunities || [];
      console.log("[Relay Fetcher] ========== LOAD SUMMARY ==========");
      console.log(`[Relay Fetcher] Loads returned: ${loads.length} | Total available: ${data.totalResultsSize}`);

      loads.forEach((wo, i) => {
        const payout = wo.payout?.value ? `$${wo.payout.value.toFixed(2)}` : "N/A";
        const distance = wo.totalDistance?.value ? `${wo.totalDistance.value.toFixed(1)} mi` : "N/A";
        const duration = wo.totalDuration ? formatDuration(wo.totalDuration) : "N/A";

        let perMile = "N/A";
        if (wo.payout?.value && wo.totalDistance?.value && wo.totalDistance.value > 0) {
          perMile = `$${(wo.payout.value / wo.totalDistance.value).toFixed(2)}/mi`;
        }

        let origin = "N/A", destination = "N/A", originCode = "", destCode = "";
        if (wo.loads?.length > 0) {
          const firstStop = wo.loads[0].stops?.[0];
          if (firstStop?.location) {
            origin = `${firstStop.location.city}, ${firstStop.location.state}`;
            originCode = firstStop.location.label || "";
          }
          const lastLoad = wo.loads[wo.loads.length - 1];
          const lastStop = lastLoad.stops?.[lastLoad.stops.length - 1];
          if (lastStop?.location) {
            destination = `${lastStop.location.city}, ${lastStop.location.state}`;
            destCode = lastStop.location.label || "";
          }
        }

        console.log(
          `[Relay Fetcher] #${i + 1} | ${payout} | ${perMile} | ${distance} | ${duration} | ${originCode} ${origin} -> ${destCode} ${destination} | ${wo.transitOperatorType} | ${wo.stopCount} stops`
        );
      });

      console.log("[Relay Fetcher] ========== END SUMMARY ==========");
      updateStatus(`${loads.length} loads fetched (${data.totalResultsSize} total). See console (F12).`, false);
      resolve({ success: true, loadCount: loads.length, totalResults: data.totalResultsSize });
    }

    window.addEventListener("relay-fetcher-result", onResult);

    // Dispatch the fetch request to MAIN world (interceptor.js)
    window.dispatchEvent(new CustomEvent("relay-fetcher-fetch", {
      detail: JSON.stringify(payload),
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
    <button id="relay-fetcher-btn">Fetch Loads</button>
    <div id="relay-fetcher-status"></div>
  `;
  document.body.appendChild(container);

  document.getElementById("relay-fetcher-btn").addEventListener("click", async () => {
    const btn = document.getElementById("relay-fetcher-btn");
    btn.disabled = true;
    btn.textContent = "Fetching...";
    await fetchLoads();
    btn.disabled = false;
    btn.textContent = "Fetch Loads";
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

// Inject UI once DOM is ready
if (document.body) {
  injectUI();
} else {
  document.addEventListener("DOMContentLoaded", injectUI);
}

console.log("[Relay Fetcher] Content script loaded on", window.location.href);
