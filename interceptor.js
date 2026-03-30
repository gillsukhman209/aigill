// Runs in the PAGE's main world at document_start

(function () {
  let capturedCsrfToken = null;
  let lastSearchPayload = null;
  const _origFetch = window.fetch;

  window.fetch = async function (...args) {
    const [resource, config] = args;
    const url = typeof resource === "string" ? resource : resource?.url || "";

    if (config?.headers) {
      let token = null;
      if (config.headers instanceof Headers) {
        token = config.headers.get("x-csrf-token") || config.headers.get("anti-csrftoken-a2z");
      } else if (typeof config.headers === "object") {
        token = config.headers["x-csrf-token"] || config.headers["anti-csrftoken-a2z"];
      }
      if (token) capturedCsrfToken = token;
    }

    // Capture page's own search payload AND broadcast its response
    if (url.includes("/api/loadboard/search") && config?.method === "POST" && config?.body) {
      try {
        const parsed = JSON.parse(config.body);
        if (!parsed._isRelayFetcher) {
          lastSearchPayload = parsed;
          // Intercept the response to broadcast to content script
          const response = await _origFetch.apply(this, args);
          const clone = response.clone();
          try {
            const data = await clone.json();
            window.dispatchEvent(new CustomEvent("relay-fetcher-auto-update", {
              detail: JSON.stringify({ data, payload: parsed }),
            }));
          } catch (e) {}
          return response;
        }
      } catch (e) {}
    }

    // Capture Amazon's own chat/demand-support responses to grab workOpportunity details
    if (url.includes("/api/loadboard/demand-support/") && config?.method === "POST" && config?.body) {
      try {
        const parsed = JSON.parse(config.body);
        if (!parsed._isNegotiator) {
          const response = await _origFetch.apply(this, args);
          const clone = response.clone();
          try {
            const data = await clone.json();
            window.dispatchEvent(new CustomEvent("relay-fetcher-chat-intercepted", {
              detail: JSON.stringify({ data, request: parsed }),
            }));
          } catch (e) {}
          return response;
        }
      } catch (e) {}
    }

    return _origFetch.apply(this, args);
  };

  // Manual paginated fetch triggered by content script
  window.addEventListener("relay-fetcher-fetch", async (e) => {
    const request = JSON.parse(e.detail);
    let basePayload;
    if (lastSearchPayload) {
      basePayload = { ...lastSearchPayload };
    } else if (request.payload) {
      basePayload = request.payload;
    } else {
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: 0, error: "No search filters. Search on the page first." }),
      }));
      return;
    }

    let csrfToken = capturedCsrfToken;
    if (!csrfToken) {
      const cookies = document.cookie.split(";");
      for (const c of cookies) {
        const t = c.trim(); const eq = t.indexOf("=");
        if (eq === -1) continue;
        const n = t.substring(0, eq), v = t.substring(eq + 1);
        if (n === "x-csrf-token" || n === "csrf-token" || n === "anti-csrftoken-a2z") {
          csrfToken = decodeURIComponent(v); break;
        }
      }
    }

    const allLoads = [];
    let nextToken = 0, totalResults = 0, pageNum = 0;

    try {
      while (true) {
        pageNum++;
        const payload = { ...basePayload, nextItemToken: nextToken, resultSize: 50, _isRelayFetcher: true };
        const response = await _origFetch("https://relay.amazon.com/api/loadboard/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
          credentials: "include",
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (data.errorCode) {
          window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
            detail: JSON.stringify({ status: response.status, data }),
          }));
          return;
        }
        const loads = data.workOpportunities || [];
        allLoads.push(...loads);
        totalResults = data.totalResultsSize || totalResults;
        window.dispatchEvent(new CustomEvent("relay-fetcher-progress", {
          detail: JSON.stringify({ page: pageNum, fetched: allLoads.length, total: totalResults }),
        }));
        if (data.nextItemToken == null || loads.length === 0 || allLoads.length >= totalResults) break;
        nextToken = data.nextItemToken;
      }
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: 200, data: { workOpportunities: allLoads, totalResultsSize: totalResults } }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: 0, error: err.message }),
      }));
    }
  });

  // Single-page poll (non-paginated, fast) used by the bot loop
  window.addEventListener("relay-fetcher-poll", async (e) => {
    const request = JSON.parse(e.detail);
    let basePayload = lastSearchPayload || request.payload;
    if (!basePayload) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ error: "No search filters. Search on the page first." }),
      }));
      return;
    }

    let csrfToken = capturedCsrfToken;
    if (!csrfToken) {
      const cookies = document.cookie.split(";");
      for (const c of cookies) {
        const t = c.trim(); const eq = t.indexOf("=");
        if (eq === -1) continue;
        const n = t.substring(0, eq), v = t.substring(eq + 1);
        if (n === "x-csrf-token" || n === "csrf-token" || n === "anti-csrftoken-a2z") {
          csrfToken = decodeURIComponent(v); break;
        }
      }
    }

    try {
      const payload = { ...basePayload, nextItemToken: 0, resultSize: 50, _isRelayFetcher: true };
      const response = await _origFetch("https://relay.amazon.com/api/loadboard/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      // Capture token from our own request
      if (csrfToken && !capturedCsrfToken) capturedCsrfToken = csrfToken;
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ status: response.status, data }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ error: err.message }),
      }));
    }
  });

  // Negotiation request — sends a single query to demand-support endpoint
  window.addEventListener("relay-fetcher-negotiate", async (e) => {
    const req = JSON.parse(e.detail);
    let csrfToken = capturedCsrfToken;
    if (!csrfToken) {
      const cookies = document.cookie.split(";");
      for (const c of cookies) {
        const t = c.trim(); const eq = t.indexOf("=");
        if (eq === -1) continue;
        const n = t.substring(0, eq), v = t.substring(eq + 1);
        if (n === "x-csrf-token" || n === "csrf-token" || n === "anti-csrftoken-a2z") {
          csrfToken = decodeURIComponent(v); break;
        }
      }
    }

    try {
      const response = await _origFetch("https://relay.amazon.com/api/loadboard/demand-support/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        credentials: "include",
        body: JSON.stringify({ ...req.payload, _isNegotiator: true }),
      });
      const data = await response.json();
      window.dispatchEvent(new CustomEvent("relay-fetcher-negotiate-result", {
        detail: JSON.stringify({ woId: req.woId, status: response.status, data }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-negotiate-result", {
        detail: JSON.stringify({ woId: req.woId, error: err.message }),
      }));
    }
  });

  console.log("[Relay Interceptor] Installed (MAIN world).");
})();
