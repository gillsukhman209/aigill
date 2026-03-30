// Runs in the PAGE's main world at document_start
// Has full access to cookies, CSRF, same-origin credentials — just like the page's own code

(function () {
  let capturedCsrfToken = null;
  let lastSearchPayload = null; // Capture the page's own search payload
  const _origFetch = window.fetch;

  window.fetch = async function (...args) {
    const [resource, config] = args;
    const url = typeof resource === "string" ? resource : resource?.url || "";

    // Sniff CSRF token from any request that sends one
    if (config?.headers) {
      let token = null;
      if (config.headers instanceof Headers) {
        token = config.headers.get("x-csrf-token") || config.headers.get("anti-csrftoken-a2z");
      } else if (typeof config.headers === "object") {
        token = config.headers["x-csrf-token"] || config.headers["anti-csrftoken-a2z"];
      }
      if (token) capturedCsrfToken = token;
    }

    // Capture the page's own search payload so we can replay it with pagination
    if (url.includes("/api/loadboard/search") && config?.method === "POST" && config?.body) {
      try {
        const parsed = JSON.parse(config.body);
        // Only capture real user searches, not our own paginated fetches
        if (!parsed._isRelayFetcher) {
          lastSearchPayload = parsed;
          console.log("[Relay Interceptor] Captured page search payload:", JSON.stringify(parsed, null, 2));
        }
      } catch (e) {}
    }

    return _origFetch.apply(this, args);
  };

  // Listen for fetch request from the content script (isolated world)
  window.addEventListener("relay-fetcher-fetch", async (e) => {
    const request = JSON.parse(e.detail);

    // Use the captured page payload if available, otherwise use the one from content script
    let basePayload;
    if (lastSearchPayload) {
      basePayload = { ...lastSearchPayload };
      console.log("[Relay MAIN] Using captured page search filters");
    } else if (request.payload) {
      basePayload = request.payload;
      console.log("[Relay MAIN] No captured search — using default filters");
    } else {
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: 0, error: "No search filters available. Search for loads on the page first." }),
      }));
      return;
    }

    let csrfToken = capturedCsrfToken;
    if (!csrfToken) {
      const cookies = document.cookie.split(";");
      for (const cookie of cookies) {
        const trimmed = cookie.trim();
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const name = trimmed.substring(0, eqIdx);
        const value = trimmed.substring(eqIdx + 1);
        if (name === "x-csrf-token" || name === "csrf-token" || name === "anti-csrftoken-a2z") {
          csrfToken = decodeURIComponent(value);
          break;
        }
      }
    }

    console.log("[Relay MAIN] Starting paginated fetch. CSRF:", csrfToken ? csrfToken.substring(0, 15) + "..." : "NOT FOUND");

    const allLoads = [];
    let nextToken = 0;
    let totalResults = 0;
    let pageNum = 0;

    try {
      while (true) {
        pageNum++;
        const payload = { ...basePayload, nextItemToken: nextToken, resultSize: 50, _isRelayFetcher: true };

        const response = await _origFetch("https://relay.amazon.com/api/loadboard/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          credentials: "include",
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (data.errorCode) {
          window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
            detail: JSON.stringify({ status: response.status, data, allLoads, totalResults }),
          }));
          return;
        }

        const loads = data.workOpportunities || [];
        allLoads.push(...loads);
        totalResults = data.totalResultsSize || totalResults;

        console.log(`[Relay MAIN] Page ${pageNum}: got ${loads.length} loads (${allLoads.length}/${totalResults} total)`);

        window.dispatchEvent(new CustomEvent("relay-fetcher-progress", {
          detail: JSON.stringify({ page: pageNum, fetched: allLoads.length, total: totalResults }),
        }));

        if (data.nextItemToken == null || loads.length === 0 || allLoads.length >= totalResults) {
          break;
        }

        nextToken = data.nextItemToken;
      }

      console.log(`[Relay MAIN] Done. Fetched ${allLoads.length} loads across ${pageNum} pages.`);

      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({
          status: 200,
          data: { workOpportunities: allLoads, totalResultsSize: totalResults },
        }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: 0, error: err.message, allLoads, totalResults }),
      }));
    }
  });

  console.log("[Relay Interceptor] Installed (MAIN world). Ready to fetch on demand.");
})();
