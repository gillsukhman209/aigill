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
