// Runs in the PAGE's main world at document_start

(function () {
  let capturedCsrfToken = null;
  let lastSearchPayload = null;
  let lastPatRequest = null;
  let autoSearchSeq = 0;
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;
  const _origXHRSend = XMLHttpRequest.prototype.send;
  const _origXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  function isSimilarRequest(url) {
    try {
      const u = new URL(url, window.location.href);
      return u.hostname.includes("amazon.") && /(^|\/)similar(\/|$|\?)/i.test(u.pathname + u.search);
    } catch {
      return /amazon\..*similar|\/similar(?:\/|\?|$)/i.test(String(url || ""));
    }
  }

  function getCsrfToken() {
    if (capturedCsrfToken) return capturedCsrfToken;
    const cookies = document.cookie.split(";");
    for (const c of cookies) {
      const t = c.trim();
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const n = t.substring(0, eq);
      const v = t.substring(eq + 1);
      if (n === "x-csrf-token" || n === "csrf-token" || n === "anti-csrftoken-a2z") {
        capturedCsrfToken = decodeURIComponent(v);
        break;
      }
    }
    return capturedCsrfToken;
  }

  function looksLikePatPayload(payload) {
    const hasOrigin = !!(payload?.originCityInfo || payload?.originLocation || payload?.startLocation);
    const hasDestination = !!(
      (Array.isArray(payload?.endLocationList) && payload.endLocationList.length) ||
      payload?.destinationCityInfo ||
      payload?.destinationLocation ||
      payload?.endLocation
    );
    const hasPrice = !!(payload?.totalCost || payload?.payout || payload?.minimumPayout);
    const hasEquipment = !!(payload?.providedTrailerType || payload?.equipmentType || payload?.equipmentTypes);
    return !!(
      payload &&
      typeof payload === "object" &&
      hasOrigin &&
      hasDestination &&
      payload.startTime &&
      payload.endTime &&
      hasPrice &&
      (payload.runType || hasEquipment)
    );
  }

  function isPatCreateRequest(url, payload) {
    if (!looksLikePatPayload(payload)) return false;
    if (payload.id || payload.orderId || payload.alias || payload.status || payload.demandId || payload.linkedOrderId) return false;
    try {
      const parsedUrl = new URL(url, window.location.href);
      if (parsedUrl.hostname !== "relay.amazon.com") return false;
      const path = parsedUrl.pathname.toLowerCase().replace(/\/+$/, "");
      const prefix = "/api/loadboard/orders";
      if (path === prefix) return true;
      if (!path.startsWith(`${prefix}/`)) return false;
      const segments = path.slice(prefix.length + 1).split("/").filter(Boolean);
      if (!segments.length || segments.length > 2) return false;
      if (segments.some(segment => !/^[a-z][a-z0-9-]*$/.test(segment))) return false;
      return !segments.some(segment => /^(?:get|list|cancel|update|edit|preview|match|search|delete|status|close|expire|repost)$/.test(segment));
    } catch {
      return false;
    }
  }

  function capturePatCreateRequest(url, payload) {
    if (payload?._isRelayFetcher || payload?._isNegotiator || !isPatCreateRequest(url, payload)) return false;
    lastPatRequest = {
      url: new URL(url, window.location.href).href,
      payload,
    };
    window.dispatchEvent(new CustomEvent("relay-fetcher-pat-template", {
      detail: JSON.stringify(lastPatRequest),
    }));
    return true;
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__relayFetcherBlockedSimilar = isSimilarRequest(url);
    this.__relayFetcherBlockedUrl = url;
    this.__relayFetcherMethod = String(method || "GET").toUpperCase();
    return _origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__relayFetcherBlockedSimilar) {
      try {
        this.abort();
      } catch (e) {}
      return;
    }
    if (this.__relayFetcherMethod === "POST" && this.__relayFetcherBlockedUrl && args[0]) {
      try {
        const payload = typeof args[0] === "string" ? JSON.parse(args[0]) : null;
        if (payload) capturePatCreateRequest(this.__relayFetcherBlockedUrl, payload);
      } catch (e) {}
    }
    return _origXHRSend.apply(this, args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const headerName = String(name || "").toLowerCase();
    if (headerName === "x-csrf-token" || headerName === "anti-csrftoken-a2z") {
      capturedCsrfToken = String(value || "");
    }
    return _origXHRSetRequestHeader.call(this, name, value);
  };

  window.fetch = async function (...args) {
    const [resource, config] = args;
    const url = typeof resource === "string" ? resource : resource?.url || "";

    if (isSimilarRequest(url)) {
      return new Response(null, { status: 204, statusText: "Blocked by Relay Fetcher" });
    }

    const requestHeaders = config?.headers || resource?.headers;
    if (requestHeaders) {
      let token = null;
      if (requestHeaders instanceof Headers) {
        token = requestHeaders.get("x-csrf-token") || requestHeaders.get("anti-csrftoken-a2z");
      } else if (typeof requestHeaders === "object") {
        token = requestHeaders["x-csrf-token"] || requestHeaders["anti-csrftoken-a2z"];
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
          window.dispatchEvent(new CustomEvent("relay-fetcher-search-start", {
            detail: JSON.stringify({ payload: parsed, seq: searchSeq }),
          }));
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

    // Capture Amazon's own Post-A-Truck order list so the content script can cancel only visible
    // active PAT orders instead of guessing which orders exist.
    if (url.includes("/api/loadboard/orders/get") && config?.method === "POST") {
      const response = await _origFetch.apply(this, args);
      const clone = response.clone();
      try {
        const data = await clone.json();
        window.dispatchEvent(new CustomEvent("relay-fetcher-pat-orders", {
          detail: JSON.stringify({ data }),
        }));
      } catch (e) {}
      return response;
    }

    // Capture Amazon's own Post-A-Truck create request so our content script can reuse the
    // current endpoint and baseline request shape instead of guessing private routes.
    const requestMethod = String(config?.method || resource?.method || "GET").toUpperCase();
    if (requestMethod === "POST") {
      try {
        const bodyText = typeof config?.body === "string"
          ? config.body
          : resource?.clone && url.includes("/api/loadboard/orders")
            ? await resource.clone().text()
            : "";
        if (bodyText) capturePatCreateRequest(url, JSON.parse(bodyText));
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
    const seenPageTokens = new Set();

    try {
      while (nextToken != null && allLoads.length < totalResults) {
        if (searchSeq !== autoSearchSeq) return;
        const tokenKey = JSON.stringify(nextToken);
        if (seenPageTokens.has(tokenKey)) throw new Error("Relay repeated a pagination token");
        seenPageTokens.add(tokenKey);
        pageNum++;
        if (pageNum > 100) throw new Error("Relay pagination exceeded 100 pages");
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

      if (searchSeq !== autoSearchSeq) return;

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
      if (searchSeq !== autoSearchSeq) return;
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
    const seenPageTokens = new Set();

    try {
      while (true) {
        const tokenKey = JSON.stringify(nextToken);
        if (seenPageTokens.has(tokenKey)) throw new Error("Relay repeated a pagination token");
        seenPageTokens.add(tokenKey);
        pageNum++;
        if (pageNum > 100) throw new Error("Relay pagination exceeded 100 pages");
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
    const searchSeq = autoSearchSeq;
    const requestId = request.requestId;
    if (!basePayload) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ error: "No search filters. Search on the page first.", seq: searchSeq, requestId }),
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
      let pageNum = 0;
      const seenPageTokens = new Set();

      while (true) {
        if (searchSeq !== autoSearchSeq) return;
        const tokenKey = JSON.stringify(nextToken);
        if (seenPageTokens.has(tokenKey)) throw new Error("Relay repeated a pagination token");
        seenPageTokens.add(tokenKey);
        pageNum++;
        if (pageNum > 100) throw new Error("Relay pagination exceeded 100 pages");
        const payload = { ...basePayload, nextItemToken: nextToken, resultSize: 50, _isRelayFetcher: true };
        const response = await _origFetch("https://relay.amazon.com/api/loadboard/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
          credentials: "include",
          body: JSON.stringify(payload),
        });
        lastStatus = response.status;
        const data = await response.json();
        if (searchSeq !== autoSearchSeq) return;
        if (data.errorCode) {
          window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
            detail: JSON.stringify({ status: response.status, data, seq: searchSeq, requestId }),
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
      if (searchSeq !== autoSearchSeq) return;
      if (csrfToken && !capturedCsrfToken) capturedCsrfToken = csrfToken;
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ status: lastStatus, data, seq: searchSeq, requestId }),
      }));
    } catch (err) {
      if (searchSeq !== autoSearchSeq) return;
      window.dispatchEvent(new CustomEvent("relay-fetcher-poll-result", {
        detail: JSON.stringify({ error: err.message, seq: searchSeq, requestId }),
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

  // Post-A-Truck request — reuses the most recently captured Amazon PAT endpoint.
  window.addEventListener("relay-fetcher-pat-post", async (e) => {
    const req = JSON.parse(e.detail);
    const url = req.url || lastPatRequest?.url;
    if (!url || !isPatCreateRequest(url, req.payload)) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-pat-post-result", {
        detail: JSON.stringify({ woId: req.woId, error: "No validated PAT create endpoint captured" }),
      }));
      return;
    }

    const csrfToken = getCsrfToken();
    try {
      const response = await _origFetch(url, {
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

      window.dispatchEvent(new CustomEvent("relay-fetcher-pat-post-result", {
        detail: JSON.stringify({ woId: req.woId, status: response.status, ok: response.ok, data }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-pat-post-result", {
        detail: JSON.stringify({ woId: req.woId, error: err.message }),
      }));
    }
  });

  window.addEventListener("relay-fetcher-pat-cancel-all", async (e) => {
    let req = {};
    try {
      req = JSON.parse(e.detail || "{}");
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-pat-cancel-all-result", {
        detail: JSON.stringify({ error: "Invalid cancel request" }),
      }));
      return;
    }

    const orders = Array.isArray(req.orders) ? req.orders : [];
    if (!orders.length) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-pat-cancel-all-result", {
        detail: JSON.stringify({ results: [] }),
      }));
      return;
    }

    const csrfToken = getCsrfToken();
    const results = [];
    for (const order of orders) {
      const id = String(order?.id || "");
      const version = Number(order?.version || 1);
      if (!id || !Number.isFinite(version) || version <= 0) {
        results.push({ id, version, ok: false, error: "Missing order id/version" });
        continue;
      }

      try {
        const response = await _origFetch(`https://relay.amazon.com/api/loadboard/orders/cancel/${encodeURIComponent(id)}/${encodeURIComponent(String(version))}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
          credentials: "include",
          body: JSON.stringify({
            cancellationReason: "BOOKED_LOAD_ON_RELAY_LOADBOARD",
            cancellationComment: "",
          }),
        });
        let data = null;
        const text = await response.text();
        if (text) {
          try { data = JSON.parse(text); }
          catch { data = { raw: text }; }
        }
        results.push({ id, version, status: response.status, ok: response.ok, data });
      } catch (err) {
        results.push({ id, version, ok: false, error: err.message });
      }
    }

    window.dispatchEvent(new CustomEvent("relay-fetcher-pat-cancel-all-result", {
      detail: JSON.stringify({ results }),
    }));
  });

})();
