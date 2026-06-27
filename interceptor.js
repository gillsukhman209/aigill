// Runs in the PAGE's main world at document_start

(function () {
  let capturedCsrfToken = null;
  let lastSearchPayload = null;
  let autoSearchSeq = 0;
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;
  const _origXHRSend = XMLHttpRequest.prototype.send;

  function isSimilarRequest(url) {
    try {
      const u = new URL(url, window.location.href);
      return u.hostname.includes("amazon.") && /(^|\/)similar(\/|$|\?)/i.test(u.pathname + u.search);
    } catch {
      return /amazon\..*similar|\/similar(?:\/|\?|$)/i.test(String(url || ""));
    }
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__relayFetcherBlockedSimilar = isSimilarRequest(url);
    this.__relayFetcherBlockedUrl = url;
    return _origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__relayFetcherBlockedSimilar) {
      try {
        this.abort();
      } catch (e) {}
      return;
    }
    return _origXHRSend.apply(this, args);
  };

  window.fetch = async function (...args) {
    const [resource, config] = args;
    const url = typeof resource === "string" ? resource : resource?.url || "";

    if (isSimilarRequest(url)) {
      return new Response(null, { status: 204, statusText: "Blocked by Relay Fetcher" });
    }

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
          const searchSeq = ++autoSearchSeq;
          // Intercept the response to broadcast to content script
          const response = await _origFetch.apply(this, args);
          const clone = response.clone();
          try {
            const data = await clone.json();
            const firstPageLoads = data.workOpportunities || [];
            const totalResults = data.totalResultsSize || firstPageLoads.length;
            const hasMorePages = data.nextItemToken != null && firstPageLoads.length > 0 && firstPageLoads.length < totalResults;
            if (hasMorePages) {
              window.dispatchEvent(new CustomEvent("relay-fetcher-auto-update", {
                detail: JSON.stringify({ data: { ...data, _rfxPartialPage: true }, payload: parsed, seq: searchSeq }),
              }));
              fetchRemainingSearchPages(parsed, data, capturedCsrfToken, searchSeq);
            } else {
              window.dispatchEvent(new CustomEvent("relay-fetcher-auto-update", {
                detail: JSON.stringify({ data, payload: parsed, seq: searchSeq }),
              }));
            }
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

  async function fetchRemainingSearchPages(basePayload, firstPageData, csrfToken, searchSeq) {
    const allLoads = [...(firstPageData.workOpportunities || [])];
    let carrierDetails = firstPageData.carrierDetails || null;
    let searchAuditId = firstPageData.searchAuditId || null;
    let nextToken = firstPageData.nextItemToken;
    let totalResults = firstPageData.totalResultsSize || allLoads.length;
    let pageNum = 1;

    try {
      while (nextToken != null && allLoads.length < totalResults && pageNum < 10) {
        pageNum++;
        const payload = { ...basePayload, nextItemToken: nextToken, resultSize: 50, _isRelayFetcher: true };
        const response = await _origFetch("https://relay.amazon.com/api/loadboard/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
          credentials: "include",
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (data.errorCode) throw new Error(data.message || data.errorCode);
        carrierDetails = data.carrierDetails || carrierDetails;
        searchAuditId = data.searchAuditId || searchAuditId;
        const loads = data.workOpportunities || [];
        allLoads.push(...loads);
        totalResults = data.totalResultsSize || totalResults;
        nextToken = data.nextItemToken;
        if (!loads.length) break;
      }

      window.dispatchEvent(new CustomEvent("relay-fetcher-auto-update", {
        detail: JSON.stringify({
          data: {
            ...firstPageData,
            workOpportunities: allLoads,
            totalResultsSize: totalResults,
            carrierDetails,
            searchAuditId,
            nextItemToken: nextToken,
            _rfxPaginated: true,
          },
          payload: basePayload,
          seq: searchSeq,
        }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-auto-update", {
        detail: JSON.stringify({
          data: { ...firstPageData, _rfxPaginationFailed: true },
          payload: basePayload,
          seq: searchSeq,
        }),
      }));
    }
  }

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
    let carrierDetails = null, searchAuditId = null;
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
        carrierDetails = data.carrierDetails || carrierDetails;
        searchAuditId = data.searchAuditId || searchAuditId;
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
        detail: JSON.stringify({ status: 200, data: { workOpportunities: allLoads, totalResultsSize: totalResults, carrierDetails, searchAuditId } }),
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
      const allLoads = [];
      let carrierDetails = null, searchAuditId = null;
      let nextToken = 0, totalResults = 0, lastStatus = 200;

      while (true) {
        const payload = { ...basePayload, nextItemToken: nextToken, resultSize: 50, _isRelayFetcher: true };
        const response = await _origFetch("https://relay.amazon.com/api/loadboard/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
          credentials: "include",
          body: JSON.stringify(payload),
        });
        lastStatus = response.status;
        const data = await response.json();
        if (data.errorCode) {
          window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
            detail: JSON.stringify({ status: response.status, data }),
          }));
          return;
        }

        carrierDetails = data.carrierDetails || carrierDetails;
        searchAuditId = data.searchAuditId || searchAuditId;
        const loads = data.workOpportunities || [];
        allLoads.push(...loads);
        totalResults = data.totalResultsSize || totalResults;
        if (data.nextItemToken == null || loads.length === 0 || allLoads.length >= totalResults) break;
        nextToken = data.nextItemToken;
      }

      const data = {
        workOpportunities: allLoads,
        totalResultsSize: totalResults || allLoads.length,
        carrierDetails,
        searchAuditId,
      };

      // Capture token from our own request
      if (csrfToken && !capturedCsrfToken) capturedCsrfToken = csrfToken;
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ status: lastStatus, data }),
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

  // Direct booking request — mirrors Amazon's confirm booking endpoint.
  window.addEventListener("relay-fetcher-book-direct", async (e) => {
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
      const response = await _origFetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
        credentials: "include",
        body: JSON.stringify(req.payload),
      });

      let data = null;
      const text = await response.text();
      if (text) {
        try { data = JSON.parse(text); }
        catch { data = { raw: text }; }
      }

      window.dispatchEvent(new CustomEvent("relay-fetcher-book-direct-result", {
        detail: JSON.stringify({ woId: req.woId, status: response.status, ok: response.ok, data }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-book-direct-result", {
        detail: JSON.stringify({ woId: req.woId, error: err.message }),
      }));
    }
  });

})();
