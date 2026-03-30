const btn = document.getElementById("fetchBtn");
const status = document.getElementById("status");

btn.addEventListener("click", () => {
  btn.disabled = true;
  status.textContent = "Fetching loads...";

  chrome.runtime.sendMessage({ action: "fetchLoads" }, (response) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      status.textContent = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    if (response?.error) {
      status.textContent = response.error;
    } else if (response?.success) {
      status.textContent = `Done — ${response.loadCount} loads fetched (${response.totalResults} total). Check the page console (F12) for details.`;
    } else {
      status.textContent = "No response. Make sure you're on relay.amazon.com/loadboard";
    }
  });
});
