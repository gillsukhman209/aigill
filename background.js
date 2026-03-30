// Service worker — listens for popup messages and forwards to content script

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchLoads") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes("relay.amazon.com")) {
        sendResponse({ error: "Navigate to relay.amazon.com/loadboard first" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: "fetchLoads" }, (response) => {
        sendResponse(response || { error: "No response from content script" });
      });
    });
    return true;
  }

  if (message.action === "getCsrfToken") {
    // Try multiple possible cookie names for the CSRF token
    const cookieNames = ["x-csrf-token", "csrf-token", "anti-csrftoken-a2z", "XSRF-TOKEN"];
    let found = false;

    let remaining = cookieNames.length;
    for (const name of cookieNames) {
      chrome.cookies.get({ url: "https://relay.amazon.com", name }, (cookie) => {
        remaining--;
        if (cookie && !found) {
          found = true;
          sendResponse({ token: cookie.value });
        } else if (remaining === 0 && !found) {
          // None found — list all cookies for debugging
          chrome.cookies.getAll({ domain: "relay.amazon.com" }, (allCookies) => {
            console.log("[Relay BG] All relay.amazon.com cookies:", allCookies.map(c => c.name));
            sendResponse({ token: null, cookieNames: allCookies.map(c => c.name) });
          });
        }
      });
    }
    return true;
  }
});
