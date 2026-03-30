// Runs in the PAGE's main world at document_start
// Has full access to cookies, CSRF, same-origin credentials — just like the page's own code

(function () {
  // Capture CSRF token from the page's own outgoing requests
  let capturedCsrfToken = null;
  const _origFetch = window.fetch;

  window.fetch = async function (...args) {
    const [resource, config] = args;

    // Sniff CSRF token from any request that sends one
    if (config?.headers) {
      let token = null;
      if (config.headers instanceof Headers) {
        token = config.headers.get("x-csrf-token") || config.headers.get("anti-csrftoken-a2z");
      } else if (typeof config.headers === "object") {
        token = config.headers["x-csrf-token"] || config.headers["anti-csrftoken-a2z"];
      }
      if (token) {
        capturedCsrfToken = token;
      }
    }

    return _origFetch.apply(this, args);
  };

  // Listen for fetch request from the content script (isolated world)
  window.addEventListener("relay-fetcher-fetch", async (e) => {
    const payload = JSON.parse(e.detail);

    // Use captured token, or try cookie
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

    console.log("[Relay MAIN] Making fetch from page context, CSRF:", csrfToken ? csrfToken.substring(0, 15) + "..." : "NOT FOUND");

    try {
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

      // Send result back to content script
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: response.status, data }),
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("relay-fetcher-result", {
        detail: JSON.stringify({ status: 0, error: err.message }),
      }));
    }
  });

  console.log("[Relay Interceptor] Installed (MAIN world). Ready to fetch on demand.");
})();
