// Service worker — keepalive + message routing

// Keep service worker alive while bot is running
let botRunning = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "botStarted") {
    botRunning = true;
    chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
    sendResponse({ ok: true });
  }
  if (message.action === "botStopped") {
    botRunning = false;
    chrome.alarms.clear("keepalive");
    sendResponse({ ok: true });
  }
  if (message.action === "fetchLoads") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.url?.includes("relay.amazon.com")) {
        sendResponse({ error: "Navigate to relay.amazon.com/loadboard first" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: "fetchLoads" }, (response) => {
        sendResponse(response || { error: "No response from content script" });
      });
    });
    return true;
  }
  if (message.action === "sendDiscordWebhook") {
    const { webhookUrl, payload } = message;
    if (!webhookUrl || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(webhookUrl)) {
      sendResponse({ ok: false, error: "Discord webhook is not configured" });
      return;
    }
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        sendResponse({ ok: false, error: `Discord returned ${res.status}${text ? `: ${text}` : ""}` });
        return;
      }
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && botRunning) {
    // Ping content script to keep connection alive
    chrome.tabs.query({ url: "https://relay.amazon.com/loadboard/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { action: "keepalive" }).catch(() => {});
      }
    });
  }
});
