// Content script — relay.amazon.com/loadboard/* (isolated world)
// Custom UI + Bot polling + Detection logic

// ============================================================
// INJECT INTERCEPTOR INTO MAIN WORLD
// Safari doesn't support "world": "MAIN" in manifest, so we inject manually
// ============================================================
(function injectInterceptor() {
  if (!/\/loadboard(?:\/|$)/.test(window.location.pathname || "")) return;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("interceptor.js");
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).prepend(script);
})();

// ============================================================
// STATE
// ============================================================
let allLoads = [];
let knownIds = new Set();
let currentSort = "payout";
let currentSortDir = "desc";
let aiModeActive = true;
let amazonContainer = null;
let ourHost = null;
let shadowRoot = null;
let carrierDetails = null;
let currentSearchAuditId = null;
let currentSearchSignature = "";
let pendingPartialSearchSignature = "";
let latestAutoSearchSeq = 0;
let lastNonEmptySearchAt = 0;

// Settings (persisted to localStorage)
const SETTINGS_KEY = "rfx_settings";
const DEFAULT_CUSTOM_EXCLUDED_CITY_LABELS = [
  "American Canyon, CA",
  "Brisbane, CA",
  "Fairfield, CA",
  "Hollister, CA",
  "Livermore, CA",
  "Modesto, CA",
  "Newark, CA",
  "Rancho Cordova, CA",
  "Reno",
  "Richmond, CA",
  "Roseville, CA",
  "San Francisco, CA",
  "San Jose, CA",
  "San Pablo, CA",
  "Santa Clarita",
  "South San Francisco",
];
function normalizeDefaultExcludedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeDefaultExcludedCityEntry(label) {
  const parts = String(label || "").split(",").map(part => part.trim()).filter(Boolean);
  const cityText = parts[0] || "";
  const stateText = parts[1] || "";
  const city = normalizeDefaultExcludedText(cityText);
  const state = stateText.length === 2 ? stateText.toUpperCase() : "";
  const key = [city, state.toLowerCase()].filter(Boolean).join(" ");
  return key ? { key, city, state, label: String(label || "").trim() } : null;
}

const DEFAULT_CUSTOM_EXCLUDED_CITIES = DEFAULT_CUSTOM_EXCLUDED_CITY_LABELS
  .map(makeDefaultExcludedCityEntry)
  .filter(Boolean);
const DEFAULT_CUSTOM_EXCLUDED_CITY_KEYS = new Set(DEFAULT_CUSTOM_EXCLUDED_CITIES.map(entry => entry.key));

function normalizeCustomExcludedCityList(cities, removedDefaultKeys = settings?.removedDefaultExcludedCityKeys || []) {
  const removed = new Set((removedDefaultKeys || []).filter(Boolean));
  const unique = new Map(DEFAULT_CUSTOM_EXCLUDED_CITIES.filter(city => !removed.has(city.key)).map(city => [city.key, city]));
  for (const item of cities || []) {
    const entry = typeof item === "string" ? makeDefaultExcludedCityEntry(item) : item;
    if (!entry?.key) continue;
    unique.set(entry.key, entry);
  }
  return Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label));
}

const DEFAULT_SETTINGS = {
  pollMinSeconds: 2,
  pollMaxSeconds: 5,
  showScoreBar: true,
  showPerHr: true,
  showPerMi: true,
  showDistance: true,
  showDuration: true,
  showVersionBadge: true,
  showStopAddress: true,
  showLegDistance: true,
  showDwellTime: true,
  showCheckoutTime: false,
  showFlexibleArrivalWindow: true,
  showLoadTypeBadge: true,
  showPostedAge: true,
  showDriverType: true,
  showEquipment: true,
  showStopCount: true,
  showStopCode: true,
  showExtraStopMeta: true,
  showTimingRisk: true,
  minStemTimeMinutes: 0,
  amazonOnlyFacilities: false,
  patEnabled: false,
  hideFuzzyPatFooter: true,
  hideFuzzyPatFooterUserSet: false,
  fastBook: false,
  autoBook: false,
  autoResume: false,
  minPriceIncrease: 0,
  showRoundTrips: true,
  roundTripConnectionRadiusMiles: 35,
  roundTripReturnRadiusMiles: 35,
  roundTripMinBufferMinutes: 30,
  roundTripMaxWaitHours: 12,
  roundTripMinPayout: 0,
  roundTripMinPerMile: 0,
  roundTripRequireSameDriver: true,
  roundTripRequireSameEquipment: true,
  roundTripsCollapsed: false,
  customExcludedCities: DEFAULT_CUSTOM_EXCLUDED_CITIES,
  removedDefaultExcludedCityKeys: [],
  ignoredLoadIds: [],
  discordWebhookUrl: "https://discord.com/api/webhooks/1519115434975297677/i9M8iFOM_e1BOTnxGDmHSFKvQQ2wIHAOMM84K147MqO97_axmqQi5l4QxeXerydPweFL",
  lookoutEnabled: false,
  lookoutGroups: [],
  lookoutRules: [],
  lookoutPriceRealert: 25,
  detectionOnlyAlertMatchingRules: false,
  detectionFilterBoard: false,
  detectionGroups: [],
  detectionRules: [],
  customDateFilterEnabled: false,
  customDateFilterStart: "",
  customDateFilterEnd: "",
  customDateFilterCollapsed: false,
  bookedTimeBlocks: [],
  bookedTimeBlockMode: "warn",
  showProfitEstimate: true,
  profitMpg: 8,
  profitFuelPrice: 6.50,
  profitDeadheadMiles: 0,
  profitReturnMiles: 0,
  themeMode: "system",
};
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (s) settings = { ...DEFAULT_SETTINGS, ...s }; } catch {}
  settings.customExcludedCities = normalizeCustomExcludedCityList(settings.customExcludedCities);
  settings.bookedTimeBlocks = normalizeBookedTimeBlocks(settings.bookedTimeBlocks);
  if (!["warn", "hide"].includes(settings.bookedTimeBlockMode)) settings.bookedTimeBlockMode = "warn";
  if (!["system", "light", "dark"].includes(settings.themeMode)) settings.themeMode = "system";
  if (!settings.hideFuzzyPatFooterUserSet) settings.hideFuzzyPatFooter = true;
  if (settings.autoBook) {
    settings.autoResume = false;
    settings.amazonOnlyFacilities = true;
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
loadSettings();

function getThemeClass() {
  const mode = settings.themeMode || "system";
  if (mode === "dark") return "rfx-theme-dark";
  if (mode === "light") return "rfx-theme-light";
  return "rfx-theme-system";
}

const RFX_SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
const PAGE_FONT_RESET_STYLE_ID = "rfx-page-font-reset-style";
const PAGE_DARK_STYLE_ID = "rfx-page-dark-style";
let pageThemeMediaListenerInstalled = false;

function isPageDarkThemeActive() {
  const mode = settings.themeMode || "system";
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

const PAGE_FONT_RESET_CSS = `
html body,
html body :where(button, input, select, textarea, [role="button"], [role="combobox"], [role="textbox"], [mdn-select-value]) {
  font-family: ${RFX_SYSTEM_FONT_STACK} !important;
}
`;

function ensurePageFontReset() {
  let style = document.getElementById(PAGE_FONT_RESET_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = PAGE_FONT_RESET_STYLE_ID;
  }
  style.textContent = PAGE_FONT_RESET_CSS;
  (document.head || document.documentElement).appendChild(style);
}

ensurePageFontReset();

const PAGE_DARK_CSS = `
html.rfx-page-dark {
  color-scheme: dark !important;
  background: #0f1418 !important;
}

html.rfx-page-dark body,
html.rfx-page-dark #application,
html.rfx-page-dark #app-container,
html.rfx-page-dark #base-container-body,
html.rfx-page-dark main {
  background: #0f1418 !important;
  color: #f3f6f7 !important;
}

html.rfx-page-dark #application :where(div, section, main, aside, form, header, footer, nav, article) {
  background-color: transparent !important;
  border-color: #33404a !important;
  color: inherit;
}

html.rfx-page-dark #application :where([style*="background"], [style*="background-color"]) {
  background-color: transparent !important;
}

html.rfx-page-dark #application :where(label, span, p, h1, h2, h3, h4, h5, h6, strong, small),
html.rfx-page-dark #utility-bar :where(label, span, p, div, button) {
  color: inherit;
}

html.rfx-page-dark #application :where(a) {
  color: #7dd3fc !important;
}

html.rfx-page-dark #application :where([aria-disabled="true"], [disabled]) {
  opacity: .58 !important;
}

html.rfx-page-dark #application :where([mdn-input-box]) {
  background: #151d24 !important;
  border: 1px solid #51606b !important;
  border-radius: 4px !important;
  box-shadow: none !important;
  color: #f3f6f7 !important;
}

html.rfx-page-dark #application :where([mdn-input-box] *) {
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  outline: none !important;
  color: inherit;
}

html.rfx-page-dark #application :where([mdn-input-box] label) {
  color: #cbd5dd !important;
  -webkit-text-fill-color: #cbd5dd !important;
}

html.rfx-page-dark #application :where(input:not([type="checkbox"]):not([type="radio"]), select, textarea, [mdn-select-value], [role="combobox"], [role="textbox"]) {
  color: #f3f6f7 !important;
  -webkit-text-fill-color: #f3f6f7 !important;
  box-shadow: none !important;
  outline: none !important;
}

html.rfx-page-dark #application :where(input:not([type="checkbox"]):not([type="radio"]), select, textarea):not([mdn-input-box] *) {
  background: #151d24 !important;
  border: 1px solid #51606b !important;
}

html.rfx-page-dark #application :where(input::placeholder, textarea::placeholder) {
  color: #94a3ad !important;
  -webkit-text-fill-color: #94a3ad !important;
}

html.rfx-page-dark #application :where(input[type="checkbox"], input[type="radio"]) {
  accent-color: #078b75 !important;
  -webkit-text-fill-color: initial !important;
}

html.rfx-page-dark #application :where(input[type="date"]::-webkit-calendar-picker-indicator, input[type="time"]::-webkit-calendar-picker-indicator, input[type="datetime-local"]::-webkit-calendar-picker-indicator) {
  filter: invert(1) brightness(1.4) !important;
  opacity: .9 !important;
}

html.rfx-page-dark #application :where(option, optgroup) {
  background: #151d24 !important;
  color: #f3f6f7 !important;
}

/* iOS Safari can render Relay form controls outside #application and paints
   date/time values through WebKit-only internal parts. Keep every native value readable. */
html.rfx-page-dark body :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="color"]):not([type="file"]):not([type="hidden"]), select, textarea, [mdn-select-value], [role="combobox"], [role="textbox"]) {
  color-scheme: dark !important;
  color: #f3f6f7 !important;
  -webkit-text-fill-color: #f3f6f7 !important;
  caret-color: #f3f6f7 !important;
  opacity: 1 !important;
}

html.rfx-page-dark body [mdn-input-box],
html.rfx-page-dark body [mdn-input-box] :where(input, select, textarea, [mdn-select-value], [role="combobox"], [role="textbox"]) {
  color: #f3f6f7 !important;
  -webkit-text-fill-color: #f3f6f7 !important;
}

html.rfx-page-dark body :where(input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"] input, [aria-disabled="true"] select, [aria-disabled="true"] textarea) {
  color: #dce5e9 !important;
  -webkit-text-fill-color: #dce5e9 !important;
  opacity: 1 !important;
  -webkit-opacity: 1 !important;
}

html.rfx-page-dark body :where(input::placeholder, textarea::placeholder) {
  color: #94a3ad !important;
  -webkit-text-fill-color: #94a3ad !important;
  opacity: 1 !important;
}

html.rfx-page-dark body input[type="date"]::-webkit-date-and-time-value,
html.rfx-page-dark body input[type="time"]::-webkit-date-and-time-value,
html.rfx-page-dark body input[type="datetime-local"]::-webkit-date-and-time-value,
html.rfx-page-dark body input::-webkit-datetime-edit,
html.rfx-page-dark body input::-webkit-datetime-edit-fields-wrapper,
html.rfx-page-dark body input::-webkit-datetime-edit-text,
html.rfx-page-dark body input::-webkit-datetime-edit-day-field,
html.rfx-page-dark body input::-webkit-datetime-edit-month-field,
html.rfx-page-dark body input::-webkit-datetime-edit-year-field,
html.rfx-page-dark body input::-webkit-datetime-edit-hour-field,
html.rfx-page-dark body input::-webkit-datetime-edit-minute-field,
html.rfx-page-dark body input::-webkit-datetime-edit-ampm-field {
  color: #f3f6f7 !important;
  -webkit-text-fill-color: #f3f6f7 !important;
  opacity: 1 !important;
}

html.rfx-page-dark body :where(input[type="date"], input[type="time"], input[type="datetime-local"])::-webkit-calendar-picker-indicator {
  filter: invert(1) brightness(1.5) !important;
  opacity: 1 !important;
}

html.rfx-page-dark body :where([mdn-input-box], [role="combobox"]) :where(svg, img) {
  filter: invert(1) brightness(1.5) !important;
  opacity: 1 !important;
}

html.rfx-page-dark body :where(option, optgroup) {
  background: #151d24 !important;
  color: #f3f6f7 !important;
  -webkit-text-fill-color: #f3f6f7 !important;
}

html.rfx-page-dark #application :where(button, [role="button"]):not([class^="rfx-"]):not([class*=" rfx-"]):not([id^="rfx-"]):not([id*=" rfx-"]) {
  background-color: transparent !important;
  box-shadow: none !important;
  border-color: #33404a !important;
  color: #f3f6f7 !important;
}

html.rfx-page-dark #application :where(svg) {
  color: #e5edf0 !important;
  stroke: currentColor;
}

html.rfx-page-dark #application :where([class*="chip"], [class*="Chip"], [class*="tag"], [class*="Tag"], [class*="pill"], [class*="Pill"]) {
  background-color: #173044 !important;
  color: #dff7ff !important;
  border-color: #2f6f8f !important;
}

html.rfx-page-dark #utility-bar,
html.rfx-page-dark .utility-bar__default,
html.rfx-page-dark #utility-bar > div,
html.rfx-page-dark .utility-bar__default > div,
html.rfx-page-dark #utility-bar .refresh-and-chat-box {
  background: #0f1418 !important;
  background-color: #0f1418 !important;
  border-color: #33404a !important;
  box-shadow: none !important;
  color: #f3f6f7 !important;
}

html.rfx-page-dark #utility-bar {
  border: 0 !important;
  border-top: 1px solid #33404a !important;
}

html.rfx-page-dark #utility-bar :where(button, [role="button"]) {
  background: transparent !important;
  background-color: transparent !important;
  color: #f3f6f7 !important;
  border-color: #33404a !important;
  box-shadow: none !important;
}

html.rfx-page-dark #utility-bar .utility-bar__divider,
html.rfx-page-dark #utility-bar [style*="background: rgb(187, 192, 193)"] {
  background: #33404a !important;
  background-color: #33404a !important;
}

html.rfx-page-dark #application .chat-box-position,
html.rfx-page-dark .chat-box-position {
  color-scheme: light !important;
  background: #ffffff !important;
  background-color: #ffffff !important;
  border-color: #d5d9d9 !important;
  color: #0f1111 !important;
  -webkit-text-fill-color: initial !important;
  box-shadow: 0 2px 8px rgba(15, 17, 17, 0.2) !important;
}

html.rfx-page-dark #application .chat-box-position :where(div, section, main, aside, form, header, footer, nav, article),
html.rfx-page-dark .chat-box-position :where(div, section, main, aside, form, header, footer, nav, article) {
  background-color: transparent !important;
  border-color: #d5d9d9 !important;
  color: #0f1111 !important;
}

html.rfx-page-dark #application .chat-box-position :where(label, span, p, h1, h2, h3, h4, h5, h6, strong, small, li),
html.rfx-page-dark .chat-box-position :where(label, span, p, h1, h2, h3, h4, h5, h6, strong, small, li) {
  color: #0f1111 !important;
  -webkit-text-fill-color: #0f1111 !important;
}

html.rfx-page-dark #application .chat-box-position :where(input:not([type="checkbox"]):not([type="radio"]), select, textarea, [mdn-select-value], [role="combobox"], [role="textbox"]),
html.rfx-page-dark .chat-box-position :where(input:not([type="checkbox"]):not([type="radio"]), select, textarea, [mdn-select-value], [role="combobox"], [role="textbox"]) {
  color-scheme: light !important;
  background: #ffffff !important;
  background-color: #ffffff !important;
  border: 1px solid #879596 !important;
  color: #0f1111 !important;
  -webkit-text-fill-color: #0f1111 !important;
}

html.rfx-page-dark .chat-box-position input[type="date"]::-webkit-date-and-time-value,
html.rfx-page-dark .chat-box-position input[type="time"]::-webkit-date-and-time-value,
html.rfx-page-dark .chat-box-position input[type="datetime-local"]::-webkit-date-and-time-value,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-fields-wrapper,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-text,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-day-field,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-month-field,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-year-field,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-hour-field,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-minute-field,
html.rfx-page-dark .chat-box-position input::-webkit-datetime-edit-ampm-field {
  color: #0f1111 !important;
  -webkit-text-fill-color: #0f1111 !important;
}

html.rfx-page-dark .chat-box-position :where(input[type="date"], input[type="time"], input[type="datetime-local"])::-webkit-calendar-picker-indicator {
  filter: none !important;
  opacity: 1 !important;
}

html.rfx-page-dark #application .chat-box-position :where(button, [role="button"]):not([id^="rfx-"]):not([class^="rfx-"]):not([class*=" rfx-"]),
html.rfx-page-dark .chat-box-position :where(button, [role="button"]):not([id^="rfx-"]):not([class^="rfx-"]):not([class*=" rfx-"]) {
  background-color: transparent !important;
  color: #0f1111 !important;
  border-color: #d5d9d9 !important;
  opacity: 1 !important;
}

html.rfx-page-dark #application .chat-box-position :where(button, [role="button"]):not([id^="rfx-"]):not([class^="rfx-"]):not([class*=" rfx-"]) :where(span, svg, path, circle, rect, line, polyline, polygon),
html.rfx-page-dark .chat-box-position :where(button, [role="button"]):not([id^="rfx-"]):not([class^="rfx-"]):not([class*=" rfx-"]) :where(span, svg, path, circle, rect, line, polyline, polygon) {
  color: #0f1111 !important;
  -webkit-text-fill-color: #0f1111 !important;
  fill: currentColor !important;
  stroke: currentColor !important;
  opacity: 1 !important;
}

html.rfx-page-dark #application .chat-box-position :where(svg, path, circle, rect, line, polyline, polygon),
html.rfx-page-dark .chat-box-position :where(svg, path, circle, rect, line, polyline, polygon) {
  color: #0f1111 !important;
  opacity: 1 !important;
}

html.rfx-page-dark #application .chat-box-position #rfx-chat-neg-container,
html.rfx-page-dark .chat-box-position #rfx-chat-neg-container {
  color: #0f1111 !important;
  -webkit-text-fill-color: initial !important;
}

html.rfx-page-dark #application .chat-box-position #rfx-chat-neg-container :where(button, button *),
html.rfx-page-dark .chat-box-position #rfx-chat-neg-container :where(button, button *) {
  -webkit-text-fill-color: currentColor !important;
}

html.rfx-page-dark :where(table, tr, td, th) {
  background-color: #101820 !important;
  color: #f3f6f7 !important;
  border-color: #33404a !important;
}

html.rfx-page-dark hr {
  border-color: #33404a !important;
}

html.rfx-page-dark ::selection {
  background: #0e7490 !important;
  color: #fff !important;
}

html.rfx-page-dark ::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

html.rfx-page-dark ::-webkit-scrollbar-track {
  background: #0f1418;
}

html.rfx-page-dark ::-webkit-scrollbar-thumb {
  background: #33404a;
  border: 3px solid #0f1418;
  border-radius: 999px;
}
`;

function applyPageTheme() {
  const shouldUseDark = isPageDarkThemeActive();
  document.documentElement.classList.toggle("rfx-page-dark", shouldUseDark);

  let style = document.getElementById(PAGE_DARK_STYLE_ID);
  if (shouldUseDark) {
    if (!style) {
      style = document.createElement("style");
      style.id = PAGE_DARK_STYLE_ID;
    }
    style.textContent = PAGE_DARK_CSS;
    // Keep this last so Amazon's late-loaded CSS cannot override the dark input rules.
    (document.head || document.documentElement).appendChild(style);
  } else if (style) {
    style.remove();
  }
}

function ensurePageThemeMediaListener() {
  if (pageThemeMediaListenerInstalled || !window.matchMedia) return;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if ((settings.themeMode || "system") !== "system") return;
    applyPageTheme();
    if (isLoadBoardPage() && aiModeActive) injectCards();
  };
  if (query.addEventListener) query.addEventListener("change", onChange);
  else if (query.addListener) query.addListener(onChange);
  pageThemeMediaListenerInstalled = true;
}

function isFuzzyPatFooterBanner(el) {
  if (!el || el.nodeType !== 1) return false;
  const id = String(el.id || "");
  const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
  return /FuzzyMatchNotification/i.test(id) ||
    /There are new loads that match your truck posting\(s\) closely\./i.test(text);
}

function applyFuzzyPatFooterVisibility() {
  const hiddenAttr = "data-rfx-hidden-fuzzy-pat-footer";
  if (!settings.hideFuzzyPatFooter) {
    document.querySelectorAll(`[${hiddenAttr}="1"]`).forEach(el => {
      el.style.display = el.dataset.rfxPreviousDisplay || "";
      delete el.dataset.rfxPreviousDisplay;
      delete el.dataset.rfxHiddenFuzzyPatFooter;
    });
    document.querySelectorAll("[data-rfx-hidden-empty-footer='1']").forEach(el => {
      el.style.display = el.dataset.rfxPreviousDisplay || "";
      delete el.dataset.rfxPreviousDisplay;
      delete el.dataset.rfxHiddenEmptyFooter;
    });
    return;
  }

  const candidates = [
    ...document.querySelectorAll("#footer-notification-area"),
    ...document.querySelectorAll("#footer-notification-area *"),
  ];
  const unique = new Set(candidates);
  unique.forEach(el => {
    const banner = el.closest?.(".optimus-banner-alert-footer, .footer-notification > div") || el;
    if (!isFuzzyPatFooterBanner(banner)) return;
    if (!banner.dataset.rfxHiddenFuzzyPatFooter) {
      banner.dataset.rfxPreviousDisplay = banner.style.display || "";
      banner.dataset.rfxHiddenFuzzyPatFooter = "1";
    }
    banner.style.display = "none";
  });

  document.querySelectorAll("#footer-notification-area").forEach(area => {
    const visibleChildren = Array.from(area.querySelectorAll(".footer-notification > div"))
      .filter(el => getComputedStyle(el).display !== "none");
    if (!visibleChildren.length && area.querySelector("[data-rfx-hidden-fuzzy-pat-footer='1']")) {
      if (!area.dataset.rfxHiddenEmptyFooter) {
        area.dataset.rfxPreviousDisplay = area.style.display || "";
        area.dataset.rfxHiddenEmptyFooter = "1";
      }
      area.style.display = "none";
    } else if (area.dataset.rfxHiddenEmptyFooter) {
      area.style.display = area.dataset.rfxPreviousDisplay || "";
      delete area.dataset.rfxPreviousDisplay;
      delete area.dataset.rfxHiddenEmptyFooter;
    }
  });
}

let amazonAutoRefreshDisableTimer = null;
let amazonAutoRefreshDisableAttempts = 0;
let amazonAutoRefreshDisabledOnThisLoad = false;

function disableAmazonAutoRefreshIfEnabled() {
  if (!isLoadBoardPage() || amazonAutoRefreshDisabledOnThisLoad) return false;
  const utilityBar = document.getElementById("utility-bar");
  if (!utilityBar) return false;

  const enabledSwitch = utilityBar.querySelector('input[role="switch"][aria-checked="true"], input[role="switch"]:checked');
  if (!enabledSwitch) return false;

  const clickTarget = enabledSwitch.closest("label") || enabledSwitch;
  clickTarget.click();
  amazonAutoRefreshDisabledOnThisLoad = true;
  return true;
}

function scheduleDisableAmazonAutoRefresh(delay = 500) {
  if (amazonAutoRefreshDisableTimer) clearTimeout(amazonAutoRefreshDisableTimer);
  amazonAutoRefreshDisableTimer = setTimeout(() => {
    amazonAutoRefreshDisableTimer = null;
    amazonAutoRefreshDisableAttempts += 1;
    const disabled = disableAmazonAutoRefreshIfEnabled();
    if (!disabled && amazonAutoRefreshDisableAttempts < 20) {
      scheduleDisableAmazonAutoRefresh(500);
    }
  }, delay);
}

const LOOKOUT_ALERTS_KEY = "rfx_lookout_alerts_v1";
const LOOKOUT_MAX_ALERTS_PER_PASS = 5;
const LOOKOUT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let lookoutProcessing = false;
const PAT_ENDPOINT_KEY = "rfx_pat_endpoint_v1";
const PAT_TEMPLATE_KEY = "rfx_pat_template_v1";
const PAT_ORDERS_KEY = "rfx_pat_orders_v1";

// Negotiation state
const negotiationState = new Map();

// Booking state — key: woId, value: 'idle'|'pending'|'failed'
const bookingState = new Map();
const armedFastBookLoads = new Set();
const patState = new Map();
let patOrders = loadSavedPatOrders();
let patCancelInFlight = false;
let patModalWoId = null;

// Bot state
let botRunning = false;
let botStarting = false;
let settingsOpen = false;
let activeSettingsTab = "quick";
let botTimer = null;
let botStartWatchdog = null;
let autoResumeTimer = null;
let lastPollTime = null;
let lastRefreshInterval = null;
let isFirstPoll = true;
const seenLoads = new Map(); // id -> { version, payout, pickupTime }
const missingCounts = new Map(); // id -> consecutive miss count
const recentlyMissingLoads = new Map(); // id -> expiry timestamp, prevents pagination churn from re-alerting
let alertedLoads = []; // loads in the "new load detected" section
let goneLoads = new Set(); // ids fading out
let autoBookAwaitingBaseline = false;
let autoBookCandidate = null;
const RECENTLY_MISSING_TTL_MS = 5 * 60 * 1000;

// ============================================================
// UTILITIES
// ============================================================
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function fmt$(v) { return v != null ? `$${v.toFixed(2)}` : "N/A"; }
function fmtDur(ms) {
  if (!ms) return "N/A";
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`;
}
function fmtTime(iso, tz) {
  if (!iso) return "N/A";
  try {
    const d = new Date(iso), now = new Date();
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/Los_Angeles" });
    const diff = Math.floor((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz || "America/Los_Angeles" });
    return `${label} ${time}`;
  } catch { return iso; }
}
function fmtTimeShort(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/Los_Angeles" }); } catch { return ""; }
}
function fmtStopDateTime(iso, tz) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: tz || "America/Los_Angeles" });
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz || "America/Los_Angeles" }).toLowerCase();
    return `${date} ${time}`;
  } catch { return ""; }
}
function fmtStopTimeWindow(checkin, checkout, tz) {
  const start = fmtStopDateTime(checkin, tz);
  if (!start) return "";
  if (!settings.showCheckoutTime || !checkout) return start;
  const end = fmtStopDateTime(checkout, tz);
  return end ? `${start} → ${end}` : start;
}
function fmtAge(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just posted";
  if (min < 60) return `posted ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `posted ${hr}h ${min % 60}m ago`;
  return `posted ${Math.floor(hr / 24)}d ago`;
}
function getPostedAgeMinutes(wo) {
  if (!wo?.createdAtTime) return null;
  const ms = Date.now() - new Date(wo.createdAtTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 60000);
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function getAllStops(wo) {
  const stops = [];
  if (!wo.loads) return stops;
  for (const load of wo.loads) { if (load.stops) for (const s of load.stops) stops.push(s); }
  stops.sort((a, b) => (a.stopSequenceNumber || 0) - (b.stopSequenceNumber || 0));
  const seen = new Set();
  return stops.filter((s) => {
    const k = (s.location?.stopCode || "") + "_" + (s.stopSequenceNumber || 0);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function getFlexibleArrivalWindow(wo, tz) {
  const windows = Array.isArray(wo?.workOpportunityArrivalWindows)
    ? wo.workOpportunityArrivalWindows
    : [];
  const stops = getAllStops(wo);
  const firstStop = stops[0];
  const zone = tz || firstStop?.location?.timeZone || "America/Los_Angeles";

  const bestWindow = windows.reduce((best, window) => {
    const startMs = window?.start ? new Date(window.start).getTime() : NaN;
    const endMs = window?.end ? new Date(window.end).getTime() : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return best;
    }

    const candidate = {
      start: window.start,
      end: window.end,
      durationMs: endMs - startMs,
    };

    return !best || candidate.durationMs > best.durationMs ? candidate : best;
  }, null);

  if (!bestWindow) return null;

  const start = fmtStopDateTime(bestWindow.start, zone);
  const end = fmtStopDateTime(bestWindow.end, zone);
  if (!start || !end) return null;

  return {
    start,
    end,
    duration: fmtDur(bestWindow.durationMs),
    label: `Flexible ${start} → ${end}`,
  };
}

function getStopCheckin(stop) {
  return stop?.actions?.find(a => a.type === "CHECKIN")?.plannedTime || "";
}

function getStopCheckout(stop) {
  return stop?.actions?.find(a => a.type === "CHECKOUT")?.plannedTime || "";
}

function getStopTimeMs(stop, preferCheckout = false) {
  const iso = preferCheckout ? (getStopCheckout(stop) || getStopCheckin(stop)) : (getStopCheckin(stop) || getStopCheckout(stop));
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function hasCoords(stop) {
  const loc = stop?.location;
  return Number.isFinite(Number(loc?.latitude)) && Number.isFinite(Number(loc?.longitude));
}

function stopDistanceMiles(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return Infinity;
  return haversine(
    Number(a.location.latitude),
    Number(a.location.longitude),
    Number(b.location.latitude),
    Number(b.location.longitude)
  );
}

function stopCityState(stop) {
  const loc = stop?.location || {};
  return [loc.city, loc.state].filter(Boolean).join(", ") || "?";
}

function getSavedPatTemplate() {
  try {
    return JSON.parse(localStorage.getItem(PAT_TEMPLATE_KEY) || "null");
  } catch {
    return null;
  }
}

function getSavedPatEndpoint() {
  return localStorage.getItem(PAT_ENDPOINT_KEY) || "";
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function isOpenPatStatus(status) {
  const s = String(status || "OPEN").toUpperCase();
  return !["CANCELED", "CANCELLED", "CLOSED", "EXPIRED", "DELETED"].includes(s);
}

function normalizePatOrders(orders) {
  const unique = new Map();
  for (const order of orders || []) {
    const id = String(order?.id || order?.orderId || "").trim();
    if (!isUuidLike(id)) continue;
    const version = Number(order?.version ?? order?.majorVersion ?? 1);
    if (!Number.isFinite(version) || version <= 0) continue;
    const status = String(order?.status || "OPEN");
    if (!isOpenPatStatus(status)) continue;
    unique.set(id, {
      id,
      version,
      status,
      alias: order?.alias || order?.orderAlias || "",
      startTime: order?.startTime || "",
      endTime: order?.endTime || "",
      capturedAt: Date.now(),
    });
  }
  return [...unique.values()];
}

function collectPatOrdersFromValue(value, out = [], seen = new WeakSet()) {
  if (!value || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (
    isUuidLike(value.id || value.orderId) &&
    value.runType &&
    value.totalCost &&
    (value.originCityInfo || Array.isArray(value.endLocationList))
  ) {
    out.push(value);
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectPatOrdersFromValue(item, out, seen));
  } else {
    Object.values(value).forEach(item => collectPatOrdersFromValue(item, out, seen));
  }
  return out;
}

function extractPatOrders(data) {
  return normalizePatOrders(collectPatOrdersFromValue(data));
}

function loadSavedPatOrders() {
  try {
    const saved = JSON.parse(localStorage.getItem(PAT_ORDERS_KEY) || "null");
    return normalizePatOrders(saved?.orders || []);
  } catch {
    return [];
  }
}

function savePatOrders(orders) {
  patOrders = normalizePatOrders(orders);
  try {
    localStorage.setItem(PAT_ORDERS_KEY, JSON.stringify({ capturedAt: Date.now(), orders: patOrders }));
  } catch (err) {
    console.warn("[PAT] Could not save captured orders:", err);
  }
}

function getOpenPatOrders() {
  return normalizePatOrders(patOrders);
}

function cityInfoFromStop(stop) {
  const loc = stop?.location || {};
  const city = loc.city || "";
  const state = loc.state || loc.stateCode || "";
  return {
    name: city,
    stateCode: state,
    country: loc.country || "US",
    latitude: Number(loc.latitude) || null,
    longitude: Number(loc.longitude) || null,
    nearestDomicileCode: loc.nearestDomicileCode || null,
    displayValue: [city, state].filter(Boolean).join(", "),
  };
}

function getPatRunType(wo) {
  const raw = String(wo?.workOpportunityType || wo?.tripType || "").toUpperCase();
  if (raw.includes("ROUND")) return "ROUND_TRIP";
  return "ONE_WAY";
}

function getPatDriverTypes(wo) {
  return [wo?.transitOperatorType === "TEAM_DRIVER" ? "TEAM" : "SOLO"];
}

function getPatLoadingTypes(wo) {
  const values = new Set();
  for (const load of wo?.loads || []) {
    const raw = String(load?.loadingType || load?.loadType || "").toUpperCase();
    if (raw.includes("PRELOAD")) values.add("PRELOADED");
    if (raw.includes("LIVE")) values.add("LIVE");
    if (raw.includes("DROP")) values.add("LIVE");
  }
  if (!values.size) {
    values.add(hasPreloadedStop(wo) ? "PRELOADED" : "LIVE");
  }
  return Array.from(values);
}

function getPatPrefill(wo) {
  const stops = getAllStops(wo);
  const first = stops[0] || null;
  const last = stops[stops.length - 1] || first;
  const pay = Number(wo?.payout?.value) || 0;
  const dist = Number(wo?.totalDistance?.value) || 0;
  const startIso = getStopCheckin(first) || getStopCheckout(first) || "";
  const endIso = getStopCheckout(last) || getStopCheckin(last) || startIso;
  const pricePerMi = dist > 0 ? pay / dist : 0;
  return {
    startTime: startIso,
    endTime: endIso,
    payout: Math.round(pay),
    pricePerMi: Number(pricePerMi.toFixed(2)),
    distanceMin: dist ? Math.max(0, Math.floor(dist - 1)) : 0,
    distanceMax: dist ? Math.ceil(dist + 1) : 0,
    stemTime: 60,
    origin: cityInfoFromStop(first),
    destination: cityInfoFromStop(last),
    originRadius: 25,
    destinationRadius: 25,
    runType: getPatRunType(wo),
    driverTypes: getPatDriverTypes(wo),
    loadingTypeList: getPatLoadingTypes(wo),
    maxStops: Math.max(Number(wo?.stopCount) || stops.length || 1, 1),
  };
}

function buildPatPayload(wo, values) {
  const template = getSavedPatTemplate() || {};
  const origin = values.origin || getPatPrefill(wo).origin;
  const destination = values.destination || getPatPrefill(wo).destination;
  const payout = Number(values.payout) || 0;
  const pricePerMi = Number(values.pricePerMi) || 0;
  const distanceMin = Number(values.distanceMin) || 0;
  const distanceMax = Number(values.distanceMax) || 0;
  const stemTime = Number(values.stemTime) || 60;
  const payload = {
    ...template,
    auditMetaData: template.auditMetaData || { suggestedCostPerDistance: null, matchOutlookScore: "LOW" },
    cancellationDetails: template.cancellationDetails ?? null,
    costPerDistance: pricePerMi > 0 ? { value: pricePerMi, currencyUnit: "USD", distanceUnit: "mi" } : null,
    destinationCityInfo: null,
    destinationCityInfoForFilter: null,
    destinationCityRadius: { value: Number(values.destinationRadius) || 25, unit: "mi" },
    distanceOrDuration: "DISTANCE",
    driverTypes: values.driverTypes || getPatDriverTypes(wo),
    endLocationList: [destination],
    endRegionList: [],
    endTime: values.endTime,
    equipmentTypes: template.equipmentTypes || [
      "FIFTY_THREE_FOOT_TRUCK",
      "SKIRTED_FIFTY_THREE_FOOT_TRUCK",
      "FIFTY_THREE_FOOT_DRY_VAN",
      "FIFTY_THREE_FOOT_A5_AIR_TRAILER",
      "FORTY_FIVE_FOOT_TRUCK",
    ],
    excludeSpecialServices: template.excludeSpecialServices || ["SWING_DOOR"],
    exclusionCityList: template.exclusionCityList || [],
    isAnywhereDestination: false,
    isCheckingMatchingWork: false,
    isLinkedOrder: false,
    isMatchingWorkLoaded: false,
    isRepostingAllowed: template.isRepostingAllowed ?? true,
    loadingTypeList: values.loadingTypeList || getPatLoadingTypes(wo),
    matchingDemands: [],
    matchingWork: 0,
    maxDistance: distanceMax > 0 ? { value: distanceMax, unit: "mi" } : null,
    maxDurationInMinutes: null,
    maxNumberOfStops: Number(values.maxStops) || Math.max(Number(wo?.stopCount) || getAllStops(wo).length || 1, 1),
    minDistance: distanceMin > 0 ? { value: distanceMin, unit: "mi" } : null,
    minDurationInMinutes: null,
    minPickUpBufferInMinutes: stemTime,
    originCityInfo: origin,
    originCityRadius: { value: Number(values.originRadius) || 25, unit: "mi" },
    patOrderContext: null,
    payoutType: "FLAT_RATE",
    providedTrailerType: template.providedTrailerType || "AMAZON_PROVIDED",
    repostingDetails: template.repostingDetails ?? null,
    runType: values.runType || getPatRunType(wo),
    startTime: values.startTime,
    startTimeWindow: template.startTimeWindow ?? null,
    supplyDriverIdList: template.supplyDriverIdList || [],
    supplyTransientDriverIdList: template.supplyTransientDriverIdList || [],
    totalCost: { value: payout, unit: "USD" },
    visibleEquipmentTypes: template.visibleEquipmentTypes || "FIFTY_THREE_FOOT_TRUCK",
    visibleProvidedTrailerType: template.visibleProvidedTrailerType || "AMAZON_PROVIDED",
  };
  delete payload.id;
  delete payload.alias;
  delete payload.version;
  delete payload.status;
  delete payload.creationTime;
  delete payload.demandId;
  delete payload.demandVersion;
  delete payload.demandOptionId;
  delete payload.matchType;
  delete payload.linkedOrderId;
  return payload;
}

function parseCityInfoInput(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const parts = raw.split(",").map(v => v.trim()).filter(Boolean);
  const city = parts[0] || fallback?.name || "";
  const state = parts[1] || fallback?.stateCode || "";
  return {
    ...(fallback || {}),
    name: city,
    stateCode: state,
    country: fallback?.country || "US",
    displayValue: [city, state].filter(Boolean).join(", "),
  };
}

function renderPatButton(wo) {
  if (!settings.patEnabled || !wo?.id) return "";
  const state = patState.get(wo.id) || "idle";
  if (state === "posted") {
    return `<button type="button" class="rfx-pat-btn done" data-pat-wo-id="${wo.id}" disabled>PAT Posted</button>`;
  }
  if (state === "posting") {
    return `<button type="button" class="rfx-pat-btn" data-pat-wo-id="${wo.id}" disabled>Posting...</button>`;
  }
  return `<button type="button" class="rfx-pat-btn" data-pat-wo-id="${wo.id}">Post A Truck</button>`;
}

function renderPatModal() {
  if (!patModalWoId) return "";
  const wo = findLoadForAction(patModalWoId);
  if (!wo) return "";
  const p = getPatPrefill(wo);
  const originLabel = p.origin.displayValue || "";
  const destinationLabel = p.destination.displayValue || "";
  const endpointKnown = !!getSavedPatEndpoint();
  return `<div class="rfx-pat-backdrop" id="rfx-pat-backdrop">
    <form class="rfx-pat-modal" id="rfx-pat-form" data-pat-wo-id="${escapeHtml(wo.id)}">
      <div class="rfx-pat-head">
        <div class="rfx-pat-title">Create Post-A-Truck Order</div>
        <button type="button" class="rfx-pat-close" id="rfx-pat-close" aria-label="Close">×</button>
      </div>
      <div class="rfx-pat-grid">
        <div class="rfx-pat-field"><label>Start Time</label><input type="datetime-local" name="startTime" value="${escapeHtml(toLocalDateTimeInputValue(p.startTime))}" required></div>
        <div class="rfx-pat-field"><label>End Time</label><input type="datetime-local" name="endTime" value="${escapeHtml(toLocalDateTimeInputValue(p.endTime))}" required></div>
        <div class="rfx-pat-field"><label>Payout (min)</label><input type="number" name="payout" min="0" step="1" value="${escapeHtml(p.payout)}" required></div>
        <div class="rfx-pat-field"><label>Price/mi (min)</label><input type="number" name="pricePerMi" min="0" step="0.01" value="${escapeHtml(p.pricePerMi)}"></div>
        <div class="rfx-pat-field"><label>Distance min</label><input type="number" name="distanceMin" min="0" step="1" value="${escapeHtml(p.distanceMin)}"></div>
        <div class="rfx-pat-field"><label>Distance max</label><input type="number" name="distanceMax" min="0" step="1" value="${escapeHtml(p.distanceMax)}"></div>
        <div class="rfx-pat-field"><label>Stem Time</label><select name="stemTime">
          ${[15, 30, 45, 60, 90, 120].map(v => `<option value="${v}" ${v === p.stemTime ? "selected" : ""}>${v < 60 ? `${v}m` : `${v / 60} hr`}</option>`).join("")}
        </select></div>
        <div class="rfx-pat-field"><label>Run Type</label><select name="runType">
          <option value="ONE_WAY" ${p.runType === "ONE_WAY" ? "selected" : ""}>One-way</option>
          <option value="ROUND_TRIP" ${p.runType === "ROUND_TRIP" ? "selected" : ""}>Round trip</option>
        </select></div>
        <div class="rfx-pat-field"><label>Origin</label><input type="text" name="origin" value="${escapeHtml(originLabel)}" required></div>
        <div class="rfx-pat-field"><label>Radius</label><select name="originRadius">
          ${[15, 25, 50, 100, 250].map(v => `<option value="${v}" ${v === p.originRadius ? "selected" : ""}>${v} mi</option>`).join("")}
        </select></div>
        <div class="rfx-pat-field"><label>Destination</label><input type="text" name="destination" value="${escapeHtml(destinationLabel)}" required></div>
        <div class="rfx-pat-field"><label>Radius</label><select name="destinationRadius">
          ${[15, 25, 50, 100, 250].map(v => `<option value="${v}" ${v === p.destinationRadius ? "selected" : ""}>${v} mi</option>`).join("")}
        </select></div>
      </div>
      <button type="submit" class="rfx-pat-submit">Submit</button>
      ${endpointKnown ? "" : `<div class="rfx-pat-help">Open Amazon's Post A Truck page and submit or preview one PAT order once so this extension can learn Amazon's current PAT endpoint.</div>`}
    </form>
  </div>`;
}

function getLoadEndpointInfo(wo) {
  const stops = getAllStops(wo);
  const first = stops[0] || null;
  const last = stops[stops.length - 1] || null;
  return {
    wo,
    stops,
    first,
    last,
    startMs: getStopTimeMs(first, false),
    endMs: getStopTimeMs(last, true),
    payout: wo?.payout?.value || 0,
    distance: wo?.totalDistance?.value || 0,
    duration: wo?.totalDuration || 0,
    driver: wo?.transitOperatorType || "",
    equipment: JSON.stringify(wo?.equipmentType || wo?.requiredEquipment || wo?.categorizedEquipmentTypeList || "53_TRAILER"),
  };
}

function getLoadStartMs(wo) {
  return getLoadEndpointInfo(wo).startMs;
}

function getLoadEndMs(wo) {
  return getLoadEndpointInfo(wo).endMs;
}

function passesCustomDateFilter(wo) {
  if (!settings.customDateFilterEnabled) return true;
  const startLimit = settings.customDateFilterStart ? new Date(settings.customDateFilterStart).getTime() : null;
  const endLimit = settings.customDateFilterEnd ? new Date(settings.customDateFilterEnd).getTime() : null;
  const loadStart = getLoadStartMs(wo);
  const loadEnd = getLoadEndMs(wo);
  if (Number.isFinite(startLimit) && (!Number.isFinite(loadStart) || loadStart < startLimit)) return false;
  if (Number.isFinite(endLimit) && (!Number.isFinite(loadEnd) || loadEnd > endLimit)) return false;
  return true;
}

function normalizeBookedTimeBlocks(blocks) {
  return (blocks || [])
    .map((block, index) => {
      const startMs = new Date(block?.startIso || "").getTime();
      const endMs = new Date(block?.endIso || "").getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return {
        id: String(block?.id || `block-${Date.now()}-${index}`),
        label: String(block?.label || "").trim(),
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        createdAt: block?.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime());
}

function getBookedTimeBlocks() {
  return normalizeBookedTimeBlocks(settings.bookedTimeBlocks);
}

function saveBookedTimeBlocks(blocks) {
  settings.bookedTimeBlocks = normalizeBookedTimeBlocks(blocks);
  saveSettings();
}

function fmtBookedTimeBlockRange(block) {
  const startMs = new Date(block?.startIso || "").getTime();
  const endMs = new Date(block?.endIso || "").getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "";
  const sameDay = new Date(startMs).toLocaleDateString() === new Date(endMs).toLocaleDateString();
  const datePart = new Date(startMs).toLocaleDateString([], { month: "numeric", day: "numeric" });
  const startTime = new Date(startMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const endFormat = sameDay
    ? new Date(endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : `${new Date(endMs).toLocaleDateString([], { month: "numeric", day: "numeric" })} ${new Date(endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return `${datePart} ${startTime}-${endFormat}`;
}

function fmtCustomDateFilterSummary() {
  if (!settings.customDateFilterEnabled) return "Off";
  const startMs = new Date(settings.customDateFilterStart || "").getTime();
  const endMs = new Date(settings.customDateFilterEnd || "").getTime();
  const fmt = ms => new Date(ms).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) return `${fmt(startMs)} - ${fmt(endMs)}`;
  if (Number.isFinite(startMs)) return `After ${fmt(startMs)}`;
  if (Number.isFinite(endMs)) return `Before ${fmt(endMs)}`;
  return "On";
}

function getBookedTimeConflict(wo) {
  const blocks = getBookedTimeBlocks();
  if (!blocks.length) return null;
  const loadStart = getLoadStartMs(wo);
  const loadEnd = getLoadEndMs(wo);
  if (!Number.isFinite(loadStart) || !Number.isFinite(loadEnd)) return null;
  return blocks.find(block => {
    const blockStart = new Date(block.startIso).getTime();
    const blockEnd = new Date(block.endIso).getTime();
    return Number.isFinite(blockStart) && Number.isFinite(blockEnd) && loadStart < blockEnd && loadEnd > blockStart;
  }) || null;
}

function passesBookedTimeBlockFilter(wo) {
  return settings.bookedTimeBlockMode !== "hide" || !getBookedTimeConflict(wo);
}

function fmtWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "N/A";
  return fmtDur(ms);
}

function fmtMinutesShort(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (!m) return "Off";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function fmtRangeSettingValue(key, value) {
  const n = Number(value) || 0;
  if (key === "minPriceIncrease") return n === 0 ? "Off" : `$${n}`;
  if (key === "minStemTimeMinutes") return fmtMinutesShort(n);
  if (key === "roundTripConnectionRadiusMiles" || key === "roundTripReturnRadiusMiles") return `${n} mi`;
  if (key === "roundTripMinBufferMinutes") return `${n}m`;
  if (key === "roundTripMaxWaitHours") return n === 0 ? "Off" : `${n}h`;
  if (key === "roundTripMinPayout") return n === 0 ? "Off" : `$${n}`;
  if (key === "roundTripMinPerMile") return n === 0 ? "Off" : `$${n.toFixed(2)}/mi`;
  if (key === "lookoutPriceRealert") return n === 0 ? "Off" : `$${n}`;
  return `${n}s`;
}

function calcFuelProfit(wo) {
  const payout = Number(wo?.payout?.value) || 0;
  const loadedMiles = Number(wo?.totalDistance?.value) || 0;
  const mpg = Number(settings.profitMpg) || 0;
  const fuelPrice = Number(settings.profitFuelPrice) || 0;
  const deadheadMiles = Number(settings.profitDeadheadMiles) || 0;
  const returnMiles = Number(settings.profitReturnMiles) || 0;
  if (mpg <= 0 || fuelPrice <= 0) return null;
  const emptyMiles = Math.max(0, deadheadMiles) + Math.max(0, returnMiles);
  const totalMiles = loadedMiles + emptyMiles;
  const gallons = totalMiles / mpg;
  const fuelCost = gallons * fuelPrice;
  const profit = payout - fuelCost;
  const profitPerMile = totalMiles > 0 ? profit / totalMiles : 0;
  return { payout, loadedMiles, emptyMiles, totalMiles, mpg, fuelPrice, gallons, fuelCost, profit, profitPerMile };
}

function calcFuelProfitFromTrip(payout, loadedMiles) {
  return calcFuelProfit({
    payout: { value: Number(payout) || 0 },
    totalDistance: { value: Number(loadedMiles) || 0 },
  });
}

function isLoadBoardPage() {
  return /\/loadboard(?:\/|$)/.test(window.location.pathname || "");
}

function isTripsPage() {
  return /\/tours\/(?:upcoming|in-transit|history)(?:\/|$)/.test(window.location.pathname || "");
}

function buildRoundTripMatches(loads, alertMap = new Map()) {
  if (!settings.showRoundTrips) return [];

  const connectionRadius = Number(settings.roundTripConnectionRadiusMiles) || 0;
  const returnRadius = Number(settings.roundTripReturnRadiusMiles) || 0;
  const minBufferMs = (Number(settings.roundTripMinBufferMinutes) || 0) * 60000;
  const maxWaitMs = (Number(settings.roundTripMaxWaitHours) || 0) * 3600000;
  const minPayout = Number(settings.roundTripMinPayout) || 0;
  const minPerMile = Number(settings.roundTripMinPerMile) || 0;

  const infos = (loads || [])
    .filter(wo => wo?.id)
    .map(getLoadEndpointInfo)
    .filter(info => info.first && info.last && hasCoords(info.first) && hasCoords(info.last) && info.startMs != null && info.endMs != null);

  const matches = [];
  const seenPairKeys = new Set();

  for (let i = 0; i < infos.length; i++) {
    const outbound = infos[i];
    for (let j = 0; j < infos.length; j++) {
      if (i === j) continue;
      const inbound = infos[j];
      const pairKey = `${outbound.wo.id}|${inbound.wo.id}`;
      if (seenPairKeys.has(pairKey)) continue;

      if (settings.roundTripRequireSameDriver && outbound.driver && inbound.driver && outbound.driver !== inbound.driver) continue;
      if (settings.roundTripRequireSameEquipment && outbound.equipment !== inbound.equipment) continue;

      const waitMs = inbound.startMs - outbound.endMs;
      if (waitMs < minBufferMs) continue;
      if (maxWaitMs > 0 && waitMs > maxWaitMs) continue;

      const connectionMiles = stopDistanceMiles(outbound.last, inbound.first);
      if (connectionMiles > connectionRadius) continue;

      const returnMiles = stopDistanceMiles(inbound.last, outbound.first);
      if (returnMiles > returnRadius) continue;

      const outboundDirectMiles = stopDistanceMiles(outbound.first, outbound.last);
      const inboundPickupToOutboundStart = stopDistanceMiles(inbound.first, outbound.first);
      const inboundDropToOutboundEnd = stopDistanceMiles(inbound.last, outbound.last);
      if (outboundDirectMiles >= 20 && connectionMiles >= inboundPickupToOutboundStart) continue;
      if (outboundDirectMiles >= 20 && returnMiles >= inboundDropToOutboundEnd) continue;

      const payout = outbound.payout + inbound.payout;
      const loadMiles = outbound.distance + inbound.distance;
      const totalMiles = loadMiles + connectionMiles + returnMiles;
      const perMile = totalMiles > 0 ? payout / totalMiles : 0;
      if (payout < minPayout) continue;
      if (minPerMile > 0 && perMile < minPerMile) continue;

      const totalTimeMs = inbound.endMs - outbound.startMs;
      const score = (payout * 4)
        + (perMile * 120)
        - (connectionMiles * 3)
        - (returnMiles * 2)
        - (waitMs / 3600000 * 8);

      seenPairKeys.add(pairKey);
      matches.push({
        outbound,
        inbound,
        connectionMiles,
        returnMiles,
        outboundDirectMiles,
        waitMs,
        payout,
        loadMiles,
        totalMiles,
        perMile,
        totalTimeMs,
        score,
        hasAlert: alertMap.has(outbound.wo.id) || alertMap.has(inbound.wo.id),
      });
    }
  }

  return matches
    .sort((a, b) => {
      if (a.hasAlert !== b.hasAlert) return a.hasAlert ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, 20);
}

function getLoadsForStop(wo, stop) {
  const matches = [];
  for (const load of wo.loads || []) {
    if ((load.stops || []).some(s =>
      (s.stopSequenceNumber || 0) === (stop.stopSequenceNumber || 0) &&
      (s.location?.stopCode || "") === (stop.location?.stopCode || "")
    )) {
      matches.push(load);
    }
  }
  return matches;
}

function isSameStop(a, b) {
  const aLoc = a.location || {};
  const bLoc = b.location || {};
  if ((a.stopSequenceNumber || 0) !== (b.stopSequenceNumber || 0)) return false;
  if (aLoc.stopCode && bLoc.stopCode) return aLoc.stopCode === bLoc.stopCode;
  if (aLoc.label && bLoc.label) return aLoc.label === bLoc.label;
  return [aLoc.line1, aLoc.city, aLoc.state].join("|") === [bLoc.line1, bLoc.city, bLoc.state].join("|");
}

function getPickupLoadTypesForStop(wo, stop) {
  const types = [];
  for (const load of wo.loads || []) {
    if ((load.stops || []).some(s => s.stopType === "PICKUP" && isSameStop(s, stop))) {
      types.push(load.loadType);
    }
  }
  return uniqTruthy(types).map(titleCaseValue);
}

function isAmazonFacilityStop(stop) {
  const loc = stop?.location || {};
  if (String(loc.domicile || "").trim()) return true;
  const code = String(loc.stopCode || loc.label || "").trim();
  if (!code) return false;
  if (code.includes("_")) return false;
  return /^[A-Z0-9]{3,6}$/.test(code);
}

function isPrivateLoad(wo) {
  const stops = getAllStops(wo);
  return stops.some(stop => !isAmazonFacilityStop(stop));
}

function passesAmazonOnlyFacilities(wo) {
  return !settings.amazonOnlyFacilities || !isPrivateLoad(wo);
}

function getLoadDisplayId(wo) {
  return wo?.id ? String(wo.id).slice(0, 8) : "";
}

function hasPreloadedStop(wo) {
  return (wo.loads || []).some(load =>
    (load.stops || []).some(stop => stop.loadingType === "PRELOADED")
  );
}

function getTimingRisk(wo) {
  const distance = Number(wo?.totalDistance?.value) || 0;
  const durationMs = Number(wo?.totalDuration) || 0;
  if (!distance || !durationMs) return null;

  const stops = getAllStops(wo);
  const stopCount = Math.max(stops.length || wo?.stopCount || 2, 2);
  const hasLive = (wo.loads || []).some(load =>
    (load.stops || []).some(stop => stop.loadingType === "LIVE")
  );
  const hasDrop = (wo.loads || []).some(load =>
    (load.stops || []).some(stop => stop.loadingType === "DROP" || stop.loadingType === "PRELOADED")
  );

  const mph = distance <= 25 ? 22 : distance <= 100 ? 35 : distance <= 300 ? 48 : 52;
  const driveHours = distance / mph;
  const stopMinutes = stopCount * (hasLive ? 45 : hasDrop ? 25 : 35);
  const bufferMinutes = distance <= 25 ? 30 : distance <= 100 ? 45 : 75;
  const expectedHours = Math.max(1, driveHours + (stopMinutes + bufferMinutes) / 60);
  const actualHours = durationMs / 3600000;
  const ratio = actualHours / expectedHours;

  const severeShort = distance <= 25 && actualHours >= 6 && ratio >= 2.5;
  const severe = ratio >= 2.75 && actualHours - expectedHours >= 2;
  const elevated = ratio >= 2.1 && actualHours - expectedHours >= 1.5;
  if (!severeShort && !severe && !elevated) return null;

  return {
    level: severeShort || severe ? "bad" : "warn",
    label: `${fmtDur(durationMs)} for ${distance.toFixed(distance < 10 ? 1 : 0)} mi`,
    detail: `${ratio.toFixed(1)}x expected`,
    ratio,
    expectedMs: expectedHours * 3600000,
  };
}

function getStemTimeWarning(wo) {
  const minMinutes = Number(settings.minStemTimeMinutes) || 0;
  if (minMinutes <= 0) return null;
  const first = getAllStops(wo)[0];
  const startIso = first ? (getStopCheckin(first) || getStopCheckout(first)) : "";
  if (!startIso) return null;
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return null;

  const now = Date.now();
  const cutoff = now + minMinutes * 60000;
  if (startMs >= cutoff) return null;

  const minutesUntil = Math.round((startMs - now) / 60000);
  return {
    label: minutesUntil <= 0 ? "pickup due now" : `starts in ${fmtMinutesShort(minutesUntil)}`,
    detail: `Minimum stand time is ${fmtMinutesShort(minMinutes)}.`,
  };
}

function uniqTruthy(values) {
  return [...new Set(values.filter(Boolean))];
}

function titleCaseValue(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const STATE_NAME_TO_CODE = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", newhampshire: "NH", newjersey: "NJ",
  newmexico: "NM", newyork: "NY", northcarolina: "NC", northdakota: "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", rhodeisland: "RI", southcarolina: "SC", southdakota: "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", westvirginia: "WV", wisconsin: "WI", wyoming: "WY",
};

function normalizeCityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStateCode(value) {
  const raw = normalizeCityText(value).replace(/\s+/g, "");
  if (!raw) return "";
  if (raw.length === 2) return raw.toUpperCase();
  return STATE_NAME_TO_CODE[raw] || raw.toUpperCase();
}

function cityKey(city, state) {
  const c = normalizeCityText(city);
  const s = normalizeStateCode(state);
  return [c, s.toLowerCase()].filter(Boolean).join(" ");
}

function cityLabel(city, state) {
  const cleanCity = normalizeCityText(city).split(" ").map(titleCaseValue).join(" ");
  const code = normalizeStateCode(state);
  return [cleanCity, code].filter(Boolean).join(", ");
}

function stopCityEntry(stop) {
  const loc = stop?.location || {};
  const city = loc.city || "";
  const state = loc.state || loc.stateCode || "";
  const key = cityKey(city, state);
  return key ? { key, city: normalizeCityText(city), state: normalizeStateCode(state), label: cityLabel(city, state) } : null;
}

const CITY_COORDINATE_FALLBACKS = {
  [cityKey("Lathrop", "CA")]: { lat: 37.8227, lon: -121.2766, label: "Lathrop, CA" },
  [cityKey("Manteca", "CA")]: { lat: 37.7974, lon: -121.2161, label: "Manteca, CA" },
  [cityKey("Stockton", "CA")]: { lat: 37.9577, lon: -121.2908, label: "Stockton, CA" },
  [cityKey("Tracy", "CA")]: { lat: 37.7397, lon: -121.4252, label: "Tracy, CA" },
  [cityKey("Rialto", "CA")]: { lat: 34.1064, lon: -117.3703, label: "Rialto, CA" },
  [cityKey("San Bernardino", "CA")]: { lat: 34.1083, lon: -117.2898, label: "San Bernardino, CA" },
  [cityKey("Beaumont", "CA")]: { lat: 33.9295, lon: -116.9772, label: "Beaumont, CA" },
  [cityKey("Fresno", "CA")]: { lat: 36.7378, lon: -119.7871, label: "Fresno, CA" },
  [cityKey("Visalia", "CA")]: { lat: 36.3302, lon: -119.2921, label: "Visalia, CA" },
  [cityKey("Bakersfield", "CA")]: { lat: 35.3733, lon: -119.0187, label: "Bakersfield, CA" },
  [cityKey("Sacramento", "CA")]: { lat: 38.5816, lon: -121.4944, label: "Sacramento, CA" },
  [cityKey("Vacaville", "CA")]: { lat: 38.3566, lon: -121.9877, label: "Vacaville, CA" },
};

function getFallbackCityCoords(key) {
  return CITY_COORDINATE_FALLBACKS[key] || null;
}

function getKnownCityEntries() {
  const map = new Map();
  for (const wo of dedupeLoads([...allLoads, ...alertedLoads.map(a => a.wo)])) {
    for (const stop of getAllStops(wo)) {
      const entry = stopCityEntry(stop);
      if (entry && !map.has(entry.key)) map.set(entry.key, entry);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function levenshtein(a, b) {
  a = normalizeCityText(a);
  b = normalizeCityText(b);
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function parseCityInput(input) {
  const cleaned = String(input || "").replace(/[^a-zA-Z0-9,\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0], state: parts[1] };
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (last.length === 2 || STATE_NAME_TO_CODE[normalizeCityText(last).replace(/\s+/g, "")]) {
      return { city: tokens.slice(0, -1).join(" "), state: last };
    }
  }
  return { city: cleaned, state: "" };
}

function canonicalizeExcludedCityInput(input) {
  const parsed = parseCityInput(input);
  if (!parsed) return null;
  const known = getKnownCityEntries();
  const exactKey = cityKey(parsed.city, parsed.state);
  const exact = known.find(entry => entry.key === exactKey);
  if (exact) return exact;

  const inputCity = normalizeCityText(parsed.city);
  const inputState = normalizeStateCode(parsed.state);
  const candidates = known.filter(entry => !inputState || entry.state === inputState);
  const cityMatches = candidates
    .map(entry => ({ entry, dist: levenshtein(inputCity, entry.city) }))
    .sort((a, b) => a.dist - b.dist);
  const best = cityMatches[0];
  const allowed = inputCity.length <= 5 ? 1 : inputCity.length <= 9 ? 2 : 3;
  if (best && best.dist <= allowed) return best.entry;

  return {
    key: exactKey,
    city: normalizeCityText(parsed.city),
    state: normalizeStateCode(parsed.state),
    label: cityLabel(parsed.city, parsed.state),
  };
}

function getCustomExcludedCities() {
  return normalizeCustomExcludedCityList(settings.customExcludedCities)
    .map(item => typeof item === "string" ? canonicalizeExcludedCityInput(item) : item)
    .filter(item => item?.key);
}

function saveCustomExcludedCities(cities) {
  const unique = new Map();
  for (const city of (cities || [])) {
    if (city?.key) unique.set(city.key, city);
  }
  settings.removedDefaultExcludedCityKeys = Array.from(DEFAULT_CUSTOM_EXCLUDED_CITY_KEYS).filter(key => !unique.has(key));
  settings.customExcludedCities = Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label));
  saveSettings();
}

function getLoadCityEntries(wo) {
  return getAllStops(wo).map(stopCityEntry).filter(Boolean);
}

function passesCustomExcludedCities(wo) {
  const excluded = getCustomExcludedCities();
  if (!excluded.length) return true;
  const stops = getLoadCityEntries(wo);
  return !excluded.some(city =>
    stops.some(stop => city.state ? stop.key === city.key : stop.city === city.city)
  );
}

function filterCustomExcludedLoads(loads) {
  return (loads || []).filter(wo => passesCustomExcludedCities(wo) && passesAmazonOnlyFacilities(wo) && !isIgnoredLoad(wo?.id));
}

function getIgnoredLoadIds() {
  return new Set((settings.ignoredLoadIds || []).filter(Boolean));
}

function isIgnoredLoad(woId) {
  return !!woId && getIgnoredLoadIds().has(woId);
}

function saveIgnoredLoadIds(ids) {
  settings.ignoredLoadIds = Array.from(new Set(ids || [])).filter(Boolean);
  saveSettings();
}

function ignoreLoad(woId) {
  if (!woId) return;
  saveIgnoredLoadIds([...getIgnoredLoadIds(), woId]);
  alertedLoads = alertedLoads.filter(alert => alert?.wo?.id !== woId);
  seenLoads.delete(woId);
  missingCounts.delete(woId);
  recentlyMissingLoads.delete(woId);
  goneLoads.delete(woId);
  if (aiModeActive) injectCards();
  showIgnoredLoadToast(woId);
}

function unignoreLoad(woId) {
  if (!woId) return;
  saveIgnoredLoadIds(Array.from(getIgnoredLoadIds()).filter(id => id !== woId));
  if (aiModeActive) injectCards();
}

function renderCustomExcludedCitySettings() {
  const excluded = getCustomExcludedCities();
  const options = getKnownCityEntries().map(entry => `<option value="${escapeHtml(entry.label)}"></option>`).join("");
  const chips = excluded.length
    ? excluded.map(entry => `<button type="button" class="rfx-city-chip" data-remove-city="${escapeHtml(entry.key)}">${escapeHtml(entry.label)} ×</button>`).join("")
    : `<span class="rfx-city-empty">No custom excluded cities</span>`;
  return `<div class="rfx-city-exclude-box">
    <div class="rfx-city-input-row">
      <input type="text" id="rfx-excluded-city-input" list="rfx-excluded-city-list" placeholder="Add city, state">
      <button type="button" id="rfx-add-excluded-city">Add</button>
      <datalist id="rfx-excluded-city-list">${options}</datalist>
    </div>
    <div class="rfx-city-help">Cleans typos/spaces/symbols and autocorrects against cities seen in Relay results.</div>
    <div class="rfx-city-chips">${chips}</div>
  </div>`;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getLookoutGroups() {
  return Array.isArray(settings.lookoutGroups)
    ? settings.lookoutGroups.filter(g => g?.id).map(normalizeLookoutGroup)
    : [];
}

function saveLookoutGroups(groups) {
  settings.lookoutGroups = (groups || []).filter(g => g?.id).map(normalizeLookoutGroup);
  saveSettings();
}

function getLookoutRules() {
  return Array.isArray(settings.lookoutRules) ? settings.lookoutRules.filter(r => r?.id) : [];
}

function saveLookoutRules(rules) {
  settings.lookoutRules = (rules || []).filter(r => r?.id);
  saveSettings();
}

function getDetectionGroups() {
  return Array.isArray(settings.detectionGroups)
    ? settings.detectionGroups.filter(g => g?.id).map(group => ({
      ...normalizeLookoutGroup(group),
      name: group.name || "Detection group",
    }))
    : [];
}

function saveDetectionGroups(groups) {
  settings.detectionGroups = (groups || []).filter(g => g?.id).map(normalizeLookoutGroup);
  saveSettings();
}

function getDetectionRules() {
  return Array.isArray(settings.detectionRules) ? settings.detectionRules.filter(r => r?.id).map(normalizeDetectionRule) : [];
}

function saveDetectionRules(rules) {
  settings.detectionRules = (rules || []).filter(r => r?.id).map(normalizeDetectionRule);
  saveSettings();
}

function uniqueGroupIds(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [values]).map(value => String(value || "").trim()).filter(Boolean)));
}

function normalizeDetectionRule(rule) {
  const originGroupIds = uniqueGroupIds(rule.originGroupIds?.length ? rule.originGroupIds : rule.originGroupId);
  const destinationGroupIds = uniqueGroupIds(rule.destinationGroupIds?.length ? rule.destinationGroupIds : rule.destinationGroupId);
  return {
    ...rule,
    originGroupIds,
    destinationGroupIds,
    originGroupId: originGroupIds[0] || "",
    destinationGroupId: destinationGroupIds[0] || "",
    enabled: rule.enabled !== false,
  };
}

function getStopCoordinates(stop) {
  const loc = stop?.location || {};
  const lat = Number(loc.latitude);
  const lon = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function getLoadStartStop(wo) {
  return getAllStops(wo)[0] || null;
}

function getLoadEndStop(wo) {
  const stops = getAllStops(wo);
  return stops[stops.length - 1] || null;
}

function findCoordinatesForCityInput(input) {
  const wanted = canonicalizeExcludedCityInput(input);
  if (!wanted?.key) return null;
  for (const wo of dedupeLoads([...allLoads, ...alertedLoads.map(a => a.wo)])) {
    for (const stop of getAllStops(wo)) {
      const entry = stopCityEntry(stop);
      const coords = getStopCoordinates(stop);
      if (entry?.key === wanted.key && coords) return { ...coords, label: entry.label, key: entry.key };
    }
  }
  const fallback = getFallbackCityCoords(wanted.key);
  if (fallback) return { ...fallback, key: wanted.key };
  return { label: wanted.label, key: wanted.key, lat: null, lon: null };
}

function buildLookoutPlace(input, radiusMiles) {
  const learned = findCoordinatesForCityInput(input);
  if (!learned?.key) return null;
  return {
    id: makeId("place"),
    centerText: String(input || "").trim(),
    centerLabel: learned.label || String(input || "").trim(),
    cityKey: learned.key,
    radiusMiles: Math.max(1, Number(radiusMiles) || 25),
    lat: Number.isFinite(Number(learned.lat)) ? Number(learned.lat) : null,
    lon: Number.isFinite(Number(learned.lon)) ? Number(learned.lon) : null,
  };
}

function normalizeLookoutPlace(place, fallbackRadius = 25) {
  if (!place) return null;
  const cityKeyValue = place.cityKey || canonicalizeExcludedCityInput(place.centerLabel || place.centerText || "")?.key || "";
  const fallback = getFallbackCityCoords(cityKeyValue);
  return {
    id: place.id || makeId("place"),
    centerText: place.centerText || place.centerLabel || "",
    centerLabel: place.centerLabel || fallback?.label || place.centerText || "",
    cityKey: cityKeyValue,
    radiusMiles: Math.max(1, Number(place.radiusMiles || fallbackRadius) || 25),
    lat: Number.isFinite(Number(place.lat)) ? Number(place.lat) : (fallback ? fallback.lat : null),
    lon: Number.isFinite(Number(place.lon)) ? Number(place.lon) : (fallback ? fallback.lon : null),
  };
}

function normalizeLookoutGroup(group) {
  const oldPlace = !Array.isArray(group.places) && (group.cityKey || group.centerText || group.centerLabel)
    ? [{
      id: group.placeId || makeId("place"),
      centerText: group.centerText || group.centerLabel || group.name || "",
      centerLabel: group.centerLabel || group.centerText || group.name || "",
      cityKey: group.cityKey || "",
      radiusMiles: group.radiusMiles || 25,
      lat: group.lat,
      lon: group.lon,
    }]
    : [];
  const places = (Array.isArray(group.places) ? group.places : oldPlace)
    .map(place => normalizeLookoutPlace(place, group.radiusMiles || 25))
    .filter(place => place?.cityKey);
  return {
    id: group.id,
    name: group.name || "Lookout group",
    places,
  };
}

function getLookoutPlaceCoords(place) {
  if (Number.isFinite(Number(place?.lat)) && Number.isFinite(Number(place?.lon))) {
    return { lat: Number(place.lat), lon: Number(place.lon) };
  }
  const fallback = getFallbackCityCoords(place?.cityKey);
  if (fallback) return { lat: fallback.lat, lon: fallback.lon };
  return null;
}

function getStopCoordinatesWithFallback(stop) {
  const coords = getStopCoordinates(stop);
  if (coords) return coords;
  const entry = stopCityEntry(stop);
  const fallback = getFallbackCityCoords(entry?.key);
  if (fallback) return { lat: fallback.lat, lon: fallback.lon };
  return null;
}

function refreshLookoutGroupCoordinates() {
  let changed = false;
  const groups = getLookoutGroups().map(group => {
    const places = (group.places || []).map(place => {
      if (Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon))) return place;
      const learned = findCoordinatesForCityInput(place.centerLabel || place.centerText || "");
      if (learned && Number.isFinite(Number(learned.lat)) && Number.isFinite(Number(learned.lon))) {
        changed = true;
        return { ...place, cityKey: place.cityKey || learned.key, centerLabel: place.centerLabel || learned.label, lat: Number(learned.lat), lon: Number(learned.lon) };
      }
      return place;
    });
    return { ...group, places };
  });
  if (changed) saveLookoutGroups(groups);
}

function distanceToLookoutGroup(stop, group) {
  const coords = getStopCoordinatesWithFallback(stop);
  const entry = stopCityEntry(stop);
  let best = { miles: Infinity, place: null };
  for (const place of group?.places || []) {
    const placeCoords = getLookoutPlaceCoords(place);
    let miles = Infinity;
    if (coords && placeCoords) {
      miles = haversine(coords.lat, coords.lon, placeCoords.lat, placeCoords.lon);
    } else if (entry?.key && place?.cityKey && entry.key === place.cityKey) {
      miles = 0;
    }
    if (miles < best.miles) best = { miles, place };
  }
  return best;
}

function getLoadLookoutEndMs(wo) {
  const end = getLoadEndStop(wo);
  return getStopTimeMs(end, true);
}

function matchesLookoutRule(wo, rule, groupsById) {
  if (!wo?.id || !rule?.enabled) return { ok: false, reason: "disabled" };
  if (isIgnoredLoad(wo.id) || !passesCustomExcludedCities(wo)) return { ok: false, reason: "hidden" };
  if (rule.amazonOnly && isPrivateLoad(wo)) return { ok: false, reason: "private" };

  const originGroup = groupsById.get(rule.originGroupId);
  const destinationGroup = groupsById.get(rule.destinationGroupId);
  if (!originGroup || !destinationGroup) return { ok: false, reason: "missing-group" };

  const first = getLoadStartStop(wo);
  const last = getLoadEndStop(wo);
  if (!first || !last) return { ok: false, reason: "missing-stops" };

  const originDistance = distanceToLookoutGroup(first, originGroup);
  const destinationDistance = distanceToLookoutGroup(last, destinationGroup);
  if (!originDistance.place) return { ok: false, reason: "origin-group-empty" };
  if (!destinationDistance.place) return { ok: false, reason: "destination-group-empty" };
  if (originDistance.miles > Number(originDistance.place.radiusMiles || 0)) return { ok: false, reason: "origin-radius" };
  if (destinationDistance.miles > Number(destinationDistance.place.radiusMiles || 0)) return { ok: false, reason: "destination-radius" };

  const payout = Number(wo?.payout?.value) || 0;
  if (Number(rule.minPayout || 0) > 0 && payout < Number(rule.minPayout || 0)) return { ok: false, reason: "payout" };

  const stops = getAllStops(wo);
  if (Number(rule.maxStops || 0) > 0 && stops.length > Number(rule.maxStops || 0)) return { ok: false, reason: "stops" };

  const endByMs = rule.endBy ? new Date(rule.endBy).getTime() : null;
  const loadEndMs = getLoadLookoutEndMs(wo);
  if (Number.isFinite(endByMs) && (!Number.isFinite(loadEndMs) || loadEndMs > endByMs)) return { ok: false, reason: "end-by" };

  return {
    ok: true,
    originMiles: originDistance.miles,
    destinationMiles: destinationDistance.miles,
    originGroup,
    destinationGroup,
    originPlace: originDistance.place,
    destinationPlace: destinationDistance.place,
    first,
    last,
    endMs: loadEndMs,
  };
}

function refreshDetectionGroupCoordinates() {
  let changed = false;
  const groups = getDetectionGroups().map(group => {
    const places = (group.places || []).map(place => {
      if (Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon))) return place;
      const learned = findCoordinatesForCityInput(place.centerLabel || place.centerText || "");
      if (learned && Number.isFinite(Number(learned.lat)) && Number.isFinite(Number(learned.lon))) {
        changed = true;
        return { ...place, cityKey: place.cityKey || learned.key, centerLabel: place.centerLabel || learned.label, lat: Number(learned.lat), lon: Number(learned.lon) };
      }
      return place;
    });
    return { ...group, places };
  });
  if (changed) saveDetectionGroups(groups);
}

function matchesDetectionRule(wo, rule, groupsById) {
  if (!wo?.id || !rule?.enabled) return { ok: false, reason: "disabled" };
  if (isIgnoredLoad(wo.id) || !passesCustomExcludedCities(wo) || !passesAmazonOnlyFacilities(wo)) return { ok: false, reason: "hidden" };
  if (rule.amazonOnly && isPrivateLoad(wo)) return { ok: false, reason: "private" };

  const originGroups = uniqueGroupIds(rule.originGroupIds?.length ? rule.originGroupIds : rule.originGroupId)
    .map(id => groupsById.get(id))
    .filter(Boolean);
  const destinationGroups = uniqueGroupIds(rule.destinationGroupIds?.length ? rule.destinationGroupIds : rule.destinationGroupId)
    .map(id => groupsById.get(id))
    .filter(Boolean);
  if (!originGroups.length && !destinationGroups.length) return { ok: false, reason: "missing-group" };

  const first = getLoadStartStop(wo);
  const last = getLoadEndStop(wo);
  if (!first || !last) return { ok: false, reason: "missing-stops" };

  const originDistance = originGroups.length ? bestDetectionGroupDistance(first, originGroups) : null;
  const destinationDistance = destinationGroups.length ? bestDetectionGroupDistance(last, destinationGroups) : null;
  if (originGroups.length && !originDistance?.place) return { ok: false, reason: "origin-group-empty" };
  if (destinationGroups.length && !destinationDistance?.place) return { ok: false, reason: "destination-group-empty" };
  if (originDistance?.place && originDistance.miles > Number(originDistance.place.radiusMiles || 0)) return { ok: false, reason: "origin-radius" };
  if (destinationDistance?.place && destinationDistance.miles > Number(destinationDistance.place.radiusMiles || 0)) return { ok: false, reason: "destination-radius" };

  const payout = Number(wo?.payout?.value) || 0;
  if (Number(rule.minPayout || 0) > 0 && payout < Number(rule.minPayout || 0)) return { ok: false, reason: "payout" };

  const stops = getAllStops(wo);
  if (Number(rule.maxStops || 0) > 0 && stops.length > Number(rule.maxStops || 0)) return { ok: false, reason: "stops" };

  return {
    ok: true,
    originMiles: originDistance ? originDistance.miles : null,
    destinationMiles: destinationDistance ? destinationDistance.miles : null,
    originGroup: originDistance ? originDistance.group : null,
    destinationGroup: destinationDistance ? destinationDistance.group : null,
    originPlace: originDistance ? originDistance.place : null,
    destinationPlace: destinationDistance ? destinationDistance.place : null,
  };
}

function bestDetectionGroupDistance(stop, groups) {
  let best = { miles: Infinity, place: null, group: null };
  for (const group of groups || []) {
    const current = distanceToLookoutGroup(stop, group);
    if (current.place && current.miles < best.miles) best = { ...current, group };
  }
  return best;
}

function getActiveDetectionRules() {
  return getDetectionRules().filter(rule => rule.enabled);
}

function getDetectionRuleMatch(wo) {
  const rules = getActiveDetectionRules();
  if (!rules.length) return { ok: true, noRules: true };
  refreshDetectionGroupCoordinates();
  const groupsById = new Map(getDetectionGroups().map(group => [group.id, group]));
  for (const rule of rules) {
    const match = matchesDetectionRule(wo, rule, groupsById);
    if (match.ok) return { ...match, rule };
  }
  return { ok: false, reason: "no-detection-rule-match" };
}

function passesDetectionDisplayRules(wo) {
  if (!settings.detectionFilterBoard || !getActiveDetectionRules().length) return true;
  return getDetectionRuleMatch(wo).ok;
}

function passesDetectionAlertRules(wo) {
  if (!passesCustomDateFilter(wo)) return false;
  if (!passesBookedTimeBlockFilter(wo)) return false;
  if (!settings.detectionOnlyAlertMatchingRules || !getActiveDetectionRules().length) return true;
  return getDetectionRuleMatch(wo).ok;
}

function passesDisplayedLoadFilters(wo) {
  return !!wo?.id
    && passesCustomExcludedCities(wo)
    && passesAmazonOnlyFacilities(wo)
    && passesDetectionDisplayRules(wo)
    && passesCustomDateFilter(wo)
    && passesBookedTimeBlockFilter(wo)
    && !isIgnoredLoad(wo.id);
}

function evaluateAutoBookCandidate(wo, nowMs = Date.now()) {
  if (!passesDisplayedLoadFilters(wo)) return { ok: false, reason: "hidden-by-filter" };
  if (isPrivateLoad(wo)) return { ok: false, reason: "not-amazon-facility" };

  const pickupMs = getLoadStartMs(wo);
  if (!Number.isFinite(pickupMs)) return { ok: false, reason: "missing-pickup-time" };

  const payout = Number(wo?.payout?.value);
  if (!Number.isFinite(payout) || payout <= 0) return { ok: false, reason: "missing-payout" };

  const minimumMinutes = Math.max(0, Number(settings.minStemTimeMinutes) || 0);
  const standMinutes = (pickupMs - nowMs) / 60000;
  if (standMinutes < minimumMinutes) {
    return { ok: false, reason: "minimum-stand-time", standMinutes, minimumMinutes };
  }

  return {
    ok: true,
    payout,
    pickupMs,
    standMinutes,
    minimumMinutes,
  };
}

function selectAutoBookCandidate(newLoadAlerts, nowMs = Date.now()) {
  let selected = null;
  for (const alert of newLoadAlerts || []) {
    const evaluation = evaluateAutoBookCandidate(alert?.wo, nowMs);
    if (!evaluation.ok) continue;
    if (!selected || evaluation.payout > selected.evaluation.payout) {
      selected = { alert, evaluation };
    }
  }
  return selected;
}

function lookoutRouteSummary(wo) {
  const first = getLoadStartStop(wo);
  const last = getLoadEndStop(wo);
  return `${stopCityState(first)} → ${stopCityState(last)}`;
}

function lookoutReasonIncrement(map, reason) {
  map.set(reason || "unknown", (map.get(reason || "unknown") || 0) + 1);
}

function lookoutReasonSummary(map) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}:${count}`)
    .join(", ");
}

function loadLookoutAlertHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOOKOUT_ALERTS_KEY));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLookoutAlertHistory(history) {
  try { localStorage.setItem(LOOKOUT_ALERTS_KEY, JSON.stringify(history || {})); } catch {}
}

function pruneLookoutAlertHistory(history) {
  const cutoff = Date.now() - LOOKOUT_HISTORY_TTL_MS;
  for (const [key, value] of Object.entries(history || {})) {
    if (!value?.alertedAt || value.alertedAt < cutoff) delete history[key];
  }
  return history;
}

function shouldSendLookoutAlert(history, rule, wo) {
  const key = `${rule.id}:${getLookoutLoadKey(wo)}`;
  const legacyKey = wo?.id ? `${rule.id}:${wo.id}` : key;
  const previousKey = history[key] ? key : history[legacyKey] ? legacyKey : key;
  const previous = history[previousKey];
  const price = Number(wo?.payout?.value) || 0;
  if (!previous) return { send: true, key, legacyKey, price, priceDelta: 0, isRealert: false };
  const previousPrice = Number(previous.price);
  const needsHistoryRepair = previousKey !== key || !Number.isFinite(previousPrice);
  const delta = Number.isFinite(previousPrice) ? price - previousPrice : 0;
  const threshold = Number(settings.lookoutPriceRealert || 0);
  if (threshold > 0 && delta >= threshold) return { send: true, key, legacyKey, price, priceDelta: delta, isRealert: true };
  return { send: false, key, legacyKey, price, priceDelta: delta, isRealert: false, needsHistoryRepair };
}

function getLookoutLoadKey(wo) {
  if (wo?.id) return `id:${wo.id}`;
  const stops = getAllStops(wo);
  const first = stops[0];
  const last = stops[stops.length - 1];
  return [
    "fp",
    stopCityState(first),
    getStopCheckin(first) || "",
    stopCityState(last),
    getStopCheckout(last) || getStopCheckin(last) || "",
    Number(wo?.totalDistance?.value || 0).toFixed(1),
  ].join("|");
}

function truncateDiscordValue(value, max = 1024) {
  const text = String(value || "N/A");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function getLookoutStopLines(wo) {
  const stops = getAllStops(wo);
  const firstTz = stops[0]?.location?.timeZone || "America/Los_Angeles";
  return stops.map((stop, index) => {
    const loc = stop.location || {};
    const tz = loc.timeZone || firstTz;
    const checkin = getStopCheckin(stop);
    const checkout = getStopCheckout(stop);
    const time = fmtStopTimeWindow(checkin, checkout, tz) || fmtStopDateTime(checkin, tz) || "time unknown";
    const code = loc.stopCode || loc.label || "";
    const city = stopCityState(stop);
    const address = [loc.line1, loc.line2].filter(Boolean).join(", ");
    const pickupTypes = getPickupLoadTypesForStop(wo, stop);
    const loadingType = titleCaseValue(stop.loadingType || "");
    const badges = [...pickupTypes, loadingType].filter(Boolean).join(", ");
    const facilityType = isAmazonFacilityStop(stop) ? "Amazon" : "Private";
    return [
      `${index + 1}. ${code ? `${code} - ` : ""}${city}`,
      `   ${time}`,
      address ? `   ${address}` : "",
      badges ? `   ${badges}` : "",
      `   ${facilityType}`,
    ].filter(Boolean).join("\n");
  });
}

function getLookoutLoadDetails(wo) {
  const pay = Number(wo?.payout?.value) || 0;
  const dist = Number(wo?.totalDistance?.value) || 0;
  const durMs = Number(wo?.totalDuration) || 0;
  const durH = durMs / 3600000;
  const perMi = dist > 0 ? pay / dist : 0;
  const perHr = durH > 0 ? pay / durH : 0;
  const driver = wo?.transitOperatorType === "TEAM_DRIVER" ? "Team" : "Solo";
  const timingRisk = getTimingRisk(wo);
  return [
    `Payout: ${fmt$(pay)}`,
    dist ? `Distance: ${dist.toFixed(1)} mi` : "",
    durMs ? `Duration: ${fmtDur(durMs)}` : "",
    perMi ? `$/mi: ${fmt$(perMi)}` : "",
    perHr ? `$/hr: ${fmt$(perHr)}` : "",
    `Stops: ${getAllStops(wo).length || wo?.stopCount || "N/A"}`,
    `Driver: ${driver}`,
    "Equipment: 53' Trailer",
    hasPreloadedStop(wo) ? "Load type: Preloaded" : "",
    isPrivateLoad(wo) ? "Facility: Private load" : "Facility: Amazon facilities",
    wo?.createdAtTime ? `Posted: ${fmtAge(wo.createdAtTime)}` : "",
    timingRisk ? `Timing issue: ${timingRisk.label} (${timingRisk.detail})` : "",
    wo?.id ? `Load ID: ${wo.id}` : "",
  ].filter(Boolean).join("\n");
}

function buildLookoutDiscordPayload(rule, wo, match, alertInfo) {
  const route = `${stopCityState(match.first)} → ${stopCityState(match.last)}`;
  const start = fmtStopDateTime(getStopCheckin(match.first), match.first?.location?.timeZone);
  const end = fmtStopDateTime(getStopCheckout(match.last) || getStopCheckin(match.last), match.last?.location?.timeZone);
  const stopLines = getLookoutStopLines(wo).join("\n\n");
  const fields = [
    { name: "Route", value: route, inline: false },
    { name: "Start", value: start || "N/A", inline: true },
    { name: "End", value: end || "N/A", inline: true },
    { name: "Details", value: truncateDiscordValue(getLookoutLoadDetails(wo)), inline: false },
    { name: "Stops", value: truncateDiscordValue(stopLines), inline: false },
    { name: "Radius match", value: truncateDiscordValue(`${match.originGroup.name} (${match.originPlace.centerLabel}): ${match.originMiles.toFixed(1)} mi / ${match.originPlace.radiusMiles} mi\n${match.destinationGroup.name} (${match.destinationPlace.centerLabel}): ${match.destinationMiles.toFixed(1)} mi / ${match.destinationPlace.radiusMiles} mi`), inline: false },
  ];
  if (alertInfo?.isRealert) fields.unshift({ name: "Price increase", value: `+${fmt$(alertInfo.priceDelta)}`, inline: true });

  return {
    content: `${alertInfo?.isRealert ? "Price-up Lookout match" : "Lookout match"}: ${rule.name || "Unnamed rule"} - ${route} - ${fmt$(Number(wo?.payout?.value) || 0)}`,
    embeds: [{
      title: `${alertInfo?.isRealert ? "Price-up " : ""}Relay Lookout Match`,
      description: route,
      color: alertInfo?.isRealert ? 0x067d62 : 0xff9900,
      fields,
      footer: { text: rule.name || "Lookout" },
      timestamp: new Date().toISOString(),
    }],
  };
}

function sendDiscordPayload(payload) {
  return new Promise((resolve, reject) => {
    const webhookUrl = settings.discordWebhookUrl;
    if (!webhookUrl) {
      reject(new Error("Discord webhook is not configured"));
      return;
    }
    chrome.runtime.sendMessage({ action: "sendDiscordWebhook", webhookUrl, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Discord webhook failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function processLookoutAlerts(loads, source = "search") {
  if (!settings.lookoutEnabled) return;
  if (lookoutProcessing) {
    console.log(`[Lookout] Skipped ${source}: previous Lookout run still processing`);
    return;
  }
  refreshLookoutGroupCoordinates();
  const rules = getLookoutRules().filter(rule => rule.enabled);
  const groups = getLookoutGroups();
  const candidateLoads = dedupeLoads(loads || []);
  console.log(`[Lookout] Run from ${source}: loads=${candidateLoads.length}, enabledRules=${rules.length}, groups=${groups.length}, webhook=${settings.discordWebhookUrl ? "yes" : "no"}`);
  if (!settings.discordWebhookUrl) {
    console.log("[Lookout] Stop: Discord webhook missing");
    return;
  }
  if (!rules.length) {
    console.log("[Lookout] Stop: no enabled rules");
    return;
  }
  if (groups.length < 2) {
    console.log("[Lookout] Stop: need at least 2 radius groups");
    return;
  }

  lookoutProcessing = true;
  try {
    const groupsById = new Map(groups.map(group => [group.id, group]));
    const history = pruneLookoutAlertHistory(loadLookoutAlertHistory());
    let historyDirty = false;
    const sent = [];
    for (const rule of rules) {
      const reasonCounts = new Map();
      let matches = 0;
      let historySkips = 0;
      for (const wo of candidateLoads) {
        if (sent.length >= LOOKOUT_MAX_ALERTS_PER_PASS) break;
        const match = matchesLookoutRule(wo, rule, groupsById);
        if (!match.ok) {
          lookoutReasonIncrement(reasonCounts, match.reason);
          continue;
        }
        matches++;
        const alertInfo = shouldSendLookoutAlert(history, rule, wo);
        if (!alertInfo.send) {
          if (alertInfo.needsHistoryRepair) {
            history[alertInfo.key] = { price: alertInfo.price, alertedAt: history[alertInfo.legacyKey]?.alertedAt || Date.now(), source: history[alertInfo.legacyKey]?.source || source };
            if (alertInfo.legacyKey && alertInfo.legacyKey !== alertInfo.key) delete history[alertInfo.legacyKey];
            historyDirty = true;
          }
          historySkips++;
          console.log(`[Lookout] Already alerted: rule=${rule.name || rule.id}, load=${String(wo.id).slice(0, 8)}, priceDelta=${alertInfo.priceDelta.toFixed(2)}, threshold=${settings.lookoutPriceRealert}`);
          continue;
        }
        console.log(`[Lookout] Match: rule=${rule.name || rule.id}, load=${String(wo.id).slice(0, 8)}, route=${lookoutRouteSummary(wo)}, origin=${match.originPlace.centerLabel}:${match.originMiles.toFixed(1)}mi/${match.originPlace.radiusMiles}mi, destination=${match.destinationPlace.centerLabel}:${match.destinationMiles.toFixed(1)}mi/${match.destinationPlace.radiusMiles}mi, payout=${fmt$(Number(wo?.payout?.value) || 0)}, stops=${getAllStops(wo).length}`);
        const payload = buildLookoutDiscordPayload(rule, wo, match, alertInfo);
        console.log(`[Lookout] Sending Discord alert: rule=${rule.name || rule.id}, load=${String(wo.id).slice(0, 8)}, realert=${alertInfo.isRealert ? "yes" : "no"}`);
        await sendDiscordPayload(payload);
        history[alertInfo.key] = { price: alertInfo.price, alertedAt: Date.now(), source };
        if (alertInfo.legacyKey && alertInfo.legacyKey !== alertInfo.key) delete history[alertInfo.legacyKey];
        historyDirty = true;
        sent.push({ rule: rule.name, loadId: wo.id });
      }
      console.log(`[Lookout] Rule summary: ${rule.name || rule.id}; matches=${matches}; alreadyAlerted=${historySkips}; rejected={${lookoutReasonSummary(reasonCounts) || "none"}}`);
      if (sent.length >= LOOKOUT_MAX_ALERTS_PER_PASS) break;
    }
    if (sent.length || historyDirty) {
      saveLookoutAlertHistory(history);
    }
    if (sent.length) {
      console.log(`[Lookout] Sent ${sent.length} Discord alert(s) from ${source}.`, sent);
    } else {
      console.log(`[Lookout] No Discord alerts sent from ${source}`);
    }
  } catch (err) {
    console.warn("[Lookout] Alert processing failed:", err);
  } finally {
    lookoutProcessing = false;
  }
}

function toLocalDateTimeInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function localDateTimeInputToIso(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

function renderLookoutSettings() {
  const groups = getLookoutGroups();
  const rules = getLookoutRules();
  const groupOptions = groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("");
  const groupsHtml = groups.length ? groups.map(group => {
    const places = (group.places || []).map(place => {
      const coordText = Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)) ? "" : " (city fallback)";
      return `<span class="rfx-lookout-place-chip">
        <span>${escapeHtml(place.centerLabel)}${coordText}</span>
        <input type="number" min="1" max="500" value="${Number(place.radiusMiles || 0)}" data-lookout-edit-place-radius="${escapeHtml(group.id)}:${escapeHtml(place.id)}" title="Radius miles">
        <span>mi</span>
        <button type="button" data-lookout-remove-place="${escapeHtml(group.id)}:${escapeHtml(place.id)}">×</button>
      </span>`;
    }).join("") || `<span class="rfx-lookout-empty">No cities in this group</span>`;
    return `<div class="rfx-lookout-item rfx-detection-rule-item">
      <div>
        <div class="rfx-lookout-edit-head">
          <input type="text" value="${escapeHtml(group.name)}" data-lookout-edit-group-name="${escapeHtml(group.id)}" aria-label="Group name">
          <span>${(group.places || []).length} cit${(group.places || []).length === 1 ? "y" : "ies"}</span>
        </div>
        <div class="rfx-lookout-places">${places}</div>
        <div class="rfx-lookout-add-place">
          <input type="text" placeholder="Add city, state" data-lookout-place-city="${escapeHtml(group.id)}">
          <input type="number" min="1" max="500" value="25" data-lookout-place-radius="${escapeHtml(group.id)}">
          <button type="button" data-lookout-add-place="${escapeHtml(group.id)}">Add city</button>
        </div>
      </div>
      <button type="button" data-lookout-remove-group="${escapeHtml(group.id)}">Remove</button>
    </div>`;
  }).join("") : `<div class="rfx-lookout-empty">No radius groups yet.</div>`;

  const rulesHtml = rules.length ? rules.map(rule => {
    return `<div class="rfx-lookout-item">
      <div>
        <div class="rfx-lookout-rule-edit">
          <input type="text" value="${escapeHtml(rule.name || "Unnamed rule")}" data-lookout-edit-rule-name="${escapeHtml(rule.id)}" aria-label="Rule name">
          <select data-lookout-edit-rule-origin="${escapeHtml(rule.id)}">${groups.map(group => `<option value="${escapeHtml(group.id)}" ${group.id === rule.originGroupId ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("")}</select>
          <select data-lookout-edit-rule-dest="${escapeHtml(rule.id)}">${groups.map(group => `<option value="${escapeHtml(group.id)}" ${group.id === rule.destinationGroupId ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("")}</select>
          <input type="number" min="0" step="1" value="${Number(rule.minPayout || 0)}" data-lookout-edit-rule-payout="${escapeHtml(rule.id)}" title="Min payout">
          <input type="number" min="0" max="10" step="1" value="${Number(rule.maxStops || 0)}" data-lookout-edit-rule-stops="${escapeHtml(rule.id)}" title="Max stops">
          <input type="datetime-local" value="${toLocalDateTimeInputValue(rule.endBy)}" data-lookout-edit-rule-endby="${escapeHtml(rule.id)}" title="End by">
          <label class="rfx-lookout-check"><input type="checkbox" data-lookout-edit-rule-amazon="${escapeHtml(rule.id)}" ${rule.amazonOnly ? "checked" : ""}> Amazon only</label>
        </div>
      </div>
      <label class="rfx-lookout-mini-toggle"><input type="checkbox" data-lookout-toggle-rule="${escapeHtml(rule.id)}" ${rule.enabled ? "checked" : ""}> On</label>
      <button type="button" data-lookout-remove-rule="${escapeHtml(rule.id)}">Remove</button>
    </div>`;
  }).join("") : `<div class="rfx-lookout-empty">No Lookout rules yet.</div>`;

  return `<div class="rfx-lookout-box">
    <div class="rfx-setting-row"><input type="checkbox" id="rfx-s-lookoutEnabled" ${settings.lookoutEnabled ? "checked" : ""} data-key="lookoutEnabled"><label for="rfx-s-lookoutEnabled">Enable Lookout Discord alerts</label></div>
    <div class="rfx-range-row"><label>Re-alert price up</label><input type="range" id="rfx-s-lookoutRealert" min="0" max="300" step="5" value="${settings.lookoutPriceRealert}" data-key="lookoutPriceRealert"><span class="rfx-range-val" id="rfx-s-lookoutRealert-val">${settings.lookoutPriceRealert ? `$${settings.lookoutPriceRealert}` : "Off"}</span></div>
    <div class="rfx-lookout-subhead">Radius groups</div>
    <div class="rfx-lookout-grid">
      <input id="rfx-lookout-group-name" type="text" placeholder="Group name, e.g. Home">
      <input id="rfx-lookout-group-center" type="text" placeholder="First city, state">
      <input id="rfx-lookout-group-radius" type="number" min="1" max="500" value="50" placeholder="Miles">
      <button type="button" id="rfx-lookout-add-group">Add group</button>
    </div>
    <div class="rfx-lookout-help">A group can contain multiple cities, each with its own radius. A load matches the group if its stop is inside any city radius.</div>
    <div class="rfx-lookout-list">${groupsHtml}</div>
    <div class="rfx-lookout-subhead">Rules</div>
    <div class="rfx-lookout-rule-grid">
      <input id="rfx-lookout-rule-name" type="text" placeholder="Rule name">
      <select id="rfx-lookout-rule-origin"><option value="">Origin group</option>${groupOptions}</select>
      <select id="rfx-lookout-rule-dest"><option value="">Destination group</option>${groupOptions}</select>
      <input id="rfx-lookout-rule-payout" type="number" min="0" step="1" placeholder="Min payout">
      <input id="rfx-lookout-rule-stops" type="number" min="0" max="10" step="1" placeholder="Max stops">
      <input id="rfx-lookout-rule-endby" type="datetime-local">
      <label class="rfx-lookout-check"><input id="rfx-lookout-rule-amazon" type="checkbox"> Amazon only</label>
      <button type="button" id="rfx-lookout-end-24">End +24h</button>
      <button type="button" id="rfx-lookout-add-rule">Add rule</button>
    </div>
    <div class="rfx-lookout-list">${rulesHtml}</div>
  </div>`;
}

function renderDetectionSettings() {
  const groups = getDetectionGroups();
  const rules = getDetectionRules();
  const groupChoiceCards = (name, selectedIds = [], attrName = "", ruleId = "") => {
    const selected = new Set(uniqueGroupIds(selectedIds));
    return `<div class="rfx-detection-picker" role="group" aria-label="${escapeHtml(name)}">
      <div class="rfx-detection-picker-title">${escapeHtml(name)}</div>
      <div class="rfx-detection-choice-grid">
        ${groups.map(group => {
          const checked = selected.has(group.id);
          const count = (group.places || []).length;
          return `<label class="rfx-detection-choice ${checked ? "selected" : ""}">
            <input type="checkbox" ${attrName ? `${attrName}="${escapeHtml(group.id)}"` : ""} ${ruleId ? `data-detection-rule-id="${escapeHtml(ruleId)}"` : ""} ${checked ? "checked" : ""}>
            <span>
              <b>${escapeHtml(group.name)}</b>
              <small>${count} cit${count === 1 ? "y" : "ies"}</small>
            </span>
          </label>`;
        }).join("") || `<span class="rfx-lookout-empty">Create a radius group first.</span>`}
      </div>
    </div>`;
  };
  const groupsHtml = groups.length ? groups.map(group => {
    const places = (group.places || []).map(place => {
      const coordText = Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)) ? "" : " (city fallback)";
      return `<span class="rfx-lookout-place-chip">
        <span>${escapeHtml(place.centerLabel)}${coordText}</span>
        <input type="number" min="1" max="500" value="${Number(place.radiusMiles || 0)}" data-detection-edit-place-radius="${escapeHtml(group.id)}:${escapeHtml(place.id)}" title="Radius miles">
        <span>mi</span>
        <button type="button" data-detection-remove-place="${escapeHtml(group.id)}:${escapeHtml(place.id)}">×</button>
      </span>`;
    }).join("") || `<span class="rfx-lookout-empty">No cities in this group</span>`;
    return `<div class="rfx-lookout-item">
      <div>
        <div class="rfx-lookout-edit-head">
          <input type="text" value="${escapeHtml(group.name)}" data-detection-edit-group-name="${escapeHtml(group.id)}" aria-label="Group name">
          <span>${(group.places || []).length} cit${(group.places || []).length === 1 ? "y" : "ies"}</span>
        </div>
        <div class="rfx-lookout-places">${places}</div>
        <div class="rfx-lookout-add-place">
          <input type="text" placeholder="Add city, state" data-detection-place-city="${escapeHtml(group.id)}">
          <input type="number" min="1" max="500" value="25" data-detection-place-radius="${escapeHtml(group.id)}">
          <button type="button" data-detection-add-place="${escapeHtml(group.id)}">Add city</button>
        </div>
      </div>
      <button type="button" data-detection-remove-group="${escapeHtml(group.id)}">Remove</button>
    </div>`;
  }).join("") : `<div class="rfx-lookout-empty">No detection groups yet.</div>`;

  const rulesHtml = rules.length ? rules.map(rule => {
    const originIds = uniqueGroupIds(rule.originGroupIds?.length ? rule.originGroupIds : rule.originGroupId);
    const destinationIds = uniqueGroupIds(rule.destinationGroupIds?.length ? rule.destinationGroupIds : rule.destinationGroupId);
    return `<div class="rfx-lookout-item">
      <div>
        <div class="rfx-detection-rule-card">
          <div class="rfx-detection-rule-head">
            <input type="text" value="${escapeHtml(rule.name || "Unnamed rule")}" data-detection-edit-rule-name="${escapeHtml(rule.id)}" aria-label="Rule name">
            <label class="rfx-lookout-mini-toggle"><input type="checkbox" data-detection-toggle-rule="${escapeHtml(rule.id)}" ${rule.enabled ? "checked" : ""}> On</label>
          </div>
          <div class="rfx-detection-route-grid">
            ${groupChoiceCards("Origin groups (optional)", originIds, "data-detection-edit-rule-origin-option", rule.id)}
            ${groupChoiceCards("Destination groups (optional)", destinationIds, "data-detection-edit-rule-dest-option", rule.id)}
          </div>
          <div class="rfx-detection-rule-controls">
            <label>Min payout <input type="number" min="0" step="1" value="${Number(rule.minPayout || 0)}" data-detection-edit-rule-payout="${escapeHtml(rule.id)}" title="Min payout"></label>
            <label>Max stops <input type="number" min="0" max="10" step="1" value="${Number(rule.maxStops || 0)}" data-detection-edit-rule-stops="${escapeHtml(rule.id)}" title="Max stops"></label>
            <label class="rfx-lookout-check"><input type="checkbox" data-detection-edit-rule-amazon="${escapeHtml(rule.id)}" ${rule.amazonOnly ? "checked" : ""}> Amazon only</label>
            <button type="button" data-detection-remove-rule="${escapeHtml(rule.id)}">Remove</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join("") : `<div class="rfx-lookout-empty">No detection rules yet.</div>`;

  return `<div class="rfx-lookout-box">
    <div class="rfx-setting-row"><input type="checkbox" id="rfx-s-detectionOnlyAlertMatchingRules" ${settings.detectionOnlyAlertMatchingRules ? "checked" : ""} data-key="detectionOnlyAlertMatchingRules"><label for="rfx-s-detectionOnlyAlertMatchingRules">Only alert matching detection rules</label></div>
    <div class="rfx-setting-row"><input type="checkbox" id="rfx-s-detectionFilterBoard" ${settings.detectionFilterBoard ? "checked" : ""} data-key="detectionFilterBoard"><label for="rfx-s-detectionFilterBoard">Only show matching detection rules</label></div>
    <div class="rfx-lookout-help">If no detection rules are enabled, the extension behaves like normal.</div>
    <div class="rfx-lookout-subhead">Radius groups</div>
    <div class="rfx-lookout-grid">
      <input id="rfx-detection-group-name" type="text" placeholder="Group name, e.g. Home">
      <input id="rfx-detection-group-center" type="text" placeholder="First city, state">
      <input id="rfx-detection-group-radius" type="number" min="1" max="500" value="50" placeholder="Miles">
      <button type="button" id="rfx-detection-add-group">Add group</button>
    </div>
    <div class="rfx-lookout-help">A group can contain multiple cities, each with its own radius. Origin checks the first stop. Destination checks the final stop.</div>
    <div class="rfx-lookout-list">${groupsHtml}</div>
    <div class="rfx-lookout-subhead">Detection rules</div>
    <div class="rfx-detection-builder">
      <div class="rfx-detection-builder-row">
        <input id="rfx-detection-rule-name" type="text" placeholder="Rule name">
        <input id="rfx-detection-rule-payout" type="number" min="0" step="1" placeholder="Min payout">
        <input id="rfx-detection-rule-stops" type="number" min="0" max="10" step="1" placeholder="Max stops">
        <label class="rfx-lookout-check"><input id="rfx-detection-rule-amazon" type="checkbox"> Amazon only</label>
        <button type="button" id="rfx-detection-add-rule">Add rule</button>
      </div>
      <div class="rfx-detection-route-grid">
        ${groupChoiceCards("Origin groups (optional)", [], "data-detection-rule-origin-option")}
        ${groupChoiceCards("Destination groups (optional)", [], "data-detection-rule-dest-option")}
      </div>
    </div>
    <div class="rfx-lookout-help">Select origin groups, destination groups, or both. Empty origin means start anywhere; empty destination means end anywhere.</div>
    <div class="rfx-lookout-list">${rulesHtml}</div>
  </div>`;
}

function bindLookoutSettings() {
  if (!shadowRoot) return;

  const end24Btn = shadowRoot.getElementById("rfx-lookout-end-24");
  if (end24Btn) {
    end24Btn.addEventListener("click", () => {
      const input = shadowRoot.getElementById("rfx-lookout-rule-endby");
      if (!input) return;
      const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      input.value = local.toISOString().slice(0, 16);
    });
  }

  const addGroupBtn = shadowRoot.getElementById("rfx-lookout-add-group");
  if (addGroupBtn) {
    addGroupBtn.addEventListener("click", () => {
      const nameInput = shadowRoot.getElementById("rfx-lookout-group-name");
      const centerInput = shadowRoot.getElementById("rfx-lookout-group-center");
      const radiusInput = shadowRoot.getElementById("rfx-lookout-group-radius");
      const centerText = String(centerInput?.value || "").trim();
      const place = buildLookoutPlace(centerText, radiusInput?.value || 50);
      if (!centerText || !place) {
        showToast("Lookout: enter a city/state");
        return;
      }
      const name = String(nameInput?.value || "").trim() || place.centerLabel || centerText;
      saveLookoutGroups([...getLookoutGroups(), {
        id: makeId("grp"),
        name,
        places: [place],
      }]);
      injectCards();
      showToast("Lookout group added");
    });
  }

  shadowRoot.querySelectorAll("[data-lookout-add-place]").forEach(btn => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.lookoutAddPlace;
      const cityInput = Array.from(shadowRoot.querySelectorAll("[data-lookout-place-city]"))
        .find(input => input.dataset.lookoutPlaceCity === groupId);
      const radiusInput = Array.from(shadowRoot.querySelectorAll("[data-lookout-place-radius]"))
        .find(input => input.dataset.lookoutPlaceRadius === groupId);
      const place = buildLookoutPlace(cityInput?.value || "", radiusInput?.value || 25);
      if (!place) {
        showToast("Lookout: enter a city/state");
        return;
      }
      saveLookoutGroups(getLookoutGroups().map(group => {
        if (group.id !== groupId) return group;
        const places = [...(group.places || []).filter(existing => existing.cityKey !== place.cityKey), place];
        return { ...group, places };
      }));
      injectCards();
      showToast("Lookout city added");
    });
  });

  shadowRoot.querySelectorAll("[data-lookout-remove-place]").forEach(btn => {
    btn.addEventListener("click", () => {
      const [groupId, placeId] = String(btn.dataset.lookoutRemovePlace || "").split(":");
      saveLookoutGroups(getLookoutGroups().map(group => (
        group.id === groupId
          ? { ...group, places: (group.places || []).filter(place => place.id !== placeId) }
          : group
      )));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-lookout-edit-group-name]").forEach(input => {
    input.addEventListener("change", () => {
      const groupId = input.dataset.lookoutEditGroupName;
      const name = String(input.value || "").trim() || "Lookout group";
      saveLookoutGroups(getLookoutGroups().map(group => group.id === groupId ? { ...group, name } : group));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-lookout-edit-place-radius]").forEach(input => {
    input.addEventListener("change", () => {
      const [groupId, placeId] = String(input.dataset.lookoutEditPlaceRadius || "").split(":");
      const radiusMiles = Math.max(1, Number(input.value) || 25);
      saveLookoutGroups(getLookoutGroups().map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          places: (group.places || []).map(place => place.id === placeId ? { ...place, radiusMiles } : place),
        };
      }));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-lookout-remove-group]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.lookoutRemoveGroup;
      saveLookoutGroups(getLookoutGroups().filter(group => group.id !== id));
      saveLookoutRules(getLookoutRules().filter(rule => rule.originGroupId !== id && rule.destinationGroupId !== id));
      injectCards();
    });
  });

  const addRuleBtn = shadowRoot.getElementById("rfx-lookout-add-rule");
  if (addRuleBtn) {
    addRuleBtn.addEventListener("click", () => {
      const name = String(shadowRoot.getElementById("rfx-lookout-rule-name")?.value || "").trim() || "Lookout rule";
      const originGroupId = shadowRoot.getElementById("rfx-lookout-rule-origin")?.value || "";
      const destinationGroupId = shadowRoot.getElementById("rfx-lookout-rule-dest")?.value || "";
      if (!originGroupId || !destinationGroupId) {
        showToast("Lookout: choose origin and destination groups");
        return;
      }
      const minPayout = Math.max(0, Number(shadowRoot.getElementById("rfx-lookout-rule-payout")?.value) || 0);
      const maxStops = Math.max(0, Number(shadowRoot.getElementById("rfx-lookout-rule-stops")?.value) || 0);
      const endBy = localDateTimeInputToIso(shadowRoot.getElementById("rfx-lookout-rule-endby")?.value || "");
      const amazonOnly = !!shadowRoot.getElementById("rfx-lookout-rule-amazon")?.checked;
      saveLookoutRules([...getLookoutRules(), {
        id: makeId("rule"),
        name,
        originGroupId,
        destinationGroupId,
        minPayout,
        maxStops,
        endBy,
        amazonOnly,
        enabled: true,
      }]);
      settings.lookoutEnabled = true;
      saveSettings();
      injectCards();
      showToast("Lookout rule added");
      processLookoutAlerts(allLoads, "rule-added");
    });
  }

  shadowRoot.querySelectorAll("[data-lookout-remove-rule]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.lookoutRemoveRule;
      saveLookoutRules(getLookoutRules().filter(rule => rule.id !== id));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-lookout-toggle-rule]").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.lookoutToggleRule;
      saveLookoutRules(getLookoutRules().map(rule => rule.id === id ? { ...rule, enabled: cb.checked } : rule));
      injectCards();
    });
  });

  const updateRule = (id, patch) => {
    saveLookoutRules(getLookoutRules().map(rule => rule.id === id ? { ...rule, ...patch } : rule));
    injectCards();
  };
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-name]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.lookoutEditRuleName, { name: String(input.value || "").trim() || "Lookout rule" }));
  });
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-origin]").forEach(select => {
    select.addEventListener("change", () => updateRule(select.dataset.lookoutEditRuleOrigin, { originGroupId: select.value }));
  });
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-dest]").forEach(select => {
    select.addEventListener("change", () => updateRule(select.dataset.lookoutEditRuleDest, { destinationGroupId: select.value }));
  });
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-payout]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.lookoutEditRulePayout, { minPayout: Math.max(0, Number(input.value) || 0) }));
  });
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-stops]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.lookoutEditRuleStops, { maxStops: Math.max(0, Number(input.value) || 0) }));
  });
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-endby]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.lookoutEditRuleEndby, { endBy: localDateTimeInputToIso(input.value || "") }));
  });
  shadowRoot.querySelectorAll("[data-lookout-edit-rule-amazon]").forEach(cb => {
    cb.addEventListener("change", () => updateRule(cb.dataset.lookoutEditRuleAmazon, { amazonOnly: cb.checked }));
  });
}

function bindDetectionSettings() {
  if (!shadowRoot) return;

  const addGroupBtn = shadowRoot.getElementById("rfx-detection-add-group");
  if (addGroupBtn) {
    addGroupBtn.addEventListener("click", () => {
      const nameInput = shadowRoot.getElementById("rfx-detection-group-name");
      const centerInput = shadowRoot.getElementById("rfx-detection-group-center");
      const radiusInput = shadowRoot.getElementById("rfx-detection-group-radius");
      const centerText = String(centerInput?.value || "").trim();
      const place = buildLookoutPlace(centerText, radiusInput?.value || 50);
      if (!centerText || !place) {
        showToast("Detection: enter a city/state");
        return;
      }
      const name = String(nameInput?.value || "").trim() || place.centerLabel || centerText;
      saveDetectionGroups([...getDetectionGroups(), {
        id: makeId("dgrp"),
        name,
        places: [place],
      }]);
      injectCards();
      showToast("Detection group added");
    });
  }

  shadowRoot.querySelectorAll("[data-detection-add-place]").forEach(btn => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.detectionAddPlace;
      const cityInput = Array.from(shadowRoot.querySelectorAll("[data-detection-place-city]"))
        .find(input => input.dataset.detectionPlaceCity === groupId);
      const radiusInput = Array.from(shadowRoot.querySelectorAll("[data-detection-place-radius]"))
        .find(input => input.dataset.detectionPlaceRadius === groupId);
      const place = buildLookoutPlace(cityInput?.value || "", radiusInput?.value || 25);
      if (!place) {
        showToast("Detection: enter a city/state");
        return;
      }
      saveDetectionGroups(getDetectionGroups().map(group => {
        if (group.id !== groupId) return group;
        const places = [...(group.places || []).filter(existing => existing.cityKey !== place.cityKey), place];
        return { ...group, places };
      }));
      injectCards();
      showToast("Detection city added");
    });
  });

  shadowRoot.querySelectorAll("[data-detection-remove-place]").forEach(btn => {
    btn.addEventListener("click", () => {
      const [groupId, placeId] = String(btn.dataset.detectionRemovePlace || "").split(":");
      saveDetectionGroups(getDetectionGroups().map(group => (
        group.id === groupId
          ? { ...group, places: (group.places || []).filter(place => place.id !== placeId) }
          : group
      )));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-detection-edit-group-name]").forEach(input => {
    input.addEventListener("change", () => {
      const groupId = input.dataset.detectionEditGroupName;
      const name = String(input.value || "").trim() || "Detection group";
      saveDetectionGroups(getDetectionGroups().map(group => group.id === groupId ? { ...group, name } : group));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-detection-edit-place-radius]").forEach(input => {
    input.addEventListener("change", () => {
      const [groupId, placeId] = String(input.dataset.detectionEditPlaceRadius || "").split(":");
      const radiusMiles = Math.max(1, Number(input.value) || 25);
      saveDetectionGroups(getDetectionGroups().map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          places: (group.places || []).map(place => place.id === placeId ? { ...place, radiusMiles } : place),
        };
      }));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-detection-remove-group]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.detectionRemoveGroup;
      saveDetectionGroups(getDetectionGroups().filter(group => group.id !== id));
      saveDetectionRules(getDetectionRules()
        .map(rule => {
          const originGroupIds = uniqueGroupIds(rule.originGroupIds?.length ? rule.originGroupIds : rule.originGroupId).filter(groupId => groupId !== id);
          const destinationGroupIds = uniqueGroupIds(rule.destinationGroupIds?.length ? rule.destinationGroupIds : rule.destinationGroupId).filter(groupId => groupId !== id);
          return { ...rule, originGroupIds, destinationGroupIds };
        })
        .filter(rule => rule.originGroupIds.length || rule.destinationGroupIds.length));
      injectCards();
    });
  });

  const getCheckedGroupValues = (selector, attrName) => Array.from(shadowRoot.querySelectorAll(selector))
    .filter(input => input.checked)
    .map(input => input.getAttribute(attrName))
    .filter(Boolean);
  const addRuleBtn = shadowRoot.getElementById("rfx-detection-add-rule");
  if (addRuleBtn) {
    addRuleBtn.addEventListener("click", () => {
      const name = String(shadowRoot.getElementById("rfx-detection-rule-name")?.value || "").trim() || "Detection rule";
      const originGroupIds = getCheckedGroupValues("input[data-detection-rule-origin-option]", "data-detection-rule-origin-option");
      const destinationGroupIds = getCheckedGroupValues("input[data-detection-rule-dest-option]", "data-detection-rule-dest-option");
      if (!originGroupIds.length && !destinationGroupIds.length) {
        showToast("Detection: choose at least one origin or destination group");
        return;
      }
      const minPayout = Math.max(0, Number(shadowRoot.getElementById("rfx-detection-rule-payout")?.value) || 0);
      const maxStops = Math.max(0, Number(shadowRoot.getElementById("rfx-detection-rule-stops")?.value) || 0);
      const amazonOnly = !!shadowRoot.getElementById("rfx-detection-rule-amazon")?.checked;
      saveDetectionRules([...getDetectionRules(), {
        id: makeId("drule"),
        name,
        originGroupIds,
        destinationGroupIds,
        originGroupId: originGroupIds[0],
        destinationGroupId: destinationGroupIds[0],
        minPayout,
        maxStops,
        amazonOnly,
        enabled: true,
      }]);
      settings.detectionOnlyAlertMatchingRules = true;
      saveSettings();
      injectCards();
      showToast("Detection rule added");
    });
  }

  shadowRoot.querySelectorAll("[data-detection-remove-rule]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.detectionRemoveRule;
      saveDetectionRules(getDetectionRules().filter(rule => rule.id !== id));
      injectCards();
    });
  });

  shadowRoot.querySelectorAll("[data-detection-toggle-rule]").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.detectionToggleRule;
      saveDetectionRules(getDetectionRules().map(rule => rule.id === id ? { ...rule, enabled: cb.checked } : rule));
      injectCards();
    });
  });

  const updateRule = (id, patch) => {
    saveDetectionRules(getDetectionRules().map(rule => rule.id === id ? { ...rule, ...patch } : rule));
    injectCards();
  };
  shadowRoot.querySelectorAll("[data-detection-edit-rule-name]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.detectionEditRuleName, { name: String(input.value || "").trim() || "Detection rule" }));
  });
  shadowRoot.querySelectorAll("[data-detection-edit-rule-origin-option]").forEach(input => {
    input.addEventListener("change", () => {
      const id = input.dataset.detectionRuleId;
      const originGroupIds = getCheckedGroupValues(`input[data-detection-edit-rule-origin-option][data-detection-rule-id="${CSS.escape(id)}"]`, "data-detection-edit-rule-origin-option");
      updateRule(id, { originGroupIds, originGroupId: originGroupIds[0] || "" });
    });
  });
  shadowRoot.querySelectorAll("[data-detection-edit-rule-dest-option]").forEach(input => {
    input.addEventListener("change", () => {
      const id = input.dataset.detectionRuleId;
      const destinationGroupIds = getCheckedGroupValues(`input[data-detection-edit-rule-dest-option][data-detection-rule-id="${CSS.escape(id)}"]`, "data-detection-edit-rule-dest-option");
      updateRule(id, { destinationGroupIds, destinationGroupId: destinationGroupIds[0] || "" });
    });
  });
  shadowRoot.querySelectorAll("[data-detection-edit-rule-payout]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.detectionEditRulePayout, { minPayout: Math.max(0, Number(input.value) || 0) }));
  });
  shadowRoot.querySelectorAll("[data-detection-edit-rule-stops]").forEach(input => {
    input.addEventListener("change", () => updateRule(input.dataset.detectionEditRuleStops, { maxStops: Math.max(0, Number(input.value) || 0) }));
  });
  shadowRoot.querySelectorAll("[data-detection-edit-rule-amazon]").forEach(cb => {
    cb.addEventListener("change", () => updateRule(cb.dataset.detectionEditRuleAmazon, { amazonOnly: cb.checked }));
  });
}

function getDisplaySettingsSignature() {
  return [
    settings.showScoreBar,
    settings.showPerHr,
    settings.showPerMi,
    settings.showDistance,
    settings.showDuration,
    settings.showVersionBadge,
    settings.showStopAddress,
    settings.showLegDistance,
    settings.showDwellTime,
    settings.showCheckoutTime,
    settings.showLoadTypeBadge,
    settings.showPostedAge,
    settings.showTimingRisk,
    settings.minStemTimeMinutes,
    settings.showDriverType,
    settings.showEquipment,
    settings.showStopCount,
    settings.showStopCode,
    settings.showExtraStopMeta,
    settings.showProfitEstimate,
    settings.profitMpg,
    settings.profitFuelPrice,
    settings.profitDeadheadMiles,
    settings.profitReturnMiles,
    settings.amazonOnlyFacilities,
    settings.detectionFilterBoard,
    settings.fastBook,
  ].map(v => String(v)).join("|");
}

function formatPriceDelta(delta) {
  if (delta == null || Math.abs(delta) < 0.01) return "";
  const sign = delta > 0 ? "+" : "-";
  const abs = Math.abs(delta);
  const amount = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.00$/, "");
  return `${sign}${amount}`;
}

function dedupeLoads(loads) {
  const map = new Map();
  for (const wo of loads || []) {
    if (!wo?.id) continue;
    const existing = map.get(wo.id);
    if (!existing || (wo.payout?.value || 0) > (existing.payout?.value || 0)) {
      map.set(wo.id, wo);
    }
  }
  return Array.from(map.values());
}

function hasVisibleAmazonLoadCards() {
  return document.querySelectorAll(".load-card").length > 0;
}

function shouldIgnoreEmptySearchResult(sourceLabel) {
  const hasDomLoads = hasVisibleAmazonLoadCards();
  const recentlyHadLoads = Date.now() - lastNonEmptySearchAt < 5000;
  const hasCustomLoads = allLoads.length > 0 || alertedLoads.length > 0;
  const ignore = hasDomLoads || (hasCustomLoads && recentlyHadLoads);
  if (ignore) {
  }
  return ignore;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function getSearchSignature(payload) {
  if (!payload || typeof payload !== "object") return "";
  const copy = { ...payload };
  delete copy.nextItemToken;
  delete copy.resultSize;
  delete copy.notificationId;
  delete copy.searchURL;
  delete copy.isAutoRefreshCall;
  delete copy._isRelayFetcher;
  return stableStringify(copy);
}

function seedSeenLoads(loads) {
  seenLoads.clear();
  for (const wo of loads || []) {
    seenLoads.set(wo.id, {
      version: wo.version || 1,
      payout: wo.payout?.value || 0,
      pickupTime: wo.firstPickupTime || "",
    });
  }
}

function pruneRecentlyMissingLoads() {
  const now = Date.now();
  for (const [id, expiresAt] of recentlyMissingLoads) {
    if (expiresAt <= now) recentlyMissingLoads.delete(id);
  }
}

function markRecentlyMissing(id) {
  if (!id) return;
  recentlyMissingLoads.set(id, Date.now() + RECENTLY_MISSING_TTL_MS);
}

function wasRecentlyMissing(id) {
  pruneRecentlyMissingLoads();
  const expiresAt = recentlyMissingLoads.get(id);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    recentlyMissingLoads.delete(id);
    return false;
  }
  return true;
}

// ============================================================
// SCORING (0-100)
// ============================================================
function scoreLoad(wo) {
  const pay = wo.payout?.value || 0, dist = wo.totalDistance?.value || 0;
  const durH = (wo.totalDuration || 0) / 3600000, ver = wo.version || 1, lay = wo.totalLayover || 0;
  const perHr = durH > 0 ? pay / durH : 0, perMi = dist > 0 ? pay / dist : 0;
  const hrS = Math.min(100, (perHr / 100) * 100);
  const miS = Math.min(100, (perMi / 4) * 100);
  let distB = 0;
  if (dist >= 200 && dist <= 500) distB = 15;
  else if (dist >= 100 && dist < 200) distB = 8;
  else if (dist > 500 && dist <= 700) distB = 5;
  const vP = Math.min(30, (ver - 1) * 3);
  const lP = Math.min(20, (lay / 3600000) * 10);
  return Math.max(0, Math.min(100, Math.round(hrS * 0.4 + miS * 0.3 + distB - vP - lP)));
}
function scoreColor(s) { return s >= 70 ? "#067d62" : s >= 40 ? "#b8860b" : "#cc3333"; }
function scoreBg(s) { return s >= 70 ? "#e6f7f2" : s >= 40 ? "#fef9e7" : "#fdecea"; }

function sortLoads(loads) {
  const sorted = [...loads];
  const dir = currentSortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    let av = 0, bv = 0;
    if (currentSort === "score") {
      av = scoreLoad(a); bv = scoreLoad(b);
    } else if (currentSort === "payout") {
      av = a.payout?.value || 0; bv = b.payout?.value || 0;
    } else if (currentSort === "perMile") {
      av = (a.totalDistance?.value || 0) > 0 ? (a.payout?.value || 0) / (a.totalDistance?.value || 0) : 0;
      bv = (b.totalDistance?.value || 0) > 0 ? (b.payout?.value || 0) / (b.totalDistance?.value || 0) : 0;
    } else if (currentSort === "distance") {
      av = a.totalDistance?.value || 0; bv = b.totalDistance?.value || 0;
    } else if (currentSort === "postedAge") {
      av = new Date(a.createdAtTime || 0).getTime();
      bv = new Date(b.createdAtTime || 0).getTime();
    } else if (currentSort === "time") {
      av = new Date(a.firstPickupTime || getAllStops(a)[0]?.actions?.find(x => x.type === "CHECKIN")?.plannedTime || 0).getTime();
      bv = new Date(b.firstPickupTime || getAllStops(b)[0]?.actions?.find(x => x.type === "CHECKIN")?.plannedTime || 0).getTime();
    }
    return (av - bv) * dir;
  });
  return sorted;
}

function renderCustomDateFilter() {
  const enabled = !!settings.customDateFilterEnabled;
  const collapsed = !!settings.customDateFilterCollapsed;
  const startValue = toLocalDateTimeInputValue(settings.customDateFilterStart);
  const endValue = toLocalDateTimeInputValue(settings.customDateFilterEnd);
  const openPatCount = getOpenPatOrders().length;
  const summary = fmtCustomDateFilterSummary();
  return `<div class="rfx-date-filter ${enabled ? "active" : ""} ${collapsed ? "collapsed" : ""}">
    <div class="rfx-date-filter-head">
      <label class="rfx-date-toggle">
        <input type="checkbox" id="rfx-date-filter-enabled" ${enabled ? "checked" : ""}>
        <span>My date filter</span>
      </label>
      <span class="rfx-date-filter-summary">${escapeHtml(summary)}</span>
      <button type="button" id="rfx-date-filter-collapse" class="rfx-date-filter-collapse" aria-expanded="${collapsed ? "false" : "true"}">${collapsed ? "Show" : "Hide"}</button>
    </div>
    <div class="rfx-date-filter-body" ${collapsed ? "hidden" : ""}>
      <div class="rfx-date-filter-main">
        <div class="rfx-date-inputs">
          <label>Start after <input type="datetime-local" id="rfx-date-filter-start" value="${escapeHtml(startValue)}"></label>
          <label>End before <input type="datetime-local" id="rfx-date-filter-end" value="${escapeHtml(endValue)}"></label>
        </div>
      </div>
      <div class="rfx-date-actions">
        <button type="button" data-date-preset="today">Today</button>
        <button type="button" data-date-preset="24h">Next 24h</button>
        <button type="button" data-date-preset="clear">Clear</button>
        <button type="button" id="rfx-cancel-pat-orders" class="rfx-cancel-pat-btn" ${patCancelInFlight ? "disabled" : ""}>${patCancelInFlight ? "Canceling..." : `Cancel PAT${openPatCount ? ` (${openPatCount})` : ""}`}</button>
      </div>
    </div>
  </div>`;
}

function renderBookedTimeBlockSettings() {
  const mode = settings.bookedTimeBlockMode === "hide" ? "hide" : "warn";
  const blocks = getBookedTimeBlocks();
  const blockRows = blocks.length
    ? blocks.map(block => `
      <div class="rfx-time-block-item">
        <div>
          <b>${escapeHtml(block.label || "Booked load")}</b>
          <span>${escapeHtml(fmtBookedTimeBlockRange(block))}</span>
        </div>
        <button type="button" data-remove-time-block="${escapeHtml(block.id)}">Remove</button>
      </div>
    `).join("")
    : `<div class="rfx-time-block-empty">No booked time blocks yet.</div>`;
  return `<div class="rfx-time-block-box">
    <div class="rfx-time-block-mode">
      <label>Conflict action
        <select id="rfx-time-block-mode">
          <option value="warn" ${mode === "warn" ? "selected" : ""}>Warn on conflicts</option>
          <option value="hide" ${mode === "hide" ? "selected" : ""}>Hide conflicting loads</option>
        </select>
      </label>
      <span>Any load that overlaps a saved block will be warned or hidden.</span>
    </div>
    <div class="rfx-time-block-form">
      <input type="text" id="rfx-time-block-label" placeholder="Label, e.g. Stockton booked load">
      <label>Start <input type="datetime-local" id="rfx-time-block-start"></label>
      <label>End <input type="datetime-local" id="rfx-time-block-end"></label>
      <button type="button" id="rfx-add-time-block">Add block</button>
    </div>
    <div class="rfx-time-block-list">${blockRows}</div>
  </div>`;
}

// ============================================================
// SOUND — mp3 files from Sounds folder
// ============================================================
let audioCtx = null;
function ensureAudioCtx() {
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!audioCtx) audioCtx = new AudioCtor();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch (err) {
    console.warn("[Sound] Audio context unavailable:", err);
  }
}

function playSound(filename) {
  try {
    const url = chrome.runtime.getURL(`Sounds/${filename}`);
    const audio = new Audio(url);
    audio.volume = 1.0;
    audio.play().catch(e => console.warn("[Sound] Play failed:", e));
  } catch (e) { console.warn("[Sound] Error:", e); }
}

function playAlert() { playSound("new_load.mp3"); }
function playBookedSound() { playSound("successbook.mp3"); }

// ============================================================
// DETECTION LOGIC
// ============================================================
function detectChanges(newLoads) {
  pruneRecentlyMissingLoads();

  // Deduplicate by ID — if same load appears twice, keep the one with higher payout
  const dedupMap = new Map();
  for (const wo of newLoads) {
    const existing = dedupMap.get(wo.id);
    if (!existing || (wo.payout?.value || 0) > (existing.payout?.value || 0)) {
      dedupMap.set(wo.id, wo);
    }
  }
  const deduped = Array.from(dedupMap.values());
  if (deduped.length !== newLoads.length) {
  }
  newLoads = deduped;


  if (isFirstPoll) {
    for (const wo of newLoads) {
      seenLoads.set(wo.id, {
        version: wo.version || 1,
        payout: wo.payout?.value || 0,
        pickupTime: wo.firstPickupTime || "",
      });
    }
    isFirstPoll = false;
    return [];
  }

  const alerts = [];
  const currentIds = new Set();

  for (const wo of newLoads) {
    currentIds.add(wo.id);
    const prev = seenLoads.get(wo.id);
    const newPay = wo.payout?.value || 0;
    const newVer = wo.version || 1;
    const newPickup = wo.firstPickupTime || "";
    const shortId = wo.id.substring(0, 8);

    if (!prev) {
      if (wasRecentlyMissing(wo.id)) {
        recentlyMissingLoads.delete(wo.id);
        missingCounts.delete(wo.id);
        goneLoads.delete(wo.id);
      } else {
        if (passesDetectionAlertRules(wo)) {
          alerts.push({ wo, badge: "NEW", badgeClass: "badge-new" });
        }
      }
      seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
    } else {
      const payChanged = Math.abs(newPay - prev.payout) > 1;
      const verChanged = newVer !== prev.version;
      const timeChanged = newPickup !== prev.pickupTime;

      if (payChanged || timeChanged) {
        let badge, badgeClass;
        const priceIncrease = newPay - prev.payout;

	        if (payChanged && newPay > prev.payout) {
	          // Check min price increase threshold
	          if (settings.minPriceIncrease > 0 && priceIncrease < settings.minPriceIncrease) {
	            seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
	            missingCounts.delete(wo.id);
	            continue;
	          }
	          badge = `PRICE UP ${fmt$(prev.payout)} → ${fmt$(newPay)}`;
	          badgeClass = "badge-price-up";
	        } else if (payChanged && newPay < prev.payout) {
	          seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
	          missingCounts.delete(wo.id);
	          continue;
	        } else {
	          badge = `TIME CHANGED ${fmtTimeShort(prev.pickupTime)} → ${fmtTimeShort(newPickup)}`;
	          badgeClass = "badge-time";
	        }
        if (passesDetectionAlertRules(wo)) {
          alerts.push({ wo, badge, badgeClass, priceDelta: payChanged ? priceIncrease : null });
        }
        seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
      } else if (verChanged) {
        seenLoads.set(wo.id, { version: newVer, payout: newPay, pickupTime: newPickup });
      } else {
      }
      missingCounts.delete(wo.id);
    }
  }

  // Case 4: Disappeared loads
  for (const [id] of seenLoads) {
    if (!currentIds.has(id)) {
      const count = (missingCounts.get(id) || 0) + 1;
      missingCounts.set(id, count);
      markRecentlyMissing(id);
      if (count >= 2) {
        goneLoads.add(id);
        setTimeout(() => {
          if (!missingCounts.has(id)) return;
          seenLoads.delete(id);
          missingCounts.delete(id);
          goneLoads.delete(id);
          allLoads = allLoads.filter(w => w.id !== id);
          if (aiModeActive) injectCards();
        }, 5000);
      }
    }
  }

  return alerts;
}

// ============================================================
// CSS
// ============================================================
const CSS = `
:host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; font-size: 14px; color: #0f1111; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.rfx-root {
  --rfx-page: #ffffff;
  --rfx-surface: #ffffff;
  --rfx-surface-soft: #f7fafa;
  --rfx-surface-muted: #fbfbfb;
  --rfx-border: #d5d9d9;
  --rfx-border-soft: #eef0f0;
  --rfx-text: #0f1111;
  --rfx-muted: #565959;
  --rfx-faint: #888;
  --rfx-primary: #067d62;
  --rfx-primary-hover: #055d4a;
  --rfx-navy: #232f3e;
  --rfx-orange: #ff9900;
  --rfx-orange-hover: #e88b00;
  --rfx-danger: #cc3333;
  --rfx-danger-hover: #a82a2a;
  --rfx-warning-bg: #fff8e1;
  --rfx-warning-text: #8a5a00;
  --rfx-danger-bg: #fdecea;
  --rfx-new-bg: #fff5e0;
  --rfx-profit-bg: #e6f7f2;
  --rfx-profit-border: #b7e4d2;
  --rfx-chip-bg: #eef7ff;
  --rfx-chip-border: #a6d8ff;
  --rfx-chip-text: #0f1111;
  --rfx-chip-input-bg: #ffffff;
  --rfx-chip-remove-bg: #111827;
  --rfx-chip-remove-text: #ffffff;
  --rfx-choice-selected-bg: #effbf7;
  --rfx-choice-selected-border: #07876b;
  --rfx-shadow: 0 2px 8px rgba(0,0,0,0.1);
  color: var(--rfx-text);
  background: transparent;
}
.rfx-root.rfx-theme-dark {
  --rfx-page: #0f1418;
  --rfx-surface: #151b20;
  --rfx-surface-soft: #101820;
  --rfx-surface-muted: #1b232a;
  --rfx-border: #33404a;
  --rfx-border-soft: #26313a;
  --rfx-text: #f3f6f7;
  --rfx-muted: #b8c3ca;
  --rfx-faint: #8f9aa3;
  --rfx-primary: #19a987;
  --rfx-primary-hover: #12866c;
  --rfx-navy: #0f1722;
  --rfx-orange: #ffad33;
  --rfx-orange-hover: #f59a12;
  --rfx-danger: #f87171;
  --rfx-danger-hover: #ef4444;
  --rfx-warning-bg: #35270b;
  --rfx-warning-text: #ffd27a;
  --rfx-danger-bg: #3a1515;
  --rfx-new-bg: #2c2110;
  --rfx-profit-bg: #0f3129;
  --rfx-profit-border: #1f6d5b;
  --rfx-chip-bg: #132433;
  --rfx-chip-border: #2f6589;
  --rfx-chip-text: #dff3ff;
  --rfx-chip-input-bg: #0f171f;
  --rfx-chip-remove-bg: #dff3ff;
  --rfx-chip-remove-text: #0f171f;
  --rfx-choice-selected-bg: #0f3129;
  --rfx-choice-selected-border: #19a987;
  --rfx-shadow: 0 2px 10px rgba(0,0,0,0.35);
}
@media (prefers-color-scheme: dark) {
  .rfx-root.rfx-theme-system {
    --rfx-page: #0f1418;
    --rfx-surface: #151b20;
    --rfx-surface-soft: #101820;
    --rfx-surface-muted: #1b232a;
    --rfx-border: #33404a;
    --rfx-border-soft: #26313a;
    --rfx-text: #f3f6f7;
    --rfx-muted: #b8c3ca;
    --rfx-faint: #8f9aa3;
    --rfx-primary: #19a987;
    --rfx-primary-hover: #12866c;
    --rfx-navy: #0f1722;
    --rfx-orange: #ffad33;
    --rfx-orange-hover: #f59a12;
    --rfx-danger: #f87171;
    --rfx-danger-hover: #ef4444;
    --rfx-warning-bg: #35270b;
    --rfx-warning-text: #ffd27a;
    --rfx-danger-bg: #3a1515;
    --rfx-new-bg: #2c2110;
    --rfx-profit-bg: #0f3129;
    --rfx-profit-border: #1f6d5b;
    --rfx-chip-bg: #132433;
    --rfx-chip-border: #2f6589;
    --rfx-chip-text: #dff3ff;
    --rfx-chip-input-bg: #0f171f;
    --rfx-chip-remove-bg: #dff3ff;
    --rfx-chip-remove-text: #0f171f;
    --rfx-choice-selected-bg: #0f3129;
    --rfx-choice-selected-border: #19a987;
    --rfx-shadow: 0 2px 10px rgba(0,0,0,0.35);
  }
}

/* Bot status bar */
.rfx-status-bar {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 14px;
  background: var(--rfx-surface-soft); border: 1px solid var(--rfx-border-soft); border-radius: 10px; flex-wrap: wrap;
  position: sticky; top: 0; z-index: 100;
}
.rfx-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.rfx-dot.green { background: var(--rfx-primary); animation: rfxPulse 1.5s infinite; }
.rfx-dot.amber { background: #b8860b; animation: rfxPulse 1s infinite; }
.rfx-dot.red { background: var(--rfx-danger); }
.rfx-dot.grey { background: var(--rfx-faint); }
@keyframes rfxPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.rfx-status-text { font-size: 13px; color: var(--rfx-muted); }
.rfx-status-text b { color: var(--rfx-text); }
.rfx-last-refresh { font-size: 12px; color: var(--rfx-faint); margin-left: auto; }
.rfx-bot-btn {
  padding: 8px 22px; font-size: 14px; font-weight: 600; border-radius: 8px; cursor: pointer;
  font-family: inherit; border: none;
}
.rfx-amazon-view-btn { background: var(--rfx-navy); color: #fff; font-size: 12px; padding: 5px 12px; }
.rfx-start-btn { background: var(--rfx-primary); color: #fff; }
.rfx-start-btn:hover { background: var(--rfx-primary-hover); }
.rfx-start-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rfx-stop-btn { background: var(--rfx-danger); color: #fff; }
.rfx-stop-btn:hover { background: var(--rfx-danger-hover); }
.rfx-stop-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rfx-fastbook-warn {
  display: inline-flex; align-items: center; gap: 4px;
  background: #cc3333; color: #fff; font-size: 12px; font-weight: 600;
  padding: 4px 12px; border-radius: 6px; animation: rfxWarnPulse 2s infinite;
  width: 100%; margin-top: 6px; justify-content: center;
}
@keyframes rfxWarnPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
.rfx-autobook-warn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  background: #8b0000; color: #fff; font-size: 13px; font-weight: 700;
  padding: 8px 16px; border-radius: 8px; margin-bottom: 10px;
  animation: rfxAutoBookPulse 1.5s infinite;
  text-transform: uppercase; letter-spacing: 0;
}
@keyframes rfxAutoBookPulse { 0%,100% { background: #8b0000; } 50% { background: #cc0000; } }

.rfx-alert-card {
  background: var(--rfx-surface); border: 2px solid var(--rfx-orange); border-radius: 8px;
  padding: 12px 16px; margin-bottom: 8px;
}
.rfx-change-badge {
  display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-bottom: 6px;
}
.badge-new { background: var(--rfx-primary); color: #fff; }
.badge-price-up { background: var(--rfx-primary); color: #fff; }
.badge-price-down { background: var(--rfx-danger); color: #fff; }
.badge-time { background: #b8860b; color: #fff; }
.badge-autobook { background: var(--rfx-danger); color: #fff; }
.badge-updated { background: var(--rfx-muted); color: #fff; }
.badge-gone { background: var(--rfx-border-soft); color: var(--rfx-faint); }

/* Toolbar */
.rfx-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 10px 0 14px 0; flex-wrap: wrap;
  border-bottom: 1px solid var(--rfx-border-soft); margin-bottom: 14px;
}
.rfx-toolbar-label { font-size: 13px; color: var(--rfx-muted); margin-right: 4px; }
.rfx-sort-btn {
  padding: 6px 14px; font-size: 13px; border: 1px solid var(--rfx-border); border-radius: 8px;
  background: var(--rfx-surface); color: var(--rfx-text); cursor: pointer; font-family: inherit;
}
.rfx-sort-btn:hover { background: var(--rfx-surface-soft); }
.rfx-sort-btn.active { background: var(--rfx-navy); color: #fff; border-color: var(--rfx-navy); }
.rfx-toolbar-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--rfx-muted); margin-left: 8px; }
.rfx-toolbar-filter select {
  height: 31px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); font-size: 13px; padding: 0 8px; font-family: inherit;
}
.rfx-count { font-size: 13px; color: var(--rfx-muted); margin-left: auto; }
.rfx-date-filter {
  display: flex; flex-direction: column; align-items: stretch; gap: 10px;
  padding: 10px 12px; margin: 0 0 10px 0; border: 1px solid var(--rfx-border); border-radius: 10px;
  background: var(--rfx-surface);
}
.rfx-date-filter.active { border-color: var(--rfx-primary); background: var(--rfx-profit-bg); }
.rfx-date-filter.collapsed { padding: 9px 12px; }
.rfx-date-filter-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.rfx-date-filter-summary {
  margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 800; color: var(--rfx-muted);
}
.rfx-date-filter-collapse {
  height: 30px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); font: inherit; font-size: 12px; font-weight: 800; padding: 0 10px; cursor: pointer;
}
.rfx-date-filter-collapse:hover { background: var(--rfx-surface-soft); }
.rfx-date-filter-body { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.rfx-date-filter-body[hidden] { display: none; }
.rfx-date-filter-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.rfx-date-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; color: var(--rfx-text); white-space: nowrap; }
.rfx-date-toggle input { width: 18px; height: 18px; accent-color: var(--rfx-primary); }
.rfx-date-inputs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.rfx-date-inputs label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--rfx-muted); font-weight: 700; }
.rfx-date-inputs input {
  height: 34px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); font: inherit; font-size: 13px; padding: 0 8px;
}
.rfx-date-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.rfx-date-actions button {
  height: 34px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); font: inherit; font-size: 12px; font-weight: 800; padding: 0 10px; cursor: pointer;
}
.rfx-date-actions button:hover { background: var(--rfx-surface-soft); }
.rfx-date-actions .rfx-cancel-pat-btn {
  border-color: var(--rfx-danger); color: var(--rfx-danger); background: var(--rfx-surface);
}
.rfx-date-actions .rfx-cancel-pat-btn:hover { background: var(--rfx-danger-bg); }
.rfx-date-actions .rfx-cancel-pat-btn:disabled {
  opacity: .65; cursor: wait; background: var(--rfx-surface-soft);
}
.rfx-load-board { margin-top: 8px; }
.rfx-section-title { font-size: 14px; font-weight: 700; color: var(--rfx-text); margin: 0 0 10px 0; }
.rfx-roundtrip-section {
  margin: 0 0 18px 0; padding: 12px; border: 1px solid var(--rfx-border); border-radius: 10px;
  background: var(--rfx-surface-soft);
}
.rfx-roundtrip-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px;
  width: 100%; background: transparent; border: 0; font-family: inherit; text-align: left; cursor: pointer;
}
.rfx-roundtrip-head:hover .rfx-roundtrip-title { color: var(--rfx-primary); }
.rfx-roundtrip-title { font-size: 15px; font-weight: 800; color: var(--rfx-text); }
.rfx-roundtrip-sub { font-size: 12px; color: var(--rfx-muted); }
.rfx-roundtrip-toggle { font-size: 13px; font-weight: 700; color: var(--rfx-muted); white-space: nowrap; }
.rfx-roundtrip-body { display: block; }
.rfx-roundtrip-section.collapsed .rfx-roundtrip-head { margin-bottom: 0; }
.rfx-roundtrip-section.collapsed .rfx-roundtrip-body { display: none; }
.rfx-roundtrip-card {
  background: var(--rfx-surface); border: 1px solid var(--rfx-border); border-radius: 10px; padding: 12px;
  margin-bottom: 10px;
}
.rfx-roundtrip-card.alerted { border-color: var(--rfx-orange); box-shadow: 0 0 8px rgba(255,153,0,0.18); }
.rfx-roundtrip-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr) auto; gap: 12px; align-items: stretch; }
.rfx-roundtrip-leg { border: 1px solid var(--rfx-border-soft); border-radius: 8px; padding: 10px; min-width: 0; }
.rfx-roundtrip-leg-title { font-size: 11px; font-weight: 800; color: var(--rfx-muted); text-transform: uppercase; margin-bottom: 6px; }
.rfx-roundtrip-route { font-size: 14px; font-weight: 800; color: var(--rfx-text); line-height: 1.35; }
.rfx-roundtrip-time { font-size: 12px; color: var(--rfx-muted); margin-top: 4px; }
.rfx-roundtrip-money { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 8px; min-width: 150px; }
.rfx-roundtrip-payout { font-size: 24px; font-weight: 800; color: var(--rfx-primary); line-height: 1; }
.rfx-roundtrip-stat { font-size: 12px; color: var(--rfx-muted); text-align: right; }
.rfx-roundtrip-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.rfx-roundtrip-metrics {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--rfx-border-soft);
}
.rfx-roundtrip-metric { font-size: 12px; color: var(--rfx-muted); }
.rfx-roundtrip-metric b { color: var(--rfx-text); }

/* Cards */
.rfx-card {
  background: var(--rfx-surface); border: 1px solid var(--rfx-border); border-radius: 10px;
  padding: 18px 22px; margin-bottom: 14px; cursor: pointer;
  position: relative;
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.5s;
}
.rfx-card:hover { box-shadow: var(--rfx-shadow); border-color: var(--rfx-muted); }
.rfx-card.new-load { background: var(--rfx-new-bg); border-color: var(--rfx-orange); box-shadow: 0 0 12px rgba(255,153,0,0.25); }
.rfx-card.gone { opacity: 0.4; }

.rfx-body { display: flex; gap: 24px; }
.rfx-left { flex: 1; min-width: 0; }
.rfx-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; min-width: 140px; text-align: right; gap: 10px; }
.rfx-payout { font-size: 26px; font-weight: 700; color: var(--rfx-primary); line-height: 1.2; }
.rfx-price-delta { font-size: 15px; font-weight: 800; line-height: 1; margin-bottom: 3px; }
.rfx-price-delta.up { color: var(--rfx-primary); }
.rfx-price-delta.down { color: var(--rfx-danger); }
.rfx-stat { font-size: 14px; color: var(--rfx-muted); margin-top: 3px; }
.rfx-stat b { color: var(--rfx-text); font-weight: 600; }
.rfx-stats-group { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.rfx-profit-est {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 3px 8px; border-radius: 999px; background: var(--rfx-profit-bg); color: var(--rfx-primary);
  font-size: 12px; font-weight: 800; line-height: 1.25; white-space: nowrap;
}
.rfx-profit-est.negative { background: var(--rfx-danger-bg); color: var(--rfx-danger); }
.rfx-version { font-size: 12px; padding: 3px 8px; border-radius: 4px; font-weight: 600; margin-top: 6px; }
.rfx-version.ok { background: var(--rfx-surface-muted); color: var(--rfx-muted); }
.rfx-version.bad { background: var(--rfx-danger-bg); color: var(--rfx-danger); }

.rfx-score-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rfx-score-bg { flex: 1; height: 6px; background: var(--rfx-border-soft); border-radius: 3px; overflow: hidden; max-width: 220px; }
.rfx-score-fill { height: 100%; border-radius: 3px; }
.rfx-score-label { font-size: 14px; font-weight: 700; min-width: 26px; }
.rfx-score-tag { font-size: 12px; padding: 2px 10px; border-radius: 4px; font-weight: 600; margin-left: 4px; }

.rfx-stops { margin: 8px 0 4px 0; }
.rfx-stop { display: flex; align-items: flex-start; gap: 12px; position: relative; }
.rfx-stop-line { display: flex; flex-direction: column; align-items: center; width: 28px; flex-shrink: 0; }
.rfx-stop-dot {
  width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.rfx-stop-dot.pickup { background: #2563eb; }
.rfx-stop-dot.dropoff { background: #7c3aed; }
.rfx-stop-conn { width: 2px; flex: 1; background: var(--rfx-border); min-height: 14px; }
.rfx-stop-info { flex: 1; min-width: 0; padding-bottom: 8px; }
.rfx-stop-name { font-size: 14px; font-weight: 600; color: var(--rfx-text); line-height: 1.4; flex: 0 1 auto; }
.rfx-stop-head { display: flex; align-items: baseline; justify-content: flex-start; gap: 12px; flex-wrap: wrap; }
.rfx-stop-datetime { font-size: 13px; color: var(--rfx-muted); white-space: normal; font-weight: 500; display: inline-flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rfx-inline-detail { color: var(--rfx-muted); font-size: 13px; }
.rfx-stop-addr { font-size: 12px; color: var(--rfx-faint); margin-top: 2px; }
.rfx-stop-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
.rfx-stop-time { font-size: 13px; color: var(--rfx-muted); }
.rfx-stop-dwell { font-size: 12px; color: var(--rfx-faint); }
.rfx-flex-window { font-size: 11px; padding: 3px 7px; border-radius: 5px; background: var(--rfx-warning-bg); color: var(--rfx-warning-text); font-weight: 800; }
.rfx-extra { font-size: 11px; padding: 3px 7px; border-radius: 5px; background: var(--rfx-surface-muted); color: var(--rfx-muted); font-weight: 600; }
.rfx-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
.rfx-badge.preloaded { background: var(--rfx-profit-bg); color: var(--rfx-primary); }
.rfx-badge.live { background: #fef3cd; color: #856404; }
.rfx-badge.drop { background: #e8f0fe; color: #1a56db; }
.rfx-leg-dist { font-size: 12px; color: var(--rfx-faint); padding: 4px 0 6px 40px; }

.rfx-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 10px; margin-top: 6px; border-top: 1px solid var(--rfx-border-soft); }
.rfx-tag { font-size: 13px; color: var(--rfx-muted); }
.rfx-tag b { color: var(--rfx-text); }
.rfx-private-tag { background: #fff3cd; border: 1px solid #f3d27a; color: #8a5a00; padding: 3px 8px; border-radius: 6px; font-weight: 800; }
.rfx-load-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--rfx-muted); }
.rfx-timing-risk {
  display: inline-flex; align-items: center; gap: 4px; border-radius: 6px;
  padding: 4px 8px; font-size: 12px; font-weight: 800;
}
.rfx-timing-risk.warn { background: var(--rfx-warning-bg); color: var(--rfx-warning-text); border: 1px solid #f3d27a; }
.rfx-timing-risk.bad { background: var(--rfx-danger-bg); color: var(--rfx-danger); border: 1px solid #f1b8b0; }
.rfx-stem-risk {
  display: inline-flex; align-items: center; gap: 4px; border-radius: 6px;
  padding: 4px 8px; font-size: 12px; font-weight: 800;
  background: var(--rfx-danger-bg); color: var(--rfx-danger); border: 1px solid #f1b8b0;
}
.rfx-time-conflict {
  display: inline-flex; align-items: center; gap: 4px; border-radius: 6px;
  padding: 4px 8px; font-size: 12px; font-weight: 800;
  background: var(--rfx-warning-bg); color: var(--rfx-warning-text); border: 1px solid #f3d27a;
}
.rfx-book-btn {
  margin-left: auto; padding: 8px 22px; font-size: 14px; font-weight: 600;
  background: var(--rfx-orange); color: #0f1111; border: none; border-radius: 8px; cursor: pointer; font-family: inherit;
}
.rfx-book-btn:hover { background: var(--rfx-orange-hover); }
.rfx-card-actions { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.rfx-left-actions { display: flex; align-items: center; gap: 8px; margin: 0 0 8px 32px; }
.rfx-pat-btn {
  padding: 7px 14px; font-size: 12px; font-weight: 800;
  background: #0b7285; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: inherit;
}
.rfx-pat-btn:hover { background: #075965; }
.rfx-pat-btn:disabled { opacity: 0.65; cursor: default; }
.rfx-pat-btn.done { background: #067d62; }
.rfx-pat-backdrop {
  position: fixed; inset: 0; background: rgba(15, 17, 17, 0.45);
  z-index: 2147483646; display: flex; align-items: center; justify-content: center; padding: 16px;
}
.rfx-pat-modal {
  width: min(430px, calc(100vw - 32px)); background: var(--rfx-surface); border: 1px solid var(--rfx-border); border-radius: 10px;
  box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28); padding: 14px; color: var(--rfx-text); box-sizing: border-box; overflow: hidden;
}
.rfx-pat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.rfx-pat-title { font-size: 16px; font-weight: 800; }
.rfx-pat-close { border: 0; background: transparent; font-size: 24px; line-height: 1; cursor: pointer; color: var(--rfx-muted); }
.rfx-pat-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.rfx-pat-field { display: grid; gap: 4px; min-width: 0; }
.rfx-pat-field label { font-size: 11px; font-weight: 800; color: var(--rfx-muted); }
.rfx-pat-field input,
.rfx-pat-field select {
  border: 1px solid #8d979b; border-radius: 4px; padding: 8px; min-height: 38px;
  font: inherit; font-size: 13px; background: var(--rfx-surface); color: var(--rfx-text); width: 100%; box-sizing: border-box;
}
.rfx-pat-field.full { grid-column: 1 / -1; }
.rfx-pat-submit {
  margin-top: 12px; width: 100%; min-height: 42px; border: 0; border-radius: 7px;
  background: #007185; color: #fff; font: inherit; font-weight: 800; cursor: pointer;
}
.rfx-pat-submit:hover { background: #005f70; }
.rfx-pat-submit:disabled { opacity: 0.6; cursor: default; }
.rfx-pat-help { margin-top: 8px; color: #8a5a00; font-size: 12px; line-height: 1.35; }
@media (max-width: 560px) {
  .rfx-pat-backdrop { align-items: flex-start; padding-top: 24px; }
  .rfx-pat-grid { grid-template-columns: 1fr; }
  .rfx-pat-field.full { grid-column: auto; }
}

/* Negotiation */
.rfx-neg-btn {
  padding: 6px 16px; font-size: 13px; font-weight: 600;
  background: #2563eb; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: inherit;
  margin-top: 6px;
}
.rfx-neg-btn:hover { background: #1d4ed8; }
.rfx-neg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rfx-neg-btn.done { background: #067d62; cursor: default; }
.rfx-neg-btn.ineligible { background: #888; cursor: default; }
.rfx-neg-section {
  margin-top: 8px; padding: 8px 12px; border-radius: 8px; font-size: 13px;
}
.rfx-neg-section.running { background: #eff6ff; border: 1px solid #bfdbfe; }
.rfx-neg-section.done { background: #e6f7f2; border: 1px solid #a7f3d0; }
.rfx-neg-section.ineligible { background: #f5f5f5; border: 1px solid #e5e5e5; color: #888; }
.rfx-neg-round { font-weight: 600; color: #2563eb; }
.rfx-neg-prices { margin-top: 4px; color: #0f1111; font-size: 14px; }
.rfx-neg-prices span { transition: all 0.3s; }
.rfx-neg-result { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.rfx-neg-gain { font-weight: 700; color: #067d62; font-size: 15px; }
.rfx-neg-final { font-weight: 700; font-size: 18px; color: #067d62; }
.rfx-neg-rounds-count { color: #565959; font-size: 12px; }
@keyframes rfxNegPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
.rfx-neg-pulsing { animation: rfxNegPulse 1s infinite; }

/* Booking */
.rfx-book-btn.pending {
  background: #b8860b; color: #fff; cursor: default;
}
.rfx-hide-load-btn {
  position: absolute; top: 6px; left: 6px; width: 22px; height: 22px;
  border: 1px solid var(--rfx-border); border-radius: 50%; background: var(--rfx-surface); color: var(--rfx-muted);
  font-size: 15px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  z-index: 2;
}
.rfx-hide-load-btn:hover { background: var(--rfx-danger-bg); border-color: var(--rfx-danger); color: var(--rfx-danger); }
.rfx-hidden-loads-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--rfx-muted); }
.rfx-time-block-box { display: grid; gap: 10px; }
.rfx-time-block-mode {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px; border: 1px solid var(--rfx-border-soft); border-radius: 8px; background: var(--rfx-surface-muted);
}
.rfx-time-block-mode label { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; color: var(--rfx-text); }
.rfx-time-block-mode select,
.rfx-time-block-form input {
  height: 36px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 10px; font: inherit; font-size: 13px; min-width: 0;
}
.rfx-time-block-mode span { font-size: 12px; color: var(--rfx-muted); line-height: 1.35; }
.rfx-time-block-form {
  display: grid; grid-template-columns: minmax(160px, 1fr) auto auto auto;
  gap: 8px; align-items: end;
}
.rfx-time-block-form label { display: grid; gap: 4px; font-size: 11px; font-weight: 800; color: var(--rfx-muted); }
.rfx-time-block-form button,
.rfx-time-block-item button {
  height: 36px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 12px; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; white-space: nowrap;
}
.rfx-time-block-form button:hover,
.rfx-time-block-item button:hover { background: var(--rfx-surface-soft); }
.rfx-time-block-list { display: grid; gap: 6px; }
.rfx-time-block-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 10px; border: 1px solid var(--rfx-border-soft); border-radius: 8px; background: var(--rfx-surface);
}
.rfx-time-block-item b { display: block; font-size: 13px; color: var(--rfx-text); }
.rfx-time-block-item span { display: block; margin-top: 2px; font-size: 12px; color: var(--rfx-muted); }
.rfx-time-block-empty { padding: 10px; border: 1px dashed var(--rfx-border); border-radius: 8px; color: var(--rfx-muted); font-size: 12px; }
@media (max-width: 720px) {
  .rfx-time-block-mode { align-items: flex-start; flex-direction: column; }
  .rfx-time-block-form { grid-template-columns: 1fr; }
}
.rfx-discord-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 10px; background: var(--rfx-surface-muted); border: 1px solid var(--rfx-border-soft); border-radius: 8px;
}
.rfx-discord-note { font-size: 12px; color: var(--rfx-muted); line-height: 1.3; }
.rfx-discord-test-btn {
  border: 1px solid #5865f2; background: #5865f2; color: #fff; border-radius: 8px;
  padding: 7px 12px; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap;
}
.rfx-discord-test-btn:hover { background: #4752c4; }
.rfx-discord-test-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.rfx-lookout-box { display: grid; gap: 10px; }
.rfx-lookout-subhead { font-size: 12px; font-weight: 800; color: var(--rfx-text); margin-top: 4px; }
.rfx-lookout-grid,
.rfx-lookout-rule-grid {
  display: grid; gap: 8px; align-items: center;
}
.rfx-lookout-grid { grid-template-columns: minmax(120px, 1fr) minmax(180px, 1.6fr) 90px auto; }
.rfx-lookout-rule-grid { grid-template-columns: minmax(120px, 1fr) minmax(130px, 1fr) minmax(130px, 1fr) 95px 85px minmax(170px, 1.2fr) auto auto auto; }
.rfx-lookout-grid input,
.rfx-lookout-rule-grid input,
.rfx-lookout-rule-grid select {
  height: 38px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 10px; font: inherit; font-size: 13px; min-width: 0;
}
.rfx-lookout-rule-grid select[multiple],
.rfx-lookout-rule-edit select[multiple] {
  height: 78px;
  padding: 6px 8px;
}
.rfx-lookout-grid button,
.rfx-lookout-rule-grid button,
.rfx-lookout-item button {
  height: 38px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 12px; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; white-space: nowrap;
}
.rfx-lookout-grid button:hover,
.rfx-lookout-rule-grid button:hover,
.rfx-lookout-item button:hover { background: var(--rfx-surface-soft); }
.rfx-lookout-check,
.rfx-lookout-mini-toggle {
  display: inline-flex; align-items: center; gap: 6px; color: var(--rfx-text);
  font-size: 13px; font-weight: 700; white-space: nowrap;
}
.rfx-lookout-help,
.rfx-lookout-empty { font-size: 12px; color: var(--rfx-muted); line-height: 1.35; }
.rfx-lookout-list { display: grid; gap: 6px; }
.rfx-lookout-item {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center;
  padding: 8px 10px; border: 1px solid var(--rfx-border-soft); border-radius: 8px; background: var(--rfx-surface-muted);
}
.rfx-detection-rule-item { grid-template-columns: 1fr; padding: 12px; background: var(--rfx-surface); border-color: var(--rfx-border); }
.rfx-lookout-item b { display: block; font-size: 13px; color: var(--rfx-text); }
.rfx-lookout-item span { display: block; font-size: 12px; color: var(--rfx-muted); margin-top: 2px; line-height: 1.35; }
.rfx-lookout-edit-head {
  display: grid; grid-template-columns: minmax(160px, 260px) auto; gap: 8px; align-items: center;
}
.rfx-lookout-edit-head input,
.rfx-lookout-rule-edit input,
.rfx-lookout-rule-edit select {
  height: 34px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 9px; font: inherit; font-size: 12px; min-width: 0;
}
.rfx-lookout-edit-head input { font-weight: 800; color: var(--rfx-text); }
.rfx-lookout-edit-head span { margin: 0; color: var(--rfx-faint); font-weight: 700; }
.rfx-lookout-rule-edit {
  display: grid; grid-template-columns: minmax(130px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr) 92px 82px minmax(165px, 1.1fr) auto;
  gap: 8px; align-items: center;
}
.rfx-detection-builder {
  display: grid; gap: 10px; padding: 12px; border: 1px solid var(--rfx-border); border-radius: 10px; background: var(--rfx-surface);
}
.rfx-detection-builder-row {
  display: grid; grid-template-columns: minmax(160px, 1fr) 100px 90px minmax(130px, auto) auto;
  gap: 8px; align-items: center;
}
.rfx-detection-builder-row input {
  height: 38px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 10px; font: inherit; font-size: 13px; min-width: 0;
}
.rfx-detection-builder-row button {
  height: 38px; border: 1px solid #172033; border-radius: 8px; background: #172033; color: #fff;
  padding: 0 14px; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; white-space: nowrap;
}
.rfx-detection-route-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
}
.rfx-detection-picker {
  display: grid; gap: 8px; padding: 10px; border: 1px solid var(--rfx-border-soft); border-radius: 10px; background: var(--rfx-surface-muted);
}
.rfx-detection-picker-title {
  color: var(--rfx-muted); font-size: 11px; font-weight: 900; letter-spacing: .04em; text-transform: uppercase;
}
.rfx-detection-choice-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 7px;
}
.rfx-detection-choice {
  display: flex; align-items: center; gap: 8px; min-height: 42px;
  padding: 7px 9px; border: 1px solid var(--rfx-border); border-radius: 9px; background: var(--rfx-surface);
  cursor: pointer; user-select: none;
}
.rfx-detection-choice.selected,
.rfx-detection-choice:has(input:checked) {
  border-color: var(--rfx-choice-selected-border);
  background: var(--rfx-choice-selected-bg);
  box-shadow: inset 0 0 0 1px var(--rfx-choice-selected-border);
}
.rfx-detection-choice input { width: 16px; height: 16px; accent-color: var(--rfx-primary); flex: 0 0 auto; }
.rfx-detection-choice span { margin: 0; min-width: 0; }
.rfx-detection-choice b {
  display: block; font-size: 13px; line-height: 1.15; color: var(--rfx-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rfx-detection-choice small { display: block; margin-top: 2px; color: var(--rfx-muted); font-size: 11px; font-weight: 700; }
.rfx-detection-rule-card { display: grid; gap: 10px; }
.rfx-detection-rule-head {
  display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 10px; align-items: center;
}
.rfx-detection-rule-head input {
  height: 36px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 10px; font: inherit; font-size: 13px; font-weight: 800; min-width: 0;
}
.rfx-detection-rule-controls {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end;
  padding-top: 2px;
}
.rfx-detection-rule-controls label:not(.rfx-lookout-check) {
  display: inline-flex; align-items: center; gap: 6px; color: var(--rfx-muted); font-size: 12px; font-weight: 800;
}
.rfx-detection-rule-controls input[type="number"] {
  width: 78px; height: 34px; border: 1px solid var(--rfx-border); border-radius: 8px; padding: 0 8px; font: inherit;
  background: var(--rfx-surface); color: var(--rfx-text);
}
.rfx-detection-rule-controls button {
  height: 34px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 12px; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer;
}
.rfx-lookout-places { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.rfx-lookout-place-chip {
  display: inline-flex !important; align-items: center; gap: 6px;
  background: var(--rfx-chip-bg); border: 1px solid var(--rfx-chip-border); border-radius: 999px;
  padding: 5px 8px; font-size: 12px; font-weight: 700; color: var(--rfx-chip-text) !important;
}
.rfx-lookout-place-chip input {
  width: 56px; height: 24px; border: 1px solid var(--rfx-chip-border); border-radius: 999px;
  padding: 0 6px; font: inherit; font-size: 12px; font-weight: 800;
  background: var(--rfx-chip-input-bg); color: var(--rfx-text);
}
.rfx-lookout-place-chip button {
  width: 18px; height: 18px; padding: 0; border-radius: 50%; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: var(--rfx-chip-remove-bg); color: var(--rfx-chip-remove-text);
}
.rfx-lookout-add-place {
  display: grid; grid-template-columns: minmax(150px, 1fr) 82px auto;
  gap: 6px; margin-top: 8px;
}
.rfx-lookout-add-place input {
  height: 34px; border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface);
  color: var(--rfx-text); padding: 0 9px; font: inherit; font-size: 12px; min-width: 0;
}
.rfx-lookout-add-place button { height: 34px; font-size: 12px; }
.rfx-clear-hidden-btn {
  border: 1px solid var(--rfx-border); background: var(--rfx-surface); border-radius: 6px; padding: 5px 10px;
  cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; color: var(--rfx-text);
}
.rfx-clear-hidden-btn:hover { background: var(--rfx-surface-soft); }
.rfx-card.booking-pending {
  border-color: #ff9900;
  animation: rfxBookPulse 2s infinite;
}
@keyframes rfxBookPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,153,0,0); } 50% { box-shadow: 0 0 8px 2px rgba(255,153,0,0.3); } }
.rfx-toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  background: #232f3e; color: #fff; padding: 10px 20px; border-radius: 8px;
  font-size: 14px; z-index: 9999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  font-family: inherit; animation: rfxToastIn 0.3s;
}
@keyframes rfxToastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

.rfx-empty { text-align: center; color: var(--rfx-faint); padding: 40px 20px; font-size: 14px; }

/* Settings */
.rfx-gear-btn {
  background: var(--rfx-surface); border: 1px solid var(--rfx-border); border-radius: 6px; cursor: pointer;
  font-size: 16px; padding: 2px 8px; line-height: 1; color: var(--rfx-muted);
}
.rfx-gear-btn:hover { background: var(--rfx-surface-soft); }
.rfx-settings-panel {
  background: var(--rfx-surface-soft); border: 1px solid var(--rfx-border); border-radius: 12px;
  padding: 14px; margin-bottom: 12px; display: none;
}
.rfx-settings-panel.open { display: block; }
.rfx-settings-panel input,
.rfx-settings-panel select,
.rfx-settings-panel textarea,
.rfx-date-filter input {
  color-scheme: light;
}
.rfx-root.rfx-theme-dark .rfx-settings-panel input,
.rfx-root.rfx-theme-dark .rfx-settings-panel select,
.rfx-root.rfx-theme-dark .rfx-settings-panel textarea,
.rfx-root.rfx-theme-dark .rfx-date-filter input {
  color-scheme: dark;
}
.rfx-root.rfx-theme-dark .rfx-settings-panel input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
.rfx-root.rfx-theme-dark .rfx-settings-panel select,
.rfx-root.rfx-theme-dark .rfx-settings-panel textarea,
.rfx-root.rfx-theme-dark .rfx-date-filter input:not([type="checkbox"]):not([type="radio"]):not([type="range"]) {
  background: var(--rfx-chip-input-bg);
  color: var(--rfx-text);
  border-color: var(--rfx-border);
}
.rfx-settings-panel input::placeholder,
.rfx-settings-panel textarea::placeholder { color: var(--rfx-faint); opacity: 1; }
.rfx-root.rfx-theme-dark .rfx-settings-panel input[type="date"]::-webkit-calendar-picker-indicator,
.rfx-root.rfx-theme-dark .rfx-settings-panel input[type="time"]::-webkit-calendar-picker-indicator,
.rfx-root.rfx-theme-dark .rfx-settings-panel input[type="datetime-local"]::-webkit-calendar-picker-indicator,
.rfx-root.rfx-theme-dark .rfx-date-filter input[type="date"]::-webkit-calendar-picker-indicator,
.rfx-root.rfx-theme-dark .rfx-date-filter input[type="time"]::-webkit-calendar-picker-indicator,
.rfx-root.rfx-theme-dark .rfx-date-filter input[type="datetime-local"]::-webkit-calendar-picker-indicator {
  filter: invert(1);
  opacity: 0.8;
}
@media (prefers-color-scheme: dark) {
  .rfx-root.rfx-theme-system .rfx-settings-panel input,
  .rfx-root.rfx-theme-system .rfx-settings-panel select,
  .rfx-root.rfx-theme-system .rfx-settings-panel textarea,
  .rfx-root.rfx-theme-system .rfx-date-filter input {
    color-scheme: dark;
  }
  .rfx-root.rfx-theme-system .rfx-settings-panel input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  .rfx-root.rfx-theme-system .rfx-settings-panel select,
  .rfx-root.rfx-theme-system .rfx-settings-panel textarea,
  .rfx-root.rfx-theme-system .rfx-date-filter input:not([type="checkbox"]):not([type="radio"]):not([type="range"]) {
    background: var(--rfx-chip-input-bg);
    color: var(--rfx-text);
    border-color: var(--rfx-border);
  }
  .rfx-root.rfx-theme-system .rfx-settings-panel input[type="date"]::-webkit-calendar-picker-indicator,
  .rfx-root.rfx-theme-system .rfx-settings-panel input[type="time"]::-webkit-calendar-picker-indicator,
  .rfx-root.rfx-theme-system .rfx-settings-panel input[type="datetime-local"]::-webkit-calendar-picker-indicator,
  .rfx-root.rfx-theme-system .rfx-date-filter input[type="date"]::-webkit-calendar-picker-indicator,
  .rfx-root.rfx-theme-system .rfx-date-filter input[type="time"]::-webkit-calendar-picker-indicator,
  .rfx-root.rfx-theme-system .rfx-date-filter input[type="datetime-local"]::-webkit-calendar-picker-indicator {
    filter: invert(1);
    opacity: 0.8;
  }
}
.rfx-settings-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 14px;
  padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--rfx-border-soft);
}
.rfx-settings-title {
  font-size: 18px; font-weight: 800; color: var(--rfx-text);
  padding: 2px 2px 4px 2px;
}
.rfx-settings-subtitle { font-size: 12px; color: var(--rfx-muted); padding-left: 2px; }
.rfx-settings-tabs { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.rfx-settings-tab {
  border: 1px solid var(--rfx-border); background: var(--rfx-surface); color: var(--rfx-text); border-radius: 999px;
  padding: 8px 13px; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer;
}
.rfx-settings-tab:hover { background: var(--rfx-surface-soft); }
.rfx-settings-tab.active { background: var(--rfx-navy); border-color: var(--rfx-navy); color: #fff; }
.rfx-settings-tab-panel { display: none; }
.rfx-settings-tab-panel.active { display: block; }
.rfx-settings-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
}
.rfx-settings-section {
  background: var(--rfx-surface); border: 1px solid var(--rfx-border-soft); border-radius: 10px;
  padding: 12px; display: grid; gap: 8px; align-content: start;
  box-shadow: 0 1px 2px rgba(15,17,17,0.04);
}
.rfx-settings-section-full { grid-column: 1 / -1; }
.rfx-display-settings {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
}
.rfx-display-settings .rfx-settings-section-title { grid-column: 1 / -1; }
.rfx-settings-section-title {
  font-size: 11px; font-weight: 800; color: var(--rfx-muted); text-transform: uppercase;
  letter-spacing: 0.7px; padding-bottom: 6px; border-bottom: 1px solid var(--rfx-border-soft);
}
.rfx-settings-help { font-size: 11px; color: var(--rfx-faint); padding: 2px 0 0 0; line-height: 1.35; }
.rfx-profit-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
}
.rfx-profit-field {
  display: grid; gap: 5px; padding: 9px 10px; background: var(--rfx-surface-muted);
  border: 1px solid var(--rfx-border-soft); border-radius: 8px;
}
.rfx-profit-field label { font-size: 12px; color: var(--rfx-muted); font-weight: 800; }
.rfx-profit-field input {
  height: 36px; border: 1px solid var(--rfx-border); border-radius: 8px;
  padding: 0 10px; font: inherit; font-size: 14px; background: var(--rfx-surface); color: var(--rfx-text);
}
.rfx-setting-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  background: var(--rfx-surface-muted); border: 1px solid var(--rfx-border-soft); border-radius: 8px;
}
.rfx-setting-row label { font-size: 13px; color: var(--rfx-text); cursor: pointer; flex: 1; line-height: 1.3; }
.rfx-setting-row input[type="checkbox"] {
  appearance: none; width: 38px; height: 22px; border-radius: 999px; cursor: pointer;
  background: var(--rfx-border); border: 1px solid var(--rfx-border); position: relative; flex: 0 0 38px;
  transition: background 0.15s, border-color 0.15s;
}
.rfx-setting-row input[type="checkbox"]::after {
  content: ""; position: absolute; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; top: 1px; left: 1px; box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  transition: transform 0.15s;
}
.rfx-setting-row input[type="checkbox"]:checked { background: var(--rfx-primary); border-color: var(--rfx-primary); }
.rfx-setting-row input[type="checkbox"]:checked::after { transform: translateX(16px); }
.rfx-range-row {
  display: grid; grid-template-columns: 120px minmax(120px, 1fr) 52px; align-items: center;
  gap: 10px; padding: 8px 10px; background: var(--rfx-surface-muted); border: 1px solid var(--rfx-border-soft); border-radius: 8px;
}
.rfx-range-row label { font-size: 13px; color: var(--rfx-text); font-weight: 600; }
.rfx-range-row input[type="range"] { width: 100%; accent-color: var(--rfx-orange); }
.rfx-range-val {
  font-size: 13px; font-weight: 800; color: var(--rfx-text); text-align: right;
  font-variant-numeric: tabular-nums;
}
.rfx-city-exclude-box { display: grid; gap: 8px; }
.rfx-city-input-row { display: flex; gap: 8px; align-items: center; }
.rfx-city-input-row input {
  flex: 1; min-width: 0; height: 38px; border: 1px solid var(--rfx-border); border-radius: 8px;
  padding: 0 12px; font-size: 13px; font-family: inherit; background: var(--rfx-surface); color: var(--rfx-text);
}
.rfx-city-input-row button,
.rfx-city-chip {
  border: 1px solid var(--rfx-border); border-radius: 8px; background: var(--rfx-surface); color: var(--rfx-text);
  font-size: 13px; font-family: inherit; cursor: pointer;
}
.rfx-city-input-row button { height: 38px; padding: 0 14px; font-weight: 800; }
.rfx-city-help { font-size: 12px; color: var(--rfx-muted); line-height: 1.35; }
.rfx-city-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rfx-city-chip {
  padding: 6px 10px;
  background: var(--rfx-chip-bg);
  border-color: var(--rfx-chip-border);
  color: var(--rfx-chip-text);
  font-weight: 600;
}
.rfx-city-empty { font-size: 12px; color: var(--rfx-faint); }
.rfx-select-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 10px; background: var(--rfx-surface-muted); border: 1px solid var(--rfx-border-soft); border-radius: 8px;
}
.rfx-select-row label { font-size: 13px; color: var(--rfx-text); font-weight: 700; }
.rfx-select-row select {
  height: 34px; min-width: 130px; border: 1px solid var(--rfx-border); border-radius: 8px;
  background: var(--rfx-surface); color: var(--rfx-text); font: inherit; font-size: 13px; padding: 0 8px;
}

/* Responsive — tablet */
@media (max-width: 900px) {
  .rfx-right { min-width: 110px; }
  .rfx-payout { font-size: 18px; }
  .rfx-stat { font-size: 12px; }
}

/* Responsive — mobile */
@media (max-width: 640px) {
  .rfx-status-bar {
    position: sticky; top: 0; z-index: 100;
    padding: 10px 12px; gap: 8px; border-radius: 0;
    margin: 0 -16px 10px -16px; width: calc(100% + 32px);
    border-left: none; border-right: none;
  }
  .rfx-status-text { font-size: 12px; }
  .rfx-last-refresh { font-size: 11px; display: none; }
  .rfx-bot-btn { padding: 10px 20px; font-size: 15px; min-height: 44px; }
  .rfx-gear-btn { font-size: 20px; padding: 6px 10px; min-height: 44px; }
  .rfx-body { flex-direction: column; gap: 6px; }
  .rfx-right {
    flex-direction: row; align-items: center; gap: 10px;
    min-width: 0; text-align: left; flex-wrap: wrap;
    border-top: 1px solid #f0f0f0; padding-top: 8px;
  }
  .rfx-stats-group { flex-direction: row; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  .rfx-payout { font-size: 22px; }
  .rfx-stat { font-size: 13px; margin-top: 0; }
  .rfx-book-btn { margin-left: auto; padding: 10px 20px; font-size: 15px; min-height: 44px; }
  .rfx-roundtrip-grid { grid-template-columns: 1fr; }
  .rfx-roundtrip-money { align-items: flex-start; min-width: 0; }
  .rfx-roundtrip-stat { text-align: left; }
  .rfx-roundtrip-actions { justify-content: flex-start; }
  .rfx-card { padding: 12px; margin-bottom: 10px; }
  .rfx-toolbar { gap: 4px; padding: 8px 0; }
  .rfx-sort-btn { padding: 6px 10px; font-size: 12px; min-height: 36px; }
  .rfx-toolbar-filter { width: 100%; margin-left: 0; }
  .rfx-toolbar-filter select { flex: 1; min-height: 36px; }
  .rfx-count { width: 100%; margin-left: 0; font-size: 12px; }
  .rfx-date-filter { flex-direction: column; align-items: stretch; gap: 10px; padding: 10px; }
  .rfx-date-filter-head { gap: 8px; }
  .rfx-date-filter-summary { font-size: 11px; }
  .rfx-date-filter-body { flex-direction: column; align-items: stretch; gap: 8px; }
  .rfx-date-filter-main { flex-direction: column; align-items: stretch; gap: 8px; }
  .rfx-date-inputs { display: grid; grid-template-columns: 1fr; gap: 8px; }
  .rfx-date-inputs label { align-items: stretch; flex-direction: column; gap: 4px; }
  .rfx-date-inputs input, .rfx-date-actions button { min-height: 40px; }
  .rfx-date-actions { justify-content: stretch; }
  .rfx-date-actions button { flex: 1; }
  .rfx-stop-name { font-size: 14px; }
  .rfx-stop-time { font-size: 13px; }
  .rfx-badge { font-size: 11px; padding: 2px 8px; }
  .rfx-footer { gap: 8px; padding-top: 8px; }
  .rfx-tag { font-size: 13px; }
  .rfx-score-row { margin-bottom: 8px; }
  .rfx-version { font-size: 12px; }
  .rfx-settings-panel { padding: 10px; border-radius: 10px; }
  .rfx-settings-head { align-items: stretch; flex-direction: column; gap: 10px; }
  .rfx-settings-tabs { justify-content: flex-start; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 2px; }
  .rfx-settings-tab { flex: 0 0 auto; min-height: 40px; }
  .rfx-settings-grid { grid-template-columns: 1fr; gap: 10px; }
  .rfx-settings-title { font-size: 17px; }
  .rfx-settings-section { padding: 11px; gap: 8px; }
  .rfx-display-settings { grid-template-columns: 1fr; }
  .rfx-profit-grid { grid-template-columns: 1fr; }
  .rfx-setting-row { min-height: 48px; padding: 10px; }
  .rfx-setting-row label { font-size: 14px; }
  .rfx-setting-row input[type="checkbox"] { width: 42px; height: 24px; flex-basis: 42px; }
  .rfx-setting-row input[type="checkbox"]::after { width: 20px; height: 20px; }
  .rfx-setting-row input[type="checkbox"]:checked::after { transform: translateX(18px); }
  .rfx-range-row { grid-template-columns: 1fr auto; gap: 8px; padding: 10px; }
  .rfx-range-row label { font-size: 14px; }
  .rfx-range-row input[type="range"] { grid-column: 1 / -1; min-height: 34px; }
  .rfx-range-val { font-size: 14px; min-width: 52px; }
  .rfx-city-input-row { align-items: stretch; }
  .rfx-city-input-row input { height: 44px; font-size: 15px; }
  .rfx-city-input-row button { height: 44px; font-size: 15px; }
  .rfx-city-chip { min-height: 36px; font-size: 14px; }
  .rfx-lookout-grid,
  .rfx-lookout-rule-grid { grid-template-columns: 1fr; }
  .rfx-lookout-grid input,
  .rfx-lookout-rule-grid input,
  .rfx-lookout-rule-grid select,
  .rfx-lookout-grid button,
  .rfx-lookout-rule-grid button { height: 44px; font-size: 15px; }
  .rfx-lookout-item { grid-template-columns: 1fr; align-items: stretch; }
  .rfx-lookout-item button { height: 40px; }
  .rfx-lookout-edit-head,
  .rfx-lookout-rule-edit { grid-template-columns: 1fr; }
  .rfx-lookout-edit-head input,
  .rfx-lookout-rule-edit input,
  .rfx-lookout-rule-edit select { height: 42px; font-size: 14px; }
  .rfx-lookout-rule-grid select[multiple],
  .rfx-lookout-rule-edit select[multiple] { height: 104px; }
  .rfx-detection-builder-row,
  .rfx-detection-route-grid,
  .rfx-detection-rule-head { grid-template-columns: 1fr; }
  .rfx-detection-choice-grid { grid-template-columns: 1fr; }
  .rfx-detection-builder-row input,
  .rfx-detection-builder-row button,
  .rfx-detection-rule-head input { height: 44px; font-size: 15px; }
  .rfx-detection-rule-controls { justify-content: flex-start; }
  .rfx-lookout-add-place { grid-template-columns: 1fr; }
  .rfx-lookout-add-place input,
  .rfx-lookout-add-place button { height: 42px; font-size: 14px; }
  .rfx-fastbook-warn { font-size: 11px; padding: 6px 10px; }
  .rfx-autobook-warn { font-size: 12px; padding: 8px 12px; }
}

/* Responsive — small phone */
@media (max-width: 400px) {
  .rfx-stop-addr { display: none; }
  .rfx-leg-dist { display: none; }
  .rfx-payout { font-size: 20px; }
  .rfx-stat { font-size: 12px; }
  .rfx-bot-btn { padding: 8px 16px; font-size: 14px; }
  .rfx-sort-btn { padding: 5px 8px; font-size: 11px; }
}
`;

// ============================================================
// CARD HTML
// ============================================================
function renderCard(wo, extraClass, changeBadge) {
  const pay = wo.payout?.value || 0, dist = wo.totalDistance?.value || 0;
  const durMs = wo.totalDuration || 0, durH = durMs / 3600000;
  const perHr = durH > 0 ? pay / durH : 0, perMi = dist > 0 ? pay / dist : 0;
  const ver = wo.version || 1, score = scoreLoad(wo), sc = scoreColor(score);
  const stops = getAllStops(wo);
  const driver = wo.transitOperatorType === "TEAM_DRIVER" ? "Team" : "Solo";
  const firstTz = stops[0]?.location?.timeZone || "America/Los_Angeles";
  const timingRisk = settings.showTimingRisk ? getTimingRisk(wo) : null;
  const stemWarning = getStemTimeWarning(wo);
  const timeConflict = settings.bookedTimeBlockMode === "warn" ? getBookedTimeConflict(wo) : null;
  const privateLoad = isPrivateLoad(wo);
  const loadDisplayId = getLoadDisplayId(wo);
  const flexibleArrival = settings.showFlexibleArrivalWindow
    ? getFlexibleArrivalWindow(wo, firstTz)
    : null;
  const bState = bookingState.get(wo.id) || "idle";
  const armedForFastBook = settings.fastBook || armedFastBookLoads.has(wo.id);
  const bookButtonHtml = bState === "confirmed"
    ? `<button class="rfx-book-btn" style="background:#067d62;color:#fff;cursor:default" disabled>✅ Booked</button>`
    : bState === "pending"
      ? `<button class="rfx-book-btn pending" data-wo-id="${wo.id}" disabled>Booking...</button>`
      : `<button class="rfx-book-btn" data-wo-id="${wo.id}" data-action="${armedForFastBook ? "fastbook" : "arm"}">${armedForFastBook ? (bState === "failed" ? "RETRY FASTBOOK" : "FASTBOOK") : "BOOK"}</button>`;
  const patButtonHtml = renderPatButton(wo);
  const cls = [
    "rfx-card",
    goneLoads.has(wo.id) ? "gone" : "",
    bState === "pending" ? "booking-pending" : "",
    extraClass || "",
  ].filter(Boolean).join(" ");

  let vBadge = "";
  if (settings.showVersionBadge) {
    if (ver > 3) vBadge = `<span class="rfx-version bad">v${ver} ⚠</span>`;
    else if (ver > 1) vBadge = `<span class="rfx-version ok">v${ver}</span>`;
  }

  const priceDeltaText = changeBadge?.priceDelta ? formatPriceDelta(changeBadge.priceDelta) : "";
  const priceDeltaClass = changeBadge?.priceDelta > 0 ? "up" : "down";
  let badgeHtml = changeBadge && !priceDeltaText ? `<span class="rfx-change-badge ${changeBadge.cls}">${changeBadge.text}</span>` : "";
  if (goneLoads.has(wo.id)) badgeHtml = `<span class="rfx-change-badge badge-gone">GONE</span>`;
  const firstStopDetails = [
    settings.showDriverType ? driver : "",
    settings.showEquipment ? "53' Trailer" : "",
    settings.showLoadTypeBadge && hasPreloadedStop(wo) ? "Preloaded" : "",
  ].filter(Boolean).map(v => `<span class="rfx-inline-detail">${v}</span>`).join("");

  let stopsHtml = "";
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], loc = s.location || {};
    const dotCls = s.stopType === "PICKUP" ? "pickup" : "dropoff";
    const checkin = s.actions?.find(a => a.type === "CHECKIN")?.plannedTime;
    const checkout = s.actions?.find(a => a.type === "CHECKOUT")?.plannedTime;
    const tz = loc.timeZone || firstTz;
    let dwell = "";
    if (checkin && checkout) { const d = new Date(checkout) - new Date(checkin); if (d > 0) dwell = fmtDur(d); }
    const loadTypes = getPickupLoadTypesForStop(wo, s);
    const extraMeta = settings.showExtraStopMeta ? loadTypes.map(v => `<span class="rfx-extra">${escapeHtml(v)}</span>`).join("") : "";
    const cityState = `${loc.city || "?"}, ${loc.state || "?"}`;
    const stopLabel = loc.label || loc.stopCode || "";
    const stopName = settings.showStopCode && stopLabel ? `${stopLabel} · ${cityState}` : cityState;
    const stopDateTime = fmtStopTimeWindow(checkin, checkout, tz);
    const conn = i < stops.length - 1;
    stopsHtml += `<div class="rfx-stop">
      <div class="rfx-stop-line">
        <div class="rfx-stop-dot ${dotCls}">${i + 1}</div>
        ${conn ? '<div class="rfx-stop-conn"></div>' : ""}
      </div>
      <div class="rfx-stop-info">
          <div class="rfx-stop-head">
            <div class="rfx-stop-name">${stopName}</div>
            ${stopDateTime ? `<span class="rfx-stop-datetime"><span>${stopDateTime}</span>${i === 0 && firstStopDetails ? firstStopDetails : ""}</span>` : ""}
        </div>
        ${settings.showStopAddress ? `<div class="rfx-stop-addr">${[loc.line1, loc.line2].filter(Boolean).join(", ")}</div>` : ""}
        <div class="rfx-stop-meta">
          ${i === 0 && flexibleArrival ? `<span class="rfx-flex-window" title="${escapeHtml(flexibleArrival.duration)} editable pickup window">${escapeHtml(flexibleArrival.label)}</span>` : ""}
          ${dwell && settings.showDwellTime ? `<span class="rfx-stop-dwell">${dwell}</span>` : ""}
          ${extraMeta}
        </div>
      </div>
    </div>`;
    if (conn && settings.showLegDistance && loc.latitude && loc.longitude) {
      const nL = stops[i + 1]?.location;
      if (nL?.latitude && nL?.longitude) {
        const ld = (haversine(loc.latitude, loc.longitude, nL.latitude, nL.longitude) * 1.25).toFixed(1);
        stopsHtml += `<div class="rfx-leg-dist">↓ ~${ld} mi</div>`;
      }
    }
  }

  // Build stats conditionally
  let statsHtml = `${priceDeltaText ? `<span class="rfx-price-delta ${priceDeltaClass}">${priceDeltaText}</span>` : ""}<span class="rfx-payout">${fmt$(pay)}</span>`;
  if (settings.showPerHr) statsHtml += `<span class="rfx-stat"><b>${fmt$(perHr)}</b>/hr</span>`;
  if (settings.showPerMi) statsHtml += `<span class="rfx-stat"><b>${fmt$(perMi)}</b>/mi</span>`;
  const fuelProfit = settings.showProfitEstimate ? calcFuelProfit(wo) : null;
  if (fuelProfit) {
    const title = `Fuel-only estimate: ${fuelProfit.totalMiles.toFixed(1)} total mi / ${fuelProfit.mpg.toFixed(1)} MPG × ${fmt$(fuelProfit.fuelPrice)} = ${fmt$(fuelProfit.fuelCost)} fuel`;
    statsHtml += `<span class="rfx-profit-est ${fuelProfit.profit < 0 ? "negative" : ""}" title="${escapeHtml(title)}">${fmt$(fuelProfit.profit)} / ${fmt$(fuelProfit.fuelCost)}</span>`;
  }
  const distDur = [];
  if (settings.showDistance) distDur.push(`<b>${dist.toFixed(1)}</b> mi`);
  if (settings.showDuration) distDur.push(`<b>${fmtDur(durMs)}</b>`);
  if (distDur.length) statsHtml += `<span class="rfx-stat">${distDur.join(" · ")}</span>`;
  statsHtml += vBadge;

  // Build footer tags conditionally
  let footerTags = "";
  const postedAge = fmtAge(wo.createdAtTime);
  if (loadDisplayId) footerTags += `<span class="rfx-tag rfx-load-id" title="${escapeHtml(wo.id)}">ID ${escapeHtml(loadDisplayId)}</span>`;
  if (privateLoad) footerTags += `<span class="rfx-tag rfx-private-tag">Private load</span>`;
  if (settings.showPostedAge && postedAge) footerTags += `<span class="rfx-tag">${postedAge}</span>`;
  if (settings.showStopCount) footerTags += `<span class="rfx-tag">${wo.stopCount || stops.length} stops</span>`;
  if (timingRisk) footerTags += `<span class="rfx-timing-risk ${timingRisk.level}" title="${escapeHtml(timingRisk.detail)}">Timing issue · ${escapeHtml(timingRisk.label)}</span>`;
  if (stemWarning) footerTags += `<span class="rfx-stem-risk" title="${escapeHtml(stemWarning.detail)}">Stand warning · ${escapeHtml(stemWarning.label)}</span>`;
  if (timeConflict) {
    const conflictRange = fmtBookedTimeBlockRange(timeConflict);
    const conflictLabel = timeConflict.label ? `${timeConflict.label} · ${conflictRange}` : conflictRange;
    footerTags += `<span class="rfx-time-conflict" title="${escapeHtml(conflictLabel)}">Time conflict · ${escapeHtml(conflictRange)}</span>`;
  }

	  return `<div class="${cls}" data-id="${wo.id}">
	    <button type="button" class="rfx-hide-load-btn" data-hide-load-id="${wo.id}" title="Hide this load">×</button>
	    ${badgeHtml}
	    <div class="rfx-body">
      <div class="rfx-left">
        ${patButtonHtml ? `<div class="rfx-left-actions">${patButtonHtml}</div>` : ""}
        ${settings.showScoreBar ? `<div class="rfx-score-row">
          <div class="rfx-score-bg"><div class="rfx-score-fill" style="width:${score}%;background:${sc}"></div></div>
          <span class="rfx-score-label" style="color:${sc}">${score}</span>
          <span class="rfx-score-tag" style="background:${scoreBg(score)};color:${sc}">${score >= 70 ? "Great" : score >= 40 ? "OK" : "Low"}</span>
        </div>` : ""}
        <div class="rfx-stops">${stopsHtml}</div>
        ${footerTags ? `<div class="rfx-footer">${footerTags}</div>` : ""}
      </div>
      <div class="rfx-right">
        <div class="rfx-stats-group">${statsHtml}</div>
        <div class="rfx-card-actions">${bookButtonHtml}</div>
      </div>
    </div>
  </div>`;
}

function renderRoundTripBookButton(wo, isAlerted) {
  const bState = bookingState.get(wo.id) || "idle";
  const armedForFastBook = settings.fastBook || armedFastBookLoads.has(wo.id);
  if (bState === "confirmed") {
    return `<button class="rfx-book-btn" style="background:#067d62;color:#fff;cursor:default" disabled>Booked</button>`;
  }
  if (bState === "pending") {
    return `<button class="rfx-book-btn pending" data-wo-id="${wo.id}" disabled>Booking...</button>`;
  }
  return `<button class="rfx-book-btn" data-wo-id="${wo.id}" data-action="${armedForFastBook ? "fastbook" : "arm"}">${armedForFastBook ? "FASTBOOK" : "BOOK"}</button>`;
}

function renderRoundTripLeg(info, label) {
  const tz = info.first?.location?.timeZone || info.last?.location?.timeZone || "America/Los_Angeles";
  const start = fmtStopDateTime(getStopCheckin(info.first), tz);
  const end = fmtStopDateTime(getStopCheckout(info.last) || getStopCheckin(info.last), tz);
  return `<div class="rfx-roundtrip-leg">
    <div class="rfx-roundtrip-leg-title">${label}</div>
    <div class="rfx-roundtrip-route">${stopCityState(info.first)} → ${stopCityState(info.last)}</div>
    <div class="rfx-roundtrip-time">${start}${end ? ` → ${end}` : ""}</div>
    <div class="rfx-roundtrip-time">${fmt$(info.payout)} · ${(info.distance || 0).toFixed(1)} mi · ${fmtDur(info.duration)}</div>
  </div>`;
}

function renderRoundTripMatches(loads, alertMap) {
  const matches = buildRoundTripMatches(loads, alertMap);
  if (!settings.showRoundTrips) return "";
  const collapsed = !!settings.roundTripsCollapsed;
  const toggleLabel = collapsed ? "Show ▾" : "Hide ▴";
  if (!matches.length) {
    return `<div class="rfx-roundtrip-section ${collapsed ? "collapsed" : ""}">
      <button type="button" class="rfx-roundtrip-head" id="rfx-roundtrip-toggle">
        <div>
          <div class="rfx-roundtrip-title">Round trips</div>
          <div class="rfx-roundtrip-sub">No two-load round trips match your radius, time, and payout settings.</div>
        </div>
        <div class="rfx-roundtrip-toggle">${toggleLabel}</div>
      </button>
    </div>`;
  }

  const cards = matches.slice(0, 8).map((match, idx) => {
    const outboundAlert = alertMap.has(match.outbound.wo.id);
    const inboundAlert = alertMap.has(match.inbound.wo.id);
    return `<div class="rfx-roundtrip-card ${match.hasAlert ? "alerted" : ""}">
      <div class="rfx-roundtrip-grid">
        ${renderRoundTripLeg(match.outbound, `Load 1${outboundAlert ? " · new" : ""}`)}
        ${renderRoundTripLeg(match.inbound, `Return${inboundAlert ? " · new" : ""}`)}
        <div class="rfx-roundtrip-money">
          <div>
            <div class="rfx-roundtrip-payout">${fmt$(match.payout)}</div>
            <div class="rfx-roundtrip-stat"><b>${fmt$(match.perMile)}</b>/mi combined</div>
            <div class="rfx-roundtrip-stat">${match.totalMiles.toFixed(1)} total mi</div>
          </div>
          <div class="rfx-roundtrip-actions">
            ${renderRoundTripBookButton(match.outbound.wo, outboundAlert)}
            ${renderRoundTripBookButton(match.inbound.wo, inboundAlert)}
          </div>
        </div>
      </div>
      <div class="rfx-roundtrip-metrics">
        <span class="rfx-roundtrip-metric"><b>#${idx + 1}</b> match</span>
        <span class="rfx-roundtrip-metric">Deadhead to return pickup <b>${match.connectionMiles.toFixed(1)} mi</b></span>
        <span class="rfx-roundtrip-metric">Final distance from start <b>${match.returnMiles.toFixed(1)} mi</b></span>
        <span class="rfx-roundtrip-metric">Wait <b>${fmtWait(match.waitMs)}</b></span>
        <span class="rfx-roundtrip-metric">Total time <b>${fmtDur(match.totalTimeMs)}</b></span>
      </div>
    </div>`;
  }).join("");

  return `<div class="rfx-roundtrip-section ${collapsed ? "collapsed" : ""}">
    <button type="button" class="rfx-roundtrip-head" id="rfx-roundtrip-toggle">
      <div>
        <div class="rfx-roundtrip-title">Round trips</div>
        <div class="rfx-roundtrip-sub">Best two-load matches from this search result set.</div>
      </div>
      <div class="rfx-roundtrip-toggle">${matches.length} match${matches.length === 1 ? "" : "es"} · ${toggleLabel}</div>
    </button>
    <div class="rfx-roundtrip-body">${cards}</div>
  </div>`;
}

function renderCustomLoadBoard() {
  const alertMap = new Map();
  for (const alert of alertedLoads) {
    if (alert?.wo?.id) alertMap.set(alert.wo.id, alert);
  }

  const loadMap = new Map();
  for (const wo of dedupeLoads([...alertedLoads.map(a => a.wo), ...allLoads])) {
    loadMap.set(wo.id, wo);
  }

  const alerted = [];
  for (const alert of alertedLoads) {
    const wo = loadMap.get(alert.wo.id) || alert.wo;
    if (passesDisplayedLoadFilters(wo)) alerted.push({ wo, alert });
  }

  const regularLoads = sortLoads(
    Array.from(loadMap.values()).filter(wo => !alertMap.has(wo.id) && passesDisplayedLoadFilters(wo))
  );
  const hiddenByCity = Array.from(loadMap.values()).filter(wo => !passesCustomExcludedCities(wo)).length;
  const hiddenByFacility = Array.from(loadMap.values()).filter(wo => passesCustomExcludedCities(wo) && !passesAmazonOnlyFacilities(wo)).length;
  const hiddenByDetection = Array.from(loadMap.values()).filter(wo => passesCustomExcludedCities(wo) && passesAmazonOnlyFacilities(wo) && !passesDetectionDisplayRules(wo)).length;
  const hiddenByDate = Array.from(loadMap.values()).filter(wo => passesCustomExcludedCities(wo) && passesAmazonOnlyFacilities(wo) && passesDetectionDisplayRules(wo) && !passesCustomDateFilter(wo)).length;
  const hiddenByTimeBlock = Array.from(loadMap.values()).filter(wo => passesCustomExcludedCities(wo) && passesAmazonOnlyFacilities(wo) && passesDetectionDisplayRules(wo) && passesCustomDateFilter(wo) && !passesBookedTimeBlockFilter(wo)).length;
  const hiddenByLoad = Array.from(loadMap.values()).filter(wo => passesCustomExcludedCities(wo) && passesAmazonOnlyFacilities(wo) && passesDetectionDisplayRules(wo) && passesCustomDateFilter(wo) && passesBookedTimeBlockFilter(wo) && isIgnoredLoad(wo.id)).length;

  const sortBtn = (key, label) => {
    const active = currentSort === key ? " active" : "";
    const arrow = currentSort === key ? (currentSortDir === "asc" ? " ↑" : " ↓") : "";
    return `<button class="rfx-sort-btn${active}" data-sort="${key}">${label}${arrow}</button>`;
  };
  const cards = [
    ...alerted.map(({ wo, alert }) => renderCard(wo, "new-load", {
      text: alert.badge,
      cls: alert.badgeClass || "badge-new",
      priceDelta: alert.priceDelta,
    })),
    ...regularLoads.map(wo => renderCard(wo, "", null)),
  ].join("");
  const boardLoads = Array.from(loadMap.values()).filter(passesDisplayedLoadFilters);
  const roundTripsHtml = renderRoundTripMatches(boardLoads, alertMap);
  const hiddenTotal = hiddenByCity + hiddenByFacility + hiddenByDetection + hiddenByDate + hiddenByTimeBlock + hiddenByLoad;
  const hiddenReasons = [
    hiddenByCity ? `${hiddenByCity} excluded city` : "",
    hiddenByFacility ? `${hiddenByFacility} non-Amazon/private` : "",
    hiddenByDetection ? `${hiddenByDetection} detection rule` : "",
    hiddenByDate ? `${hiddenByDate} date window` : "",
    hiddenByTimeBlock ? `${hiddenByTimeBlock} time block` : "",
    hiddenByLoad ? `${hiddenByLoad} hidden load` : "",
  ].filter(Boolean);
  const emptyText = loadMap.size
    ? `All ${loadMap.size} loads are hidden by filters${hiddenReasons.length ? `: ${hiddenReasons.join(", ")}` : ""}.`
    : "Waiting for Amazon search results...";

  return `<div class="rfx-load-board">
    ${renderCustomDateFilter()}
    <div class="rfx-toolbar">
      <span class="rfx-toolbar-label">Sort</span>
      ${sortBtn("payout", "Payout")}
      ${sortBtn("perMile", "$/mi")}
      ${sortBtn("distance", "Distance")}
      ${sortBtn("time", "Start time")}
      ${sortBtn("postedAge", "Posted age")}
      <span class="rfx-count">${alerted.length + regularLoads.length} of ${loadMap.size} loads${alerted.length ? ` · ${alerted.length} new` : ""}${hiddenTotal ? ` · ${hiddenTotal} hidden` : ""}</span>
    </div>
    ${roundTripsHtml}
    ${alerted.length ? `<div class="rfx-section-title">Recently added</div>` : ""}
    ${cards || `<div class="rfx-empty">${escapeHtml(emptyText)}</div>`}
  </div>`;
}

// ============================================================
// FIND AMAZON'S LOAD CONTAINER
// ============================================================
function findLoadContainer() {
  // Try the known class first
  const loadList = document.querySelector(".load-list");
  if (loadList) return loadList;

  // Fallback: heuristic search
  const allEls = document.querySelectorAll("div, a, li, tr");
  const loadRows = [];
  for (const el of allEls) {
    if (el.closest("#rfx-host") || el.id === "rfx-host") continue;
    const t = el.textContent || "";
    if (t.length < 2000 && /\$\d+\.\d{2}/.test(t) && /\d+\.?\d*\s*mi/i.test(t) && el.children.length >= 2) {
      loadRows.push(el);
    }
  }
  if (loadRows.length < 3) return null;
  const parentCounts = new Map();
  for (const row of loadRows) {
    let p = row.parentElement;
    for (let depth = 0; depth < 5 && p; depth++) {
      parentCounts.set(p, (parentCounts.get(p) || 0) + 1);
      p = p.parentElement;
    }
  }
  let best = null, bestCount = 0, bestDepth = Infinity;
  for (const [el, count] of parentCounts) {
    if (count >= 3) {
      let depth = 0, p = el;
      while (p) { depth++; p = p.parentElement; }
      if (count > bestCount || (count === bestCount && depth > bestDepth)) {
        best = el; bestCount = count; bestDepth = depth;
      }
    }
  }
  return best;
}

function findCustomBoardMount() {
  const summaryPanel = document.getElementById("search-results-summary-panel");
  if (summaryPanel?.parentElement) {
    const parent = summaryPanel.parentElement;
    return {
      parent,
      before: parent.querySelector(".load-list, .no-results"),
    };
  }

  const loadList = document.querySelector(".load-list");
  if (loadList?.parentElement) return { parent: loadList.parentElement, before: loadList };

  const noResults = document.querySelector(".no-results");
  if (noResults?.parentElement) return { parent: noResults.parentElement, before: noResults };

  const activeTab = document.getElementById("active-tab-body")
    || document.querySelector(".base-container__body")
    || document.body;
  return { parent: activeTab, before: null };
}

function placeCustomBoardHost() {
  const mount = findCustomBoardMount();
  if (!mount?.parent?.isConnected) return false;

  if (!ourHost) {
    ourHost = document.createElement("div");
    ourHost.id = "rfx-host";
    shadowRoot = ourHost.attachShadow({ mode: "open" });
  }

  const before = mount.before && mount.before.parentElement === mount.parent && mount.before.isConnected
    ? mount.before
    : null;

  if (ourHost.parentElement !== mount.parent || (before && ourHost.nextSibling !== before)) {
    try {
      mount.parent.insertBefore(ourHost, before);
    } catch (err) {
      console.warn("[RFX] Could not place custom board, Amazon rerendered the results container.", err);
      return false;
    }
  }

  return true;
}

// ============================================================
// INJECT INTO AMAZON'S LOAD CARDS
// ============================================================
function injectCards() {
  if (!isLoadBoardPage()) return;
  if (!aiModeActive) return;
  applyPageTheme();

  // Find Amazon's load-list
  if (!amazonContainer) amazonContainer = document.querySelector(".load-list") || findLoadContainer();

  // Keep our board inside Amazon's results container, below the filter summary/tags.
  if (!placeCustomBoardHost()) return;

  // --- Render control panel in shadow DOM ---
  let dotClass = "grey", statusText = "Stopped";
  if (botStarting) { dotClass = settings.autoBook ? "red" : "amber"; statusText = settings.autoBook ? "Auto-booker baselining current loads..." : "Starting..."; }
  else if (botRunning) { dotClass = settings.autoBook ? "red" : "green"; statusText = settings.autoBook ? (autoBookAwaitingBaseline ? "Auto-booker baselining current loads..." : "Auto-booker waiting for new loads") : "Running"; }
  else if (autoBookCandidate) { dotClass = "red"; statusText = "Auto-booker stopped — candidate selected"; }
  else if (alertedLoads.length > 0) { dotClass = "amber"; statusText = "PAUSED — New Load Detected"; }

  const fastBookWarning = settings.fastBook
    ? `<span class="rfx-fastbook-warn">⚠ FAST BOOK ON — Clicking FASTBOOK will auto-confirm!</span>` : "";

  const statusBar = `<div class="rfx-status-bar">
    <button class="rfx-bot-btn rfx-start-btn" id="rfx-start-btn" ${botRunning || botStarting ? "disabled" : ""}>Start</button>
    <button class="rfx-bot-btn rfx-stop-btn" id="rfx-stop-btn" ${!botRunning ? "disabled" : ""}>Stop</button>
    <div class="rfx-dot ${dotClass}"></div>
    <span class="rfx-status-text"><b>${statusText}</b></span>
    <span class="rfx-last-refresh" id="rfx-last-refresh"></span>
    <button class="rfx-gear-btn" id="rfx-gear-btn" title="Settings">⚙</button>
    <button class="rfx-bot-btn rfx-amazon-view-btn" id="rfx-toggle-amazon">Amazon View</button>
    ${fastBookWarning}
  </div>`;

  const chk = (key, label) => `<div class="rfx-setting-row"><input type="checkbox" id="rfx-s-${key}" ${settings[key] ? "checked" : ""} data-key="${key}"><label for="rfx-s-${key}">${label}</label></div>`;
  const numSetting = (key, label, step = "0.1") => `<div class="rfx-profit-field"><label for="rfx-s-${key}">${label}</label><input type="number" id="rfx-s-${key}" min="0" step="${step}" value="${Number(settings[key]) || 0}" data-number-key="${key}"></div>`;
  const settingsTab = (key, label) => `<button type="button" class="rfx-settings-tab${activeSettingsTab === key ? " active" : ""}" data-settings-tab="${key}">${label}</button>`;
  const settingsPanelWrap = (key, html) => `<div class="rfx-settings-tab-panel${activeSettingsTab === key ? " active" : ""}" data-settings-panel="${key}">${html}</div>`;

  const settingsPanel = `<div class="rfx-settings-panel${settingsOpen ? " open" : ""}" id="rfx-settings-panel">
    <div class="rfx-settings-head">
      <div>
        <div class="rfx-settings-title">Settings</div>
        <div class="rfx-settings-subtitle">Keep daily controls separate from advanced tools.</div>
      </div>
      <div class="rfx-settings-tabs">
        ${settingsTab("quick", "Quick")}
        ${settingsTab("lookout", "Lookout")}
        ${settingsTab("detection", "Detection")}
        ${settingsTab("filters", "Filters")}
        ${settingsTab("roundTrips", "Round Trips")}
        ${settingsTab("profit", "Profit")}
        ${settingsTab("display", "Display")}
      </div>
    </div>
    ${settingsPanelWrap("quick", `
      <div class="rfx-settings-grid">
        <div class="rfx-settings-section">
          <div class="rfx-settings-section-title">General</div>
          ${chk("fastBook", "Fast Book — auto-confirm booking (skips manual confirmation)")}
          ${chk("autoBook", "Auto-Book Simulator — select one new qualifying load without booking")}
          ${settings.autoBook
            ? `<div class="rfx-setting-row"><input type="checkbox" id="rfx-s-autoResume" disabled><label for="rfx-s-autoResume">Auto-resume disabled while Auto-Book Simulator is on</label></div>`
            : chk("autoResume", "Auto-resume after stop — restart bot after 5 seconds")}
          ${chk("amazonOnlyFacilities", "Amazon facilities only")}
          ${chk("patEnabled", "PAT — show Post A Truck button on loads")}
          ${chk("hideFuzzyPatFooter", "Hide close-match PAT footer")}
          <div class="rfx-setting-row">
            <input type="checkbox" id="rfx-theme-dark-toggle" ${isPageDarkThemeActive() ? "checked" : ""}>
            <label for="rfx-theme-dark-toggle">Dark mode</label>
          </div>
        </div>
        <div class="rfx-settings-section">
          <div class="rfx-settings-section-title">Bot Speed</div>
          <div class="rfx-range-row"><label>Min interval</label><input type="range" id="rfx-s-pollMin" min="1" max="30" value="${settings.pollMinSeconds}" data-key="pollMinSeconds"><span class="rfx-range-val" id="rfx-s-pollMin-val">${settings.pollMinSeconds}s</span></div>
          <div class="rfx-range-row"><label>Max interval</label><input type="range" id="rfx-s-pollMax" min="1" max="30" value="${settings.pollMaxSeconds}" data-key="pollMaxSeconds"><span class="rfx-range-val" id="rfx-s-pollMax-val">${settings.pollMaxSeconds}s</span></div>
        </div>
        <div class="rfx-settings-section">
          <div class="rfx-settings-section-title">Alerts</div>
          <div class="rfx-range-row"><label>Min price increase</label><input type="range" id="rfx-s-minPrice" min="0" max="200" step="5" value="${settings.minPriceIncrease}" data-key="minPriceIncrease"><span class="rfx-range-val" id="rfx-s-minPrice-val">${fmtRangeSettingValue("minPriceIncrease", settings.minPriceIncrease)}</span></div>
          <div class="rfx-range-row"><label>Minimum stand time</label><input type="range" id="rfx-s-minStemTime" min="0" max="240" step="15" value="${settings.minStemTimeMinutes}" data-key="minStemTimeMinutes"><span class="rfx-range-val" id="rfx-s-minStemTime-val">${fmtRangeSettingValue("minStemTimeMinutes", settings.minStemTimeMinutes)}</span></div>
          <div class="rfx-settings-help">Only alert on price increases above this amount. Set to 0 to alert on all changes.</div>
        </div>
        <div class="rfx-settings-section">
          <div class="rfx-settings-section-title">Discord</div>
          <div class="rfx-discord-row">
            <div class="rfx-discord-note">Send a test notification to the configured Discord webhook.</div>
            <button type="button" class="rfx-discord-test-btn" id="rfx-test-discord">Test Discord</button>
          </div>
        </div>
      </div>
    `)}
    ${settingsPanelWrap("lookout", `
      <div class="rfx-settings-section rfx-settings-section-full">
        <div class="rfx-settings-section-title">Lookout</div>
        ${renderLookoutSettings()}
      </div>
    `)}
    ${settingsPanelWrap("detection", `
      <div class="rfx-settings-section rfx-settings-section-full">
        <div class="rfx-settings-section-title">Detection Rules</div>
        ${renderDetectionSettings()}
      </div>
    `)}
    ${settingsPanelWrap("filters", `
      <div class="rfx-settings-grid">
        <div class="rfx-settings-section rfx-settings-section-full">
          <div class="rfx-settings-section-title">Booked Time Blocks</div>
          ${renderBookedTimeBlockSettings()}
        </div>
        <div class="rfx-settings-section rfx-settings-section-full">
          <div class="rfx-settings-section-title">Custom Excluded Cities</div>
          ${renderCustomExcludedCitySettings()}
        </div>
        <div class="rfx-settings-section">
          <div class="rfx-settings-section-title">Hidden Loads</div>
          <div class="rfx-hidden-loads-row">
            <span>${getIgnoredLoadIds().size} hidden load${getIgnoredLoadIds().size === 1 ? "" : "s"}</span>
            <button type="button" class="rfx-clear-hidden-btn" id="rfx-clear-hidden-loads" ${getIgnoredLoadIds().size ? "" : "disabled"}>Clear hidden</button>
          </div>
        </div>
      </div>
    `)}
    ${settingsPanelWrap("roundTrips", `
      <div class="rfx-settings-section rfx-settings-section-full">
        <div class="rfx-settings-section-title">Round Trips</div>
        ${chk("showRoundTrips", "Show round-trip matches")}
        ${chk("roundTripRequireSameDriver", "Require same driver type")}
        ${chk("roundTripRequireSameEquipment", "Require same equipment")}
        <div class="rfx-range-row"><label>Connect radius</label><input type="range" id="rfx-s-rtConnect" min="5" max="150" step="5" value="${settings.roundTripConnectionRadiusMiles}" data-key="roundTripConnectionRadiusMiles"><span class="rfx-range-val" id="rfx-s-rtConnect-val">${fmtRangeSettingValue("roundTripConnectionRadiusMiles", settings.roundTripConnectionRadiusMiles)}</span></div>
        <div class="rfx-range-row"><label>Return radius</label><input type="range" id="rfx-s-rtReturn" min="5" max="150" step="5" value="${settings.roundTripReturnRadiusMiles}" data-key="roundTripReturnRadiusMiles"><span class="rfx-range-val" id="rfx-s-rtReturn-val">${fmtRangeSettingValue("roundTripReturnRadiusMiles", settings.roundTripReturnRadiusMiles)}</span></div>
        <div class="rfx-range-row"><label>Min buffer</label><input type="range" id="rfx-s-rtBuffer" min="0" max="240" step="15" value="${settings.roundTripMinBufferMinutes}" data-key="roundTripMinBufferMinutes"><span class="rfx-range-val" id="rfx-s-rtBuffer-val">${fmtRangeSettingValue("roundTripMinBufferMinutes", settings.roundTripMinBufferMinutes)}</span></div>
        <div class="rfx-range-row"><label>Max wait</label><input type="range" id="rfx-s-rtWait" min="1" max="48" step="1" value="${settings.roundTripMaxWaitHours}" data-key="roundTripMaxWaitHours"><span class="rfx-range-val" id="rfx-s-rtWait-val">${fmtRangeSettingValue("roundTripMaxWaitHours", settings.roundTripMaxWaitHours)}</span></div>
        <div class="rfx-range-row"><label>Min payout</label><input type="range" id="rfx-s-rtPayout" min="0" max="5000" step="50" value="${settings.roundTripMinPayout}" data-key="roundTripMinPayout"><span class="rfx-range-val" id="rfx-s-rtPayout-val">${fmtRangeSettingValue("roundTripMinPayout", settings.roundTripMinPayout)}</span></div>
        <div class="rfx-range-row"><label>Min $/mi</label><input type="range" id="rfx-s-rtPerMi" min="0" max="10" step="0.25" value="${settings.roundTripMinPerMile}" data-key="roundTripMinPerMile"><span class="rfx-range-val" id="rfx-s-rtPerMi-val">${fmtRangeSettingValue("roundTripMinPerMile", settings.roundTripMinPerMile)}</span></div>
      </div>
    `)}
    ${settingsPanelWrap("display", `
      <div class="rfx-settings-section rfx-display-settings">
        <div class="rfx-settings-section-title">Card Display</div>
        ${chk("showDistance", "Distance")}
        ${chk("showStopAddress", "Street addresses")}
        ${chk("showDwellTime", "Time at stop")}
        ${chk("showCheckoutTime", "Checkout time")}
        ${chk("showFlexibleArrivalWindow", "Flexible arrival window")}
        ${chk("showLoadTypeBadge", "Preloaded badge")}
        ${chk("showDriverType", "Driver type (Solo/Team)")}
        ${chk("showEquipment", "Equipment (53' Trailer)")}
        ${chk("showPostedAge", "Posted age")}
        ${chk("showTimingRisk", "Timing issue badge")}
        ${chk("showDuration", "Duration")}
        ${chk("showExtraStopMeta", "Loaded/empty badge")}
        ${chk("showScoreBar", "Score bar")}
        ${chk("showPerHr", "$/hr")}
        ${chk("showPerMi", "$/mi")}
        ${chk("showVersionBadge", "Version badge (v14 ⚠)")}
        ${chk("showLegDistance", "Leg distances between stops")}
        ${chk("showStopCount", "Stop count")}
        ${chk("showStopCode", "Stop code (SCK6, KSCK)")}
      </div>
    `)}
    ${settingsPanelWrap("profit", `
      <div class="rfx-settings-section rfx-settings-section-full">
        <div class="rfx-settings-section-title">Profit Calculator</div>
        ${chk("showProfitEstimate", "Show fuel-profit estimate on load cards")}
        <div class="rfx-profit-grid">
          ${numSetting("profitMpg", "Truck MPG", "0.1")}
          ${numSetting("profitFuelPrice", "Fuel price / gal", "0.01")}
          ${numSetting("profitDeadheadMiles", "Default deadhead miles", "1")}
          ${numSetting("profitReturnMiles", "Default return-home miles", "1")}
        </div>
        <div class="rfx-settings-help">Simple estimate only: payout minus fuel cost using loaded miles plus your default empty miles. It does not include driver pay, maintenance, insurance, tolls, or detention.</div>
      </div>
    `)}
  </div>`;

  const autoBookWarning = settings.autoBook
    ? `<div class="rfx-autobook-warn">${autoBookCandidate
      ? `Simulation only — Would book ${fmt$(autoBookCandidate.payout)} — Auto-booker stopped`
      : botStarting || autoBookAwaitingBaseline
        ? "Simulation only — Auto-booker on — Baselining current loads"
        : botRunning
          ? `Simulation only — Auto-booker on — Waiting for new loads — Minimum stand ${fmtMinutesShort(settings.minStemTimeMinutes)}`
          : "Simulation only — Auto-booker ready — Press Start to monitor new loads"}</div>` : "";

  const customLoadBoard = renderCustomLoadBoard();
  shadowRoot.innerHTML = `<style>${CSS}</style><div class="rfx-root ${getThemeClass()}">${statusBar}${autoBookWarning}${settingsPanel}${customLoadBoard}${renderPatModal()}</div>`;
  syncChatVisibility();

  // Bind control panel listeners
  const startBtn = shadowRoot.getElementById("rfx-start-btn");
  const stopBtn = shadowRoot.getElementById("rfx-stop-btn");
  if (startBtn) startBtn.addEventListener("click", startBot);
  if (stopBtn) stopBtn.addEventListener("click", stopBot);

  const gearBtn = shadowRoot.getElementById("rfx-gear-btn");
  if (gearBtn) gearBtn.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    const panel = shadowRoot.getElementById("rfx-settings-panel");
    if (panel) panel.classList.toggle("open", settingsOpen);
  });

  const toggleAmazonBtn = shadowRoot.getElementById("rfx-toggle-amazon");
  if (toggleAmazonBtn) toggleAmazonBtn.addEventListener("click", toggleAiMode);
  shadowRoot.querySelectorAll("[data-settings-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeSettingsTab = btn.dataset.settingsTab || "quick";
      injectCards();
    });
  });
  const testDiscordBtn = shadowRoot.getElementById("rfx-test-discord");
  if (testDiscordBtn) {
    testDiscordBtn.addEventListener("click", () => sendDiscordTestNotification(testDiscordBtn));
  }
  const darkModeToggle = shadowRoot.getElementById("rfx-theme-dark-toggle");
  if (darkModeToggle) {
    darkModeToggle.addEventListener("change", () => {
      settings.themeMode = darkModeToggle.checked ? "dark" : "light";
      saveSettings();
      applyPageTheme();
      if (chatWoId && negotiationState.has(chatWoId)) updateChatNegUI(chatWoId);
      injectCards();
    });
  }
  bindLookoutSettings();
  bindDetectionSettings();

  const roundTripToggle = shadowRoot.getElementById("rfx-roundtrip-toggle");
  if (roundTripToggle) {
    roundTripToggle.addEventListener("click", () => {
      settings.roundTripsCollapsed = !settings.roundTripsCollapsed;
      saveSettings();
      injectCards();
    });
  }

  shadowRoot.querySelectorAll('.rfx-setting-row input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.key;
      settings[key] = cb.checked;
      if (key === "fastBook" && cb.checked) settings.autoBook = false;
      else if (key === "autoBook" && cb.checked) {
        settings.fastBook = false;
        settings.autoResume = false;
        settings.amazonOnlyFacilities = true;
      }
      if (key === "autoBook") {
        cancelAutoResume();
        autoBookAwaitingBaseline = false;
        autoBookCandidate = null;
        if (botRunning || botStarting) stopBot({ allowAutoResume: false });
      }
      if ((key === "fastBook" && !cb.checked) || (key === "autoBook" && cb.checked)) armedFastBookLoads.clear();
      if (key === "autoResume" && !cb.checked) cancelAutoResume();
      if (key === "autoResume" && cb.checked && !settings.autoBook && !botRunning && !botStarting) scheduleAutoResume("setting enabled");
      if (key === "hideFuzzyPatFooter") settings.hideFuzzyPatFooterUserSet = true;
      saveSettings();
      if (key === "hideFuzzyPatFooter") applyFuzzyPatFooterVisibility();
      injectCards();
      if (key === "lookoutEnabled" && cb.checked) processLookoutAlerts(allLoads, "lookout-enabled");
    });
  });

  shadowRoot.querySelectorAll('.rfx-range-row input[type="range"]').forEach(slider => {
    slider.addEventListener("input", () => {
      const key = slider.dataset.key;
      settings[key] = key === "roundTripMinPerMile" ? parseFloat(slider.value) : parseInt(slider.value, 10);
      if (key === "pollMinSeconds" && settings.pollMinSeconds > settings.pollMaxSeconds) settings.pollMaxSeconds = settings.pollMinSeconds;
      if (key === "pollMaxSeconds" && settings.pollMaxSeconds < settings.pollMinSeconds) settings.pollMinSeconds = settings.pollMaxSeconds;
      saveSettings();
      const valEl = shadowRoot.getElementById(slider.id + "-val");
      if (valEl) valEl.textContent = fmtRangeSettingValue(key, slider.value);
      const minVal = shadowRoot.getElementById("rfx-s-pollMin-val");
      const maxVal = shadowRoot.getElementById("rfx-s-pollMax-val");
      if (minVal) minVal.textContent = settings.pollMinSeconds + "s";
      if (maxVal) maxVal.textContent = settings.pollMaxSeconds + "s";
    });
  });

  shadowRoot.querySelectorAll("[data-number-key]").forEach(input => {
    input.addEventListener("change", () => {
      const key = input.dataset.numberKey;
      settings[key] = Math.max(0, Number(input.value) || 0);
      saveSettings();
      injectCards();
    });
  });

  const dateEnabled = shadowRoot.getElementById("rfx-date-filter-enabled");
  const dateStart = shadowRoot.getElementById("rfx-date-filter-start");
  const dateEnd = shadowRoot.getElementById("rfx-date-filter-end");
  const dateCollapse = shadowRoot.getElementById("rfx-date-filter-collapse");
  if (dateCollapse) dateCollapse.addEventListener("click", () => {
    settings.customDateFilterCollapsed = !settings.customDateFilterCollapsed;
    saveSettings();
    injectCards();
  });
  const saveDateFilter = () => {
    settings.customDateFilterEnabled = !!dateEnabled?.checked;
    settings.customDateFilterStart = dateStart ? localDateTimeInputToIso(dateStart.value || "") : settings.customDateFilterStart;
    settings.customDateFilterEnd = dateEnd ? localDateTimeInputToIso(dateEnd.value || "") : settings.customDateFilterEnd;
    saveSettings();
    injectCards();
  };
  if (dateEnabled) dateEnabled.addEventListener("change", saveDateFilter);
  if (dateStart) dateStart.addEventListener("change", () => {
    if ((dateStart.value || dateEnd?.value) && dateEnabled) dateEnabled.checked = true;
    saveDateFilter();
  });
  if (dateEnd) dateEnd.addEventListener("change", () => {
    if ((dateStart?.value || dateEnd.value) && dateEnabled) dateEnabled.checked = true;
    saveDateFilter();
  });
  shadowRoot.querySelectorAll("[data-date-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.datePreset;
      const now = new Date();
      if (preset === "clear") {
        settings.customDateFilterEnabled = false;
        settings.customDateFilterStart = "";
        settings.customDateFilterEnd = "";
      } else {
        let start = now;
        let end = new Date(now.getTime() + 24 * 3600000);
        if (preset === "today") {
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
          end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        }
        settings.customDateFilterEnabled = true;
        settings.customDateFilterStart = start.toISOString();
        settings.customDateFilterEnd = end.toISOString();
      }
      saveSettings();
      injectCards();
    });
  });
  const cancelPatBtn = shadowRoot.getElementById("rfx-cancel-pat-orders");
  if (cancelPatBtn) cancelPatBtn.addEventListener("click", cancelAllPatOrders);

  const timeBlockMode = shadowRoot.getElementById("rfx-time-block-mode");
  if (timeBlockMode) {
    timeBlockMode.addEventListener("change", () => {
      settings.bookedTimeBlockMode = timeBlockMode.value === "hide" ? "hide" : "warn";
      saveSettings();
      injectCards();
    });
  }
  const addTimeBlock = () => {
    const labelInput = shadowRoot.getElementById("rfx-time-block-label");
    const startInput = shadowRoot.getElementById("rfx-time-block-start");
    const endInput = shadowRoot.getElementById("rfx-time-block-end");
    const startIso = localDateTimeInputToIso(startInput?.value || "");
    const endIso = localDateTimeInputToIso(endInput?.value || "");
    const startMs = new Date(startIso || "").getTime();
    const endMs = new Date(endIso || "").getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      showToast("Add a valid start and end time block.");
      return;
    }
    if (endMs <= startMs) {
      showToast("Time block end must be after start.");
      return;
    }
    saveBookedTimeBlocks([
      ...getBookedTimeBlocks(),
      {
        id: `btb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: String(labelInput?.value || "").trim(),
        startIso,
        endIso,
        createdAt: new Date().toISOString(),
      },
    ]);
    injectCards();
    showToast("Booked time block added");
  };
  const addTimeBlockBtn = shadowRoot.getElementById("rfx-add-time-block");
  if (addTimeBlockBtn) addTimeBlockBtn.addEventListener("click", addTimeBlock);
  shadowRoot.querySelectorAll("[data-remove-time-block]").forEach(btn => {
    btn.addEventListener("click", () => {
      saveBookedTimeBlocks(getBookedTimeBlocks().filter(block => block.id !== btn.dataset.removeTimeBlock));
      injectCards();
      showToast("Booked time block removed");
    });
  });

  const addExcludedCity = () => {
    const input = shadowRoot.getElementById("rfx-excluded-city-input");
    const entry = canonicalizeExcludedCityInput(input?.value || "");
    if (!entry?.key) return;
    saveCustomExcludedCities([...getCustomExcludedCities(), entry]);
    injectCards();
  };
  const excludedInput = shadowRoot.getElementById("rfx-excluded-city-input");
  const addExcludedBtn = shadowRoot.getElementById("rfx-add-excluded-city");
  if (addExcludedBtn) addExcludedBtn.addEventListener("click", addExcludedCity);
  if (excludedInput) {
    excludedInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addExcludedCity();
      }
    });
  }
	  shadowRoot.querySelectorAll("[data-remove-city]").forEach(btn => {
	    btn.addEventListener("click", () => {
	      const key = btn.dataset.removeCity;
	      saveCustomExcludedCities(getCustomExcludedCities().filter(city => city.key !== key));
	      injectCards();
	    });
	  });
	  shadowRoot.querySelectorAll("[data-hide-load-id]").forEach(btn => {
	    btn.addEventListener("click", (e) => {
	      e.preventDefault();
	      e.stopPropagation();
	      ignoreLoad(btn.dataset.hideLoadId);
	    });
	  });
	  const clearHiddenLoadsBtn = shadowRoot.getElementById("rfx-clear-hidden-loads");
	  if (clearHiddenLoadsBtn) {
	    clearHiddenLoadsBtn.addEventListener("click", () => {
	      saveIgnoredLoadIds([]);
	      injectCards();
	      showToast("Hidden loads cleared");
	    });
	  }

  shadowRoot.querySelectorAll(".rfx-sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const sort = btn.dataset.sort;
      if (!sort) return;
      if (currentSort === sort) currentSortDir = currentSortDir === "asc" ? "desc" : "asc";
      else {
        currentSort = sort;
        currentSortDir = sort === "time" ? "asc" : "desc";
      }
      injectCards();
    });
  });

  shadowRoot.querySelectorAll(".rfx-book-btn[data-wo-id]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const woId = btn.dataset.woId;
      if (!woId || btn.disabled) return;
      if (btn.dataset.action === "fastbook") {
        bookLoadDirectFromSearch(woId);
        return;
      }
      armedFastBookLoads.add(woId);
      injectCards();
      showToast("Fastbook armed for this load. Click FASTBOOK to book.");
    });
  });

  shadowRoot.querySelectorAll(".rfx-pat-btn[data-pat-wo-id]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const woId = btn.dataset.patWoId;
      if (!woId || btn.disabled) return;
      openPatModal(woId);
    });
  });

  const patClose = shadowRoot.getElementById("rfx-pat-close");
  if (patClose) patClose.addEventListener("click", closePatModal);
  const patBackdrop = shadowRoot.getElementById("rfx-pat-backdrop");
  if (patBackdrop) {
    patBackdrop.addEventListener("click", (e) => {
      if (e.target === patBackdrop) closePatModal();
    });
  }
  const patForm = shadowRoot.getElementById("rfx-pat-form");
  if (patForm) {
    patForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitPatForm(patForm);
    });
  }

  updateLastRefresh();
  applyHideAmazonLoads();
}

// Style each Amazon load-card with our data
function styleAmazonLoadCards() {
  if (!amazonContainer) return;
  const loadCards = amazonContainer.querySelectorAll(".load-card");
  if (!loadCards.length) return;

  // Inject our stylesheet into the page if not already done
  if (!document.getElementById("rfx-inject-style")) {
    const style = document.createElement("style");
    style.id = "rfx-inject-style";
    style.textContent = `
      .load-card .rfx-injected { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .load-card .rfx-card-inner { padding: 12px 16px; }
      .load-card .rfx-card-body { display: flex; gap: 16px; }
      .load-card .rfx-card-left { flex: 1; min-width: 0; }
      .load-card .rfx-card-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; min-width: 130px; text-align: right; gap: 8px; }
      .load-card .rfx-i-payout { font-size: 22px; font-weight: 700; color: #067d62; line-height: 1.2; }
      .load-card .rfx-i-price-delta { font-size: 15px; font-weight: 800; line-height: 1; margin-bottom: 3px; }
      .load-card .rfx-i-price-delta.up { color: #067d62; }
      .load-card .rfx-i-price-delta.down { color: #cc3333; }
      .load-card .rfx-i-stat { font-size: 13px; color: #565959; margin-top: 2px; }
      .load-card .rfx-i-stat b { color: #0f1111; font-weight: 600; }
      .load-card .rfx-i-profit {
        display: inline-flex; align-items: center; justify-content: center;
        padding: 3px 8px; border-radius: 999px; background: #e6f7f2; color: #067d62;
        font-size: 12px; font-weight: 800; line-height: 1.25; white-space: nowrap; margin-top: 3px;
      }
      .load-card .rfx-i-profit.negative { background: #fdecea; color: #b12704; }
      .load-card .rfx-i-score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .load-card .rfx-i-score-bg { flex: 1; height: 5px; background: #e7e7e7; border-radius: 3px; overflow: hidden; max-width: 200px; }
      .load-card .rfx-i-score-fill { height: 100%; border-radius: 3px; }
      .load-card .rfx-i-score-label { font-size: 12px; font-weight: 700; min-width: 22px; }
      .load-card .rfx-i-score-tag { font-size: 11px; padding: 1px 8px; border-radius: 4px; font-weight: 600; }
      .load-card .rfx-i-stop { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 4px; }
      .load-card .rfx-i-stop-dot { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0; }
      .load-card .rfx-i-stop-dot.pickup { background: #2563eb; }
      .load-card .rfx-i-stop-dot.dropoff { background: #7c3aed; }
      .load-card .rfx-i-stop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .load-card .rfx-i-stop-name { font-size: 14px; font-weight: 600; color: #0f1111; }
      .load-card .rfx-i-stop-datetime { font-size: 13px; color: #565959; white-space: nowrap; font-weight: 500; display: inline-flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .load-card .rfx-i-stop-addr { font-size: 12px; color: #888; }
      .load-card .rfx-i-stop-meta { display: flex; gap: 6px; align-items: center; margin-top: 2px; flex-wrap: wrap; }
      .load-card .rfx-i-stop-time { font-size: 13px; color: #565959; }
      .load-card .rfx-i-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
      .load-card .rfx-i-badge.preloaded { background: #e6f7f2; color: #067d62; }
      .load-card .rfx-i-badge.live { background: #fef3cd; color: #856404; }
      .load-card .rfx-i-badge.drop { background: #e8f0fe; color: #1a56db; }
      .load-card .rfx-i-extra { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #f3f4f6; color: #374151; font-weight: 500; }
      .load-card .rfx-i-flex-window { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #fff4d6; color: #8a4b00; font-weight: 800; }
      .load-card .rfx-i-timing-risk { font-size: 11px; padding: 3px 7px; border-radius: 6px; font-weight: 800; display: inline-flex; align-items: center; gap: 4px; }
      .load-card .rfx-i-timing-risk.warn { background:#fff8e1; color:#8a5a00; border:1px solid #f3d27a; }
      .load-card .rfx-i-timing-risk.bad { background:#fdecea; color:#b12704; border:1px solid #f1b8b0; }
      .load-card .rfx-i-stem-risk { font-size: 11px; padding: 3px 7px; border-radius: 6px; font-weight: 800; display: inline-flex; align-items: center; gap: 4px; background:#fdecea; color:#b12704; border:1px solid #f1b8b0; }
      .load-card .rfx-i-leg { font-size: 12px; color: #888; padding: 2px 0 4px 32px; }
      .load-card .rfx-i-footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 8px; margin-top: 6px; border-top: 1px solid #f0f0f0; font-size: 13px; color: #565959; }
      .load-card .rfx-i-footer b { color: #0f1111; }
      .load-card .rfx-i-version { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
      .load-card .rfx-i-version.ok { background: #f0f0f0; color: #565959; }
      .load-card .rfx-i-version.bad { background: #fdecea; color: #cc3333; }
	      .load-card .rfx-i-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
	      .load-card .rfx-i-left-actions { display: flex; align-items: center; gap: 8px; margin: 0 0 8px 32px; }
	      .load-card .rfx-i-book { padding: 8px 20px; font-size: 14px; font-weight: 600; background: #ff9900; color: #0f1111; border: none; border-radius: 8px; cursor: pointer; font-family: inherit; }
	      .load-card .rfx-i-book:hover { background: #e88b00; }
	      .load-card .rfx-i-pat { padding: 7px 12px; font-size: 12px; font-weight: 800; background: #0b7285; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: inherit; }
	      .load-card .rfx-i-pat:hover { background: #075965; }
	      .load-card .rfx-i-pat:disabled { opacity: 0.65; cursor: default; }
	      .load-card .rfx-i-pat.done { background: #067d62; }
	      .load-card .rfx-i-hide { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border: 1px solid #d5d9d9; border-radius: 50%; background: #fff; color: #565959; font-size: 15px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2; }
	      .load-card .rfx-i-hide:hover { background: #fdecea; border-color: #cc3333; color: #cc3333; }
	      .load-card.rfx-styled { border: 1px solid #d5d9d9; border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
	      .load-card.rfx-styled .wo-tag { display: none; }
	      .load-card.rfx-load-ignored { display: none !important; }
	      .load-card.rfx-new-detected { background: #fff5e0 !important; border: 2px solid #ff9900 !important; box-shadow: 0 0 12px rgba(255,153,0,0.3); }
      @media (max-width: 640px) {
        .load-card .rfx-card-body { flex-direction: column; gap: 6px; }
        .load-card .rfx-card-right { flex-direction: row; align-items: center; gap: 10px; min-width: 0; text-align: left; flex-wrap: wrap; border-top: 1px solid #f0f0f0; padding-top: 8px; }
        .load-card .rfx-i-payout { font-size: 20px; }
        .load-card .rfx-i-book { min-height: 44px; }
        .load-card .rfx-i-actions { flex-direction: row; align-items: center; }
      }
    `;
    document.head.appendChild(style);
  }

  // Build maps for quick lookup
  const loadMap = new Map();
  for (const wo of allLoads) loadMap.set(wo.id, wo);
  const alertedIds = new Map();
  for (const a of alertedLoads) alertedIds.set(a.wo.id, a);

  let matchCount = 0, noIdCount = 0, noDataCount = 0;

  loadCards.forEach(card => {
    // Extract the workOpportunity ID — it's on a child div inside load-card
    let woId = null;

    // Strategy 1: Find child div with UUID-like ID
    const allDivs = card.querySelectorAll("div[id]");
    for (const div of allDivs) {
      if (div.id && div.id.length > 20 && div.id !== "PAST_BOOK" && div.id.includes("-")) {
        woId = div.id;
        break;
      }
    }

    // Strategy 2: Check parent
    if (!woId) {
      const parent = card.parentElement;
      if (parent?.id && parent.id.length > 20 && parent.id.includes("-")) woId = parent.id;
    }

    if (!woId) {
      card.classList.add("rfx-no-match");
      hideUnmatchedLoadCard(card);
      noIdCount++;
      return;
    }

	    const wo = loadMap.get(woId);
	    if (!wo) {
	      card.classList.add("rfx-no-match");
	      hideUnmatchedLoadCard(card);
	      noDataCount++;
	      return;
	    }
	    if (isIgnoredLoad(woId)) {
	      card.classList.add("rfx-load-ignored");
	      return;
	    }
	    if (!passesDetectionDisplayRules(wo)) {
	      card.classList.add("rfx-no-match");
	      hideUnmatchedLoadCard(card);
	      return;
	    }
	    card.classList.remove("rfx-load-ignored");
	    card.classList.remove("rfx-no-match");
    restoreUnmatchedLoadCard(card);
    matchCount++;
    const bState = bookingState.get(woId) || "idle";
    const displaySig = getDisplaySettingsSignature();

    // Skip if already styled with same version
    if (card.classList.contains("rfx-styled") && card.dataset.rfxVer === String(wo.version) && card.dataset.rfxBookState === bState && card.dataset.rfxDisplaySig === displaySig) {
      // Still check if this card needs alert highlighting
      const alert = alertedIds.get(woId);
      if (alert && !card.classList.contains("rfx-new-detected")) {
        card.classList.add("rfx-new-detected");
      } else if (!alert && card.classList.contains("rfx-new-detected")) {
        card.classList.remove("rfx-new-detected");
      }
      return;
    }

    // Mark as styled
    card.classList.add("rfx-styled");
    card.dataset.rfxVer = String(wo.version);
    card.dataset.rfxBookState = bState;
    card.dataset.rfxDisplaySig = displaySig;

    const ver = wo.version || 1;

    // Check if this is an alerted (new/changed) load
    const alert = alertedIds.get(woId);
    if (alert) card.classList.add("rfx-new-detected");
    else card.classList.remove("rfx-new-detected");

    // Hide ALL original content inside the load-card
    for (const child of card.children) {
      if (!child.classList.contains("rfx-injected")) {
        child.style.display = "none";
      }
    }

    // Remove any previous injection
    const oldInject = card.querySelector(".rfx-injected");
    if (oldInject) oldInject.remove();

    // Build our content
    const pay = wo.payout?.value || 0;
    const dist = wo.totalDistance?.value || 0;
    const durMs = wo.totalDuration || 0;
    const durH = durMs / 3600000;
    const perHr = durH > 0 ? pay / durH : 0;
    const perMi = dist > 0 ? pay / dist : 0;
    const score = scoreLoad(wo);
    const sc = scoreColor(score);
    const stops = getAllStops(wo);
    const driver = wo.transitOperatorType === "TEAM_DRIVER" ? "Team" : "Solo";
    const firstTz = stops[0]?.location?.timeZone || "America/Los_Angeles";
    const timingRisk = settings.showTimingRisk ? getTimingRisk(wo) : null;
    const stemWarning = getStemTimeWarning(wo);
    const flexibleArrival = settings.showFlexibleArrivalWindow
      ? getFlexibleArrivalWindow(wo, firstTz)
      : null;

    let vBadge = "";
    if (settings.showVersionBadge) {
      if (ver > 3) vBadge = `<span class="rfx-i-version bad">v${ver} ⚠</span>`;
      else if (ver > 1) vBadge = `<span class="rfx-i-version ok">v${ver}</span>`;
    }
    const firstStopDetails = [
      settings.showDriverType ? driver : "",
      settings.showEquipment ? "53' Trailer" : "",
      settings.showLoadTypeBadge && hasPreloadedStop(wo) ? "Preloaded" : "",
    ].filter(Boolean).map(v => `<span>${v}</span>`).join("");

    // Stops HTML
    let stopsHtml = "";
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i], loc = s.location || {};
      const dotCls = s.stopType === "PICKUP" ? "pickup" : "dropoff";
      const checkin = s.actions?.find(a => a.type === "CHECKIN")?.plannedTime;
      const checkout = s.actions?.find(a => a.type === "CHECKOUT")?.plannedTime;
      const tz = loc.timeZone || firstTz;
      let dwell = "";
      if (checkin && checkout) { const d = new Date(checkout) - new Date(checkin); if (d > 0) dwell = fmtDur(d); }
      const loadTypes = getPickupLoadTypesForStop(wo, s);
      const cityState = `${loc.city || "?"}, ${loc.state || "?"}`;
      const stopLabel = loc.label || loc.stopCode || "";
      const stopName = settings.showStopCode && stopLabel ? `${stopLabel} · ${cityState}` : cityState;
      const stopDateTime = fmtStopTimeWindow(checkin, checkout, tz);
      const extraMeta = settings.showExtraStopMeta ? [
        ...loadTypes.map(v => `<span class="rfx-i-extra">${v}</span>`),
      ].filter(Boolean).join("") : "";

      stopsHtml += `<div class="rfx-i-stop">
        <div class="rfx-i-stop-dot ${dotCls}">${i + 1}</div>
        <div>
          <div class="rfx-i-stop-head">
            <div class="rfx-i-stop-name">${stopName}</div>
            ${stopDateTime ? `<span class="rfx-i-stop-datetime">${stopDateTime}${i === 0 && firstStopDetails ? ` ${firstStopDetails}` : ""}</span>` : ""}
          </div>
          ${settings.showStopAddress ? `<div class="rfx-i-stop-addr">${[loc.line1, loc.line2].filter(Boolean).join(", ")}</div>` : ""}
          <div class="rfx-i-stop-meta">
            ${i === 0 && flexibleArrival ? `<span class="rfx-i-flex-window" title="${escapeHtml(flexibleArrival.duration)} editable pickup window">${escapeHtml(flexibleArrival.label)}</span>` : ""}
            ${dwell && settings.showDwellTime ? `<span style="font-size:12px;color:#888">${dwell}</span>` : ""}
            ${extraMeta}
          </div>
        </div>
      </div>`;
      if (i < stops.length - 1 && settings.showLegDistance && loc.latitude && loc.longitude) {
        const nL = stops[i + 1]?.location;
        if (nL?.latitude && nL?.longitude) {
          const ld = (haversine(loc.latitude, loc.longitude, nL.latitude, nL.longitude) * 1.25).toFixed(1);
          stopsHtml += `<div class="rfx-i-leg">↓ ~${ld} mi</div>`;
        }
      }
    }

    // Stats
    const priceDeltaText = alert?.priceDelta ? formatPriceDelta(alert.priceDelta) : "";
    const priceDeltaClass = alert?.priceDelta > 0 ? "up" : "down";
    let statsHtml = `${priceDeltaText ? `<div class="rfx-i-price-delta ${priceDeltaClass}">${priceDeltaText}</div>` : ""}<span class="rfx-i-payout">${fmt$(pay)}</span>`;
    if (settings.showPerHr) statsHtml += `<div class="rfx-i-stat"><b>${fmt$(perHr)}</b>/hr</div>`;
    if (settings.showPerMi) statsHtml += `<div class="rfx-i-stat"><b>${fmt$(perMi)}</b>/mi</div>`;
    const fuelProfit = settings.showProfitEstimate ? calcFuelProfit(wo) : null;
    if (fuelProfit) {
      const title = `Fuel-only estimate: ${fuelProfit.totalMiles.toFixed(1)} total mi / ${fuelProfit.mpg.toFixed(1)} MPG × ${fmt$(fuelProfit.fuelPrice)} = ${fmt$(fuelProfit.fuelCost)} fuel`;
      statsHtml += `<div class="rfx-i-profit ${fuelProfit.profit < 0 ? "negative" : ""}" title="${escapeHtml(title)}">${fmt$(fuelProfit.profit)} / ${fmt$(fuelProfit.fuelCost)}</div>`;
    }
    const distDur = [];
    if (settings.showDistance) distDur.push(`<b>${dist.toFixed(1)}</b> mi`);
    if (settings.showDuration) distDur.push(`<b>${fmtDur(durMs)}</b>`);
    if (distDur.length) statsHtml += `<div class="rfx-i-stat">${distDur.join(" · ")}</div>`;
    statsHtml += vBadge;

    // Footer
    let footer = "";
    const postedAge = fmtAge(wo.createdAtTime);
    if (settings.showPostedAge && postedAge) footer += `<span>${postedAge}</span>`;
    if (settings.showStopCount) footer += ` <span>${wo.stopCount || stops.length} stops</span>`;
    if (timingRisk) footer += ` <span class="rfx-i-timing-risk ${timingRisk.level}" title="${escapeHtml(timingRisk.detail)}">Timing issue · ${escapeHtml(timingRisk.label)}</span>`;
    if (stemWarning) footer += ` <span class="rfx-i-stem-risk" title="${escapeHtml(stemWarning.detail)}">Stand warning · ${escapeHtml(stemWarning.label)}</span>`;

    const armedForFastBook = settings.fastBook || armedFastBookLoads.has(woId);

    // BOOK arms one load; FASTBOOK sends the direct booking request for that load.
    const bookBtn = (
      bState === "confirmed"
        ? `<button class="rfx-i-book" style="background:#067d62;color:#fff;cursor:default" disabled>Booked</button>`
        : bState === "pending"
          ? `<button class="rfx-i-book" style="background:#b8860b;color:#fff;cursor:default" disabled>Booking...</button>`
          : `<button class="rfx-i-book" data-wo-id="${woId}" data-action="${armedForFastBook ? "fastbook" : "arm"}">${armedForFastBook ? (bState === "failed" ? "RETRY FASTBOOK" : "FASTBOOK") : "BOOK"}</button>`
    );
    const patBtn = settings.patEnabled
      ? (() => {
          const pState = patState.get(woId) || "idle";
          if (pState === "posted") return `<button type="button" class="rfx-i-pat done" data-pat-wo-id="${woId}" disabled>PAT Posted</button>`;
          if (pState === "posting") return `<button type="button" class="rfx-i-pat" data-pat-wo-id="${woId}" disabled>Posting...</button>`;
          return `<button type="button" class="rfx-i-pat" data-pat-wo-id="${woId}">Post A Truck</button>`;
        })()
      : "";

    // Alert badge if this is a new/changed load
    let alertBadge = "";
    if (alert && !priceDeltaText) {
      const badgeCls = alert.badgeClass || "badge-new";
      alertBadge = `<span class="rfx-i-badge" style="background:${badgeCls === "badge-new" || badgeCls === "badge-price-up" ? "#067d62" : badgeCls === "badge-price-down" || badgeCls === "badge-autobook" ? "#cc3333" : badgeCls === "badge-time" ? "#b8860b" : "#565959"};color:#fff;margin-bottom:8px;display:inline-block;">${alert.badge}</span>`;
    }

    const inject = document.createElement("div");
    inject.className = "rfx-injected";
	    inject.innerHTML = `<div class="rfx-card-inner">
	      <button type="button" class="rfx-i-hide" data-hide-load-id="${woId}" title="Hide this load">×</button>
	      ${alertBadge}
      ${settings.showScoreBar ? `<div class="rfx-i-score-row">
        <div class="rfx-i-score-bg"><div class="rfx-i-score-fill" style="width:${score}%;background:${sc}"></div></div>
        <span class="rfx-i-score-label" style="color:${sc}">${score}</span>
        <span class="rfx-i-score-tag" style="background:${scoreBg(score)};color:${sc}">${score >= 70 ? "Great" : score >= 40 ? "OK" : "Low"}</span>
      </div>` : ""}
      <div class="rfx-card-body">
        <div class="rfx-card-left">${patBtn ? `<div class="rfx-i-left-actions">${patBtn}</div>` : ""}${stopsHtml}${footer ? `<div class="rfx-i-footer">${footer}</div>` : ""}</div>
        <div class="rfx-card-right"><div>${statsHtml}</div><div class="rfx-i-actions">${bookBtn}</div></div>
      </div>
    </div>`;

    card.appendChild(inject);

    // Bind BOOK button. First click arms the load; second click books directly.
    const btn = inject.querySelector(".rfx-i-book");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (btn.dataset.action === "fastbook") {
          bookLoadDirectFromSearch(woId);
        } else {
          armedFastBookLoads.add(woId);
          styleAmazonLoadCards();
          showToast("Fastbook armed for this load. Click FASTBOOK to book.");
        }
      });
    }

    const patBtnEl = inject.querySelector(".rfx-i-pat[data-pat-wo-id]");
    if (patBtnEl) {
      patBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!patBtnEl.disabled) openPatModal(patBtnEl.dataset.patWoId);
      });
    }

    const hideBtn = inject.querySelector("[data-hide-load-id]");
    if (hideBtn) {
      hideBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        ignoreLoad(hideBtn.dataset.hideLoadId);
      });
    }
  });

  if (matchCount === 0 && loadCards.length > 0) {
    const domIds = [];
    loadCards.forEach(card => {
      card.querySelectorAll("div[id]").forEach(d => {
        if (d.id.length > 10 && d.id !== "PAST_BOOK") domIds.push(d.id.substring(0, 15));
      });
    });
    const dataIds = Array.from(loadMap.keys()).slice(0, 5).map(id => id.substring(0, 15));
  }

  // Move alerted (new/changed) load cards to the top of the list
  if (alertedLoads.length > 0 && amazonContainer) {
    const alertedCards = amazonContainer.querySelectorAll(".load-card.rfx-new-detected");
    // Insert in reverse order so first alerted card ends up on top
    for (let i = alertedCards.length - 1; i >= 0; i--) {
      const card = alertedCards[i];
      const parent = card.parentElement; // The div wrapping the load-card
      if (parent && parent.parentElement === amazonContainer) {
        amazonContainer.insertBefore(parent, amazonContainer.firstChild);
      } else if (card.parentElement === amazonContainer) {
        amazonContainer.insertBefore(card, amazonContainer.firstChild);
      }
    }
  }

  hideNonLoadCardAmazonRows();
}

function getLoadCardShell(card) {
  const parent = card.parentElement;
  return parent && amazonContainer && parent.parentElement === amazonContainer ? parent : card;
}

function hideUnmatchedLoadCard(card) {
  const shell = getLoadCardShell(card);
  if (!shell.dataset.rfxPrevDisplay) shell.dataset.rfxPrevDisplay = shell.style.display || "__empty__";
  shell.dataset.rfxNoMatchHidden = "1";
  shell.style.display = "none";
}

function restoreUnmatchedLoadCard(card) {
  const shell = getLoadCardShell(card);
  if (shell.dataset.rfxNoMatchHidden === "1") {
    shell.style.display = shell.dataset.rfxPrevDisplay === "__empty__" ? "" : shell.dataset.rfxPrevDisplay || "";
    delete shell.dataset.rfxNoMatchHidden;
    delete shell.dataset.rfxPrevDisplay;
  }
}

function hideNonLoadCardAmazonRows() {
  if (!amazonContainer || !aiModeActive) return;
  for (const child of Array.from(amazonContainer.children)) {
    if (child.id === "rfx-host" || child.closest("#rfx-host")) continue;
    if (child.classList.contains("load-card") || child.querySelector(".load-card")) {
      restoreHiddenAmazonRow(child);
      continue;
    }

    const text = child.textContent || "";
    const looksLikeAmazonLoadRow = /\$\s*\d[\d,]*\.\d{2}/.test(text) && /\bmi\b/i.test(text);
    if (!looksLikeAmazonLoadRow) {
      restoreHiddenAmazonRow(child);
      continue;
    }

    if (!child.dataset.rfxPrevDisplay) child.dataset.rfxPrevDisplay = child.style.display || "__empty__";
    child.dataset.rfxHiddenNonLoad = "1";
    child.style.display = "none";
  }
}

function restoreHiddenAmazonRow(el) {
  if (el?.dataset?.rfxHiddenNonLoad === "1") {
    el.style.display = el.dataset.rfxPrevDisplay === "__empty__" ? "" : el.dataset.rfxPrevDisplay || "";
    delete el.dataset.rfxHiddenNonLoad;
    delete el.dataset.rfxPrevDisplay;
  }
}

function updateLastRefresh() {
  if (!shadowRoot) return;
  const el = shadowRoot.getElementById("rfx-last-refresh");
  if (!el) return;
  if (lastPollTime) {
    const ago = Math.round((Date.now() - lastPollTime) / 1000);
    el.textContent = `Last refreshed: ${ago}s ago`;
  } else {
    el.textContent = "";
  }
}

// Update the "last refreshed" display every second
setInterval(updateLastRefresh, 1000);

function applyHideAmazonLoads() {
  if (!aiModeActive) return;

  // The custom board is rendered from API data, so Amazon's native rows stay hidden in AI mode.
  const loadList = document.querySelector(".load-list");
  if (loadList) loadList.style.display = "none";

  // Hide Amazon's filter tag strip; our custom board already renders the useful controls.
  const filterTagsPanel = document.getElementById("search-results-summary__filter-tags-panel");
  if (filterTagsPanel) {
    if (!filterTagsPanel.dataset.rfxPreviousDisplay) {
      filterTagsPanel.dataset.rfxPreviousDisplay = filterTagsPanel.style.display || "";
    }
    filterTagsPanel.dataset.rfxHiddenFilterTagsPanel = "1";
    filterTagsPanel.style.display = "none";
  }

  // Hide Amazon's empty state elements individually — never hide parent containers
  if (ourHost) {
    document.querySelectorAll("h1, h2, h3, h4, p, img, svg, a").forEach(el => {
      if (el.closest("#rfx-host")) return;
      const t = el.textContent || "";
      // Hide "There are no matches" heading
      if (/there are no matches/i.test(t) && t.length < 50) el.style.display = "none";
      // Hide "Build on the above filters..." text
      if (/build on the above filters/i.test(t)) el.style.display = "none";
      // Hide "Create Post a Truck Order" link
      if (/create post a truck order/i.test(t)) el.style.display = "none";
    });
    // Hide the truck illustration (it's an img or an svg inside a div near "no matches")
    document.querySelectorAll("img, [role='img']").forEach(el => {
      if (el.closest("#rfx-host")) return;
      if (el.closest(".chat-box-position")) return;
      if (el.closest("button, [role='button'], a")) return;
      const src = el.src || el.getAttribute("src") || "";
      const alt = el.alt || el.getAttribute("alt") || "";
      if (/truck|no.?match|empty/i.test(src) || /truck|no.?match|empty/i.test(alt)) {
        el.style.display = "none";
      }
    });
    // Hide pagination only — keep the summary panel (it contains the filter button + tags)
    const pagination = document.querySelector(".pagination-bar");
    if (pagination) pagination.style.display = "none";
  }
}

function removeOurCards() {
  const loadList = document.querySelector(".load-list");
  if (loadList) loadList.style.display = "";
  document.querySelectorAll("[data-rfx-hidden-filter-tags-panel='1']").forEach(el => {
    el.style.display = el.dataset.rfxPreviousDisplay || "";
    delete el.dataset.rfxPreviousDisplay;
    delete el.dataset.rfxHiddenFilterTagsPanel;
  });

  // Restore Amazon's load cards to original state
  document.querySelectorAll(".load-card.rfx-styled, .load-card.rfx-no-match").forEach(card => {
    restoreUnmatchedLoadCard(card);
    card.classList.remove("rfx-styled", "rfx-new-detected", "rfx-no-match", "rfx-load-ignored");
    delete card.dataset.rfxVer;
    const inject = card.querySelector(".rfx-injected");
    if (inject) inject.remove();
    // Restore all hidden children
    for (const child of card.children) {
      child.style.display = "";
    }
  });
  document.querySelectorAll("[data-rfx-hidden-non-load='1']").forEach(restoreHiddenAmazonRow);

  // Remove injected stylesheet
  const style = document.getElementById("rfx-inject-style");
  if (style) style.remove();

  if (ourHost) { ourHost.remove(); ourHost = null; shadowRoot = null; }
  amazonContainer = null;
}

function refreshStyledCards() {
  injectCards();
}

function toggleAiMode() {
  if (!isLoadBoardPage()) return;
  aiModeActive = !aiModeActive;
  const backBtnWrap = document.getElementById("rfx-back-btn");
  if (aiModeActive) {
    if (backBtnWrap) backBtnWrap.style.display = "none";
    injectCards();
  } else {
    removeOurCards();
    // Insert the "AI Loads" button where the load list is
    if (backBtnWrap) {
      const loadList = document.querySelector(".load-list");
      if (loadList) {
        loadList.parentElement.insertBefore(backBtnWrap, loadList);
      } else {
        const activeTab = document.getElementById("active-tab-body");
        if (activeTab) activeTab.prepend(backBtnWrap);
      }
      backBtnWrap.style.display = "block";
    }
  }
}

// ============================================================
// BOT CONTROL
// ============================================================
async function startBot(options = {}) {
  if (botRunning || botStarting) return;
  cancelAutoResume();
  if (botStartWatchdog) {
    clearTimeout(botStartWatchdog);
    botStartWatchdog = null;
  }

  // Auto-book is simulation-only and can start only from the user's Start button.
  if (settings.autoBook && !options.skipAutoBookConfirm) {
    const confirmed = window.confirm(
      "AUTO-BOOK SIMULATOR\n\n" +
      "No load will be clicked or booked.\n\n" +
      "All loads currently on screen will become the baseline. Only a new qualifying load detected afterward can be selected.\n\n" +
      "The simulator will choose the highest payout and stop after one candidate.\n\n" +
      "Start monitoring?"
    );
    if (!confirmed) return;
  }

  if (settings.autoBook) {
    settings.autoResume = false;
    autoBookCandidate = null;
    autoBookAwaitingBaseline = true;
    seenLoads.clear();
    missingCounts.clear();
    recentlyMissingLoads.clear();
    goneLoads.clear();
    alertedLoads = [];
    isFirstPoll = true;
    saveSettings();
  }

  botStarting = true;
  if (aiModeActive) injectCards();
  botStartWatchdog = setTimeout(() => {
    if (!botStarting) return;
    console.warn("[Bot] Startup watchdog recovered from stuck Starting state.");
    botStarting = false;
    botRunning = true;
    isFirstPoll = settings.autoBook ? true : seenLoads.size === 0;
    doPoll();
    scheduleNext();
    if (aiModeActive) injectCards();
  }, 8000);

  try {
    try {
      await forceAmazonRefresh();
    } catch (err) {
      console.warn("[Bot] Amazon refresh before start failed:", err);
    }

    ensureAudioCtx();
    if (alertedLoads.length > 0) {
      alertedLoads = [];
    }
    missingCounts.clear();
    goneLoads.clear();
    document.querySelectorAll(".load-card.rfx-new-detected").forEach(card => card.classList.remove("rfx-new-detected"));
    botRunning = true;
    isFirstPoll = settings.autoBook ? true : seenLoads.size === 0;
    try { chrome.runtime.sendMessage({ action: "botStarted" }).catch(() => {}); } catch {}
    doPoll(); // immediate first poll
    scheduleNext();
  } catch (err) {
    console.error("[Bot] Start failed:", err);
    botRunning = false;
    autoBookAwaitingBaseline = false;
  } finally {
    botStarting = false;
    if (botStartWatchdog) {
      clearTimeout(botStartWatchdog);
      botStartWatchdog = null;
    }
    if (aiModeActive) injectCards();
  }
}

function cancelAutoResume() {
  if (autoResumeTimer) {
    clearTimeout(autoResumeTimer);
    autoResumeTimer = null;
  }
}

function scheduleAutoResume(reason = "stopped") {
  cancelAutoResume();
  if (settings.autoBook || !settings.autoResume || botRunning || botStarting) return;
  autoResumeTimer = setTimeout(() => {
    autoResumeTimer = null;
    if (settings.autoBook || !settings.autoResume || botRunning || botStarting) return;
    startBot({ skipAutoBookConfirm: true });
  }, 5000);
}

function stopBot(options = {}) {
  botStarting = false;
  botRunning = false;
  autoBookAwaitingBaseline = false;
  if (botStartWatchdog) { clearTimeout(botStartWatchdog); botStartWatchdog = null; }
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  try { chrome.runtime.sendMessage({ action: "botStopped" }).catch(() => {}); } catch {}
  if (aiModeActive) injectCards();
  if (!settings.autoBook && options.allowAutoResume !== false) scheduleAutoResume(options.reason || "stop");
}

function resetBot() {
  stopBot({ allowAutoResume: false });
  cancelAutoResume();
  seenLoads.clear();
  missingCounts.clear();
  recentlyMissingLoads.clear();
  alertedLoads = [];
  goneLoads.clear();
  autoBookAwaitingBaseline = false;
  autoBookCandidate = null;
  isFirstPoll = true;
  lastPollTime = null;
  if (aiModeActive) injectCards();
}

function resumeBot() {
  // Move alerted loads into regular list
  cancelAutoResume();
  alertedLoads = [];
  startBot();
}

function scheduleNext() {
  if (!botRunning) return;
  const minMs = settings.pollMinSeconds * 1000;
  const maxMs = settings.pollMaxSeconds * 1000;
  const delay = minMs + Math.random() * (maxMs - minMs);
  botTimer = setTimeout(() => {
    if (!botRunning) return;
    doPoll();
    scheduleNext();
  }, delay);
}

function handleDetectedAlerts(alerts, sourceLabel = "Bot") {
  if (!alerts.length) return false;

  const newLoads = alerts.filter(a => a.badge === "NEW");

  if (settings.autoBook) {
    const selected = selectAutoBookCandidate(newLoads);
    if (!selected) return false;

    const wo = selected.alert.wo;
    autoBookCandidate = {
      woId: wo.id,
      payout: selected.evaluation.payout,
      pickupMs: selected.evaluation.pickupMs,
      standMinutes: selected.evaluation.standMinutes,
      selectedAt: Date.now(),
      source: sourceLabel,
    };
    alertedLoads = [{ ...selected.alert, badge: "WOULD BOOK", badgeClass: "badge-autobook" }];
    botStarting = false;
    botRunning = false;
    autoBookAwaitingBaseline = false;
    cancelAutoResume();
    if (botStartWatchdog) { clearTimeout(botStartWatchdog); botStartWatchdog = null; }
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    try { chrome.runtime.sendMessage({ action: "botStopped" }).catch(() => {}); } catch {}
    playAlert();
    if (aiModeActive) injectCards();
    return true;
  }

  botRunning = false;
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  alertedLoads.push(...alerts);
  playAlert();
  if (aiModeActive) injectCards();
  scheduleAutoResume("new load detected");

  return true;
}

function doPoll() {
  lastPollTime = Date.now();

  const fallback = {
    workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP", "HOSTLER_SHUTTLE"],
    originCity: null, liveCity: null,
    originCities: [{ displayValue: "TRACY, CA", stateCode: "CA", isCityLive: false, latitude: 37.724328, longitude: -121.444622, name: "TRACY" }],
    startCityName: null, startCityStateCode: null, startCityLatitude: null, startCityLongitude: null, startCityDisplayValue: null,
    isOriginCityLive: null, startCityRadius: 50, destinationCity: null,
    originCitiesRadiusFilters: [{ cityLatitude: 37.724328, cityLongitude: -121.444622, cityName: "TRACY", cityStateCode: "CA", cityDisplayValue: "TRACY, CA", radius: 50 }],
    destinationCitiesRadiusFilters: [], exclusionCitiesFilter: null, endCityName: null, endCityStateCode: null, endCityDisplayValue: null,
    endCityLatitude: null, endCityLongitude: null, isDestinationCityLive: null, endCityRadius: 5, startDate: null, endDate: null,
    minDistance: null, maxDistance: null, minimumDurationInMillis: null, maximumDurationInMillis: null, minPayout: null, minPricePerDistance: null,
    driverTypeFilters: ["SINGLE_DRIVER", "TEAM_DRIVER"], uiiaCertificationsFilter: [], workOpportunityOperatingRegionFilter: [],
    loadingTypeFilters: ["LIVE", "DROP"], maximumNumberOfStops: 3, workOpportunityAccessType: null,
    sortByField: "relevanceForSearchTab", sortOrder: "asc", visibilityStatusType: "ALL",
    categorizedEquipmentTypeList: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "SKIRTED_FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_DRY_VAN", "FIFTY_THREE_FOOT_A5_AIR_TRAILER", "FORTY_FIVE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
    categorizedEquipmentTypeListForFilterPills: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
    nextItemToken: 0, resultSize: 50, searchURL: "", isAutoRefreshCall: false, notificationId: "",
    auditContextMap: JSON.stringify({ rlbChannel: "EXACT_MATCH", isOriginCityLive: "false", isDestinationCityLive: "false", userAgent: navigator.userAgent, source: "AVAILABLE_WORK" }),
  };

  window.dispatchEvent(new CustomEvent("relay-fetcher-poll", { detail: JSON.stringify({ payload: fallback }) }));
}

// Handle poll results
window.addEventListener("relay-fetcher-poll-result", (e) => {
  try {
    const { status, data, error, seq } = JSON.parse(e.detail);
    const pollSeq = Number(seq);
    if (Number.isFinite(pollSeq) && pollSeq < latestAutoSearchSeq) return;
    if (!botRunning && !botStarting) return;

    if (error || data?.errorCode) {
      const msg = error || data?.defaultErrorMessage || "";
      if (msg.includes("CSRF") || msg.includes("csrf") || status === 401) {
        stopBot({ allowAutoResume: false });
        console.error("[Bot] Session expired:", msg);
        // Show error in UI
        if (shadowRoot) {
          const dot = shadowRoot.querySelector(".rfx-dot");
          const txt = shadowRoot.querySelector(".rfx-status-text");
          if (dot) { dot.className = "rfx-dot red"; }
          if (txt) { txt.innerHTML = "<b style='color:#cc3333'>Session expired — please refresh the page</b>"; }
        }
        return;
      }
      console.warn("[Bot] Poll error:", msg);
      return;
    }

    const rawLoads = data?.workOpportunities || [];
    const loads = filterCustomExcludedLoads(rawLoads);
    carrierDetails = data?.carrierDetails || carrierDetails;
    currentSearchAuditId = data?.searchAuditId || currentSearchAuditId;

    // The first poll after a manual auto-booker start is baseline-only. Every load in
    // this response is treated as pre-existing and can never become a candidate.
    if (settings.autoBook && autoBookAwaitingBaseline) {
      autoBookAwaitingBaseline = false;
      pendingPartialSearchSignature = "";
      allLoads = dedupeLoads(loads);
      alertedLoads = [];
      missingCounts.clear();
      recentlyMissingLoads.clear();
      goneLoads.clear();
      seedSeenLoads(allLoads);
      isFirstPoll = false;
      if (loads.length > 0) lastNonEmptySearchAt = Date.now();
      processLookoutAlerts(allLoads, "auto-book-baseline");
      if (aiModeActive) injectCards();
      return;
    }

    // If a filter change has only delivered Amazon's first page so far, this full bot
    // poll completes the new baseline. Do not classify later pages as newly found loads.
    if (pendingPartialSearchSignature) {
      pendingPartialSearchSignature = "";
      allLoads = dedupeLoads(loads);
      alertedLoads = [];
      missingCounts.clear();
      recentlyMissingLoads.clear();
      goneLoads.clear();
      seedSeenLoads(allLoads);
      isFirstPoll = allLoads.length === 0;
      if (loads.length > 0) lastNonEmptySearchAt = Date.now();
      processLookoutAlerts(allLoads, "bot-filter-change-complete");
      if (aiModeActive) injectCards();
      return;
    }

    if (loads.length === 0 && shouldIgnoreEmptySearchResult("Bot:Poll")) {
      if (aiModeActive) injectCards();
      return;
    }
    if (loads.length > 0) lastNonEmptySearchAt = Date.now();

    const wasFirstPoll = isFirstPoll;

    // Run detection even on 0 loads (handles first-poll seeding and disappearances)
    const alerts = detectChanges(loads);

    allLoads = dedupeLoads(loads);
    processLookoutAlerts(allLoads, "bot-poll");

    if (alerts.length > 0) {
      handleDetectedAlerts(alerts, "Bot:Poll");
    } else {
    }

    if (aiModeActive) injectCards();
  } catch (err) {
    console.error("[Bot] Poll result error:", err);
  }
});

// ============================================================
// NEGOTIATION
// ============================================================
function playNegotiationSound() {
  // Disabled — no sound on negotiation complete
  try {
  } catch (e) {}
}

function startNegotiation(woId, version, majorVersion, originalPay) {
  const state = {
    status: "running",
    round: 0,
    prices: [originalPay],
    originalPay,
    bestPay: originalPay,
  };
  negotiationState.set(woId, state);
  updateChatNegUI(woId);


  runNegotiationRound(woId, version, majorVersion);
}

function runNegotiationRound(woId, version, majorVersion) {
  const state = negotiationState.get(woId);
  if (!state || state.status !== "running") return;

  state.round++;
  const round = state.round;


  // Round 1: mention the issue. Round 2+: demand a much higher price
  let query;
  if (round === 1) {
    query = "There is a big fire on the road and severe traffic delays. I need a higher rate to take this load given the dangerous conditions.";
  } else {
    const currentBest = state.bestPay || state.originalPay;
    const demandPrice = Math.round(currentBest + (state.originalPay * 0.5)); // ask for 50% more than original on top of current
    query = `That price is still too low given the conditions. I need at least $${demandPrice} to make this work. The fire and road closures are adding significant time and fuel costs.`;
  }


  const payload = {
    action: "query",
    query,
    workOpportunityId: woId,
    workOpportunityOptionId: "1",
    workOpportunityVersion: version,
    woMajorVersion: majorVersion,
  };

  // Listen for this specific response
  function onResult(e) {
    const result = JSON.parse(e.detail);
    if (result.woId !== woId) return; // not our response
    window.removeEventListener("relay-fetcher-negotiate-result", onResult);

    if (result.error) {
      console.error(`[Negotiator] Round ${round} error:`, result.error);
      state.status = "done";
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
      return;
    }

    const data = result.data;
    const updatedPrice = data?.updatedPrice?.value ?? null;
    const chatStatus = data?.status || "";
    const prevPrice = state.prices[state.prices.length - 1];
    const aiResponse = data?.response || "";


    // If Amazon ended the conversation (not IN_PROGRESS)
    if (chatStatus !== "IN_PROGRESS") {
      if (updatedPrice !== null) {
        state.prices.push(updatedPrice);
        if (updatedPrice > state.bestPay) state.bestPay = updatedPrice;
      }
      state.status = "done";
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
      return;
    }

    // Status is IN_PROGRESS
    if (updatedPrice !== null) {
      // Amazon offered a new price
      state.prices.push(updatedPrice);
      if (updatedPrice > state.bestPay) state.bestPay = updatedPrice;
      const diff = updatedPrice - prevPrice;

      negotiationState.set(woId, state);
      updateChatNegUI(woId);

      // Check if price stopped moving
      if (state.prices.length >= 3 && Math.abs(updatedPrice - prevPrice) < 0.01) {
        state.status = "done";
        negotiationState.set(woId, state);
          updateChatNegUI(woId);
        return;
      }
    } else {
      // updatedPrice is null but status is IN_PROGRESS — Amazon is still talking, keep going
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
    }

    // Safety cap
    if (round >= 5) {
      state.status = "done";
      negotiationState.set(woId, state);
      updateChatNegUI(woId);
      return;
    }

    // Schedule next round with random delay
    const delay = 2000 + Math.random() * 1000;
    setTimeout(() => runNegotiationRound(woId, version, majorVersion), delay);
  }

  window.addEventListener("relay-fetcher-negotiate-result", onResult);

  // Dispatch to interceptor
  window.dispatchEvent(new CustomEvent("relay-fetcher-negotiate", {
    detail: JSON.stringify({ woId, payload }),
  }));
}

// ============================================================
// CHAT MODAL — detect + inject negotiate button
// ============================================================
let chatObserver = null;
let chatWoId = null;
let chatWoVersion = null;
let chatWoMajorVersion = null;
let chatOriginalPay = null;

function getChatInput() {
  const inputs = Array.from(document.querySelectorAll(".chat-box-position textarea, .chat-box-position input"));
  return inputs.find(el =>
    /type your message/i.test(el.getAttribute("placeholder") || "") &&
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  );
}

function isVisibleElement(el) {
  return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function getChatContainer() {
  const containers = Array.from(document.querySelectorAll(".chat-box-position"));
  return containers.find(container =>
    isVisibleElement(container) &&
    (
      container.querySelector("#ra-input, textarea, input") ||
      /relay assistant/i.test(container.textContent || "")
    )
  ) || null;
}

function getChatInsertTarget() {
  const input = getChatInput();
  if (!input) return null;
  const inputRect = input.getBoundingClientRect();
  let node = input.parentElement;
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect();
    const isComposerSized = rect.height > 0 && rect.height <= 120 && Math.abs(rect.bottom - inputRect.bottom) < 80;
    if (isComposerSized && node.querySelector("textarea, input") && node.querySelector("button")) return node;
    if (node.classList?.contains("chat-box-position")) break;
    node = node.parentElement;
  }
  return input.parentElement;
}

function isAmazonChatOpen() {
  return !!getChatContainer();
}

function syncChatVisibility() {
  if (ourHost) ourHost.style.display = isAmazonChatOpen() ? "none" : "";
  restoreAmazonChatControls();
}

function restoreAmazonChatControls() {
  document.querySelectorAll(".chat-box-position .message-header button > span").forEach(el => {
    if (el.style.display === "none") el.style.display = "";
  });
}

function setupChatObserver() {
  if (chatObserver) return;
  chatObserver = new MutationObserver(() => {
    const modal = getChatContainer();
    syncChatVisibility();
    if (modal && !document.getElementById("rfx-chat-neg-container")) {
      injectChatNegButton();
    }
    // Clean up if modal closed
    if (!modal && document.getElementById("rfx-chat-neg-container")) {
      const el = document.getElementById("rfx-chat-neg-container");
      if (el) el.remove();
      chatWoId = null;
    }
  });
  chatObserver.observe(document.body, { childList: true, subtree: true });
  syncChatVisibility();
  if (getChatContainer() && !document.getElementById("rfx-chat-neg-container")) {
    injectChatNegButton();
  }
}

function injectChatNegButton() {
  const chat = getChatContainer();
  const insertTarget = getChatInsertTarget();
  if (!chat || !insertTarget || !chat.contains(insertTarget) || document.getElementById("rfx-chat-neg-container")) return;

  const container = document.createElement("div");
  container.id = "rfx-chat-neg-container";
  container.style.cssText = [
    "padding: 8px 0",
    "margin: 0 0 8px 0",
    "background: transparent",
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "position: relative",
    "z-index: 1",
  ].join(";");
  container.innerHTML = `
    <div style="display: flex; gap: 8px;">
      <button id="rfx-chat-neg-btn" style="
        padding: 8px 14px; font-size: 13px; font-weight: 600;
        background: #2563eb; color: #fff; border: none; border-radius: 8px;
        cursor: pointer; font-family: inherit; flex: 1; min-height: 36px;
      ">Auto-Negotiate</button>
      <button id="rfx-chat-neg-stop" style="
        padding: 8px 12px; font-size: 13px; font-weight: 600;
        background: #cc3333; color: #fff; border: none; border-radius: 8px;
        cursor: pointer; font-family: inherit; display: none; min-height: 36px;
      ">Stop</button>
    </div>
    <div id="rfx-chat-neg-status" style="margin-top: 6px; font-size: 13px; display: none;"></div>
  `;

  insertTarget.parentElement?.insertBefore(container, insertTarget);

  container.querySelector("#rfx-chat-neg-btn").addEventListener("click", () => {
    ensureAudioCtx();
    startChatNegotiation();
  });
  container.querySelector("#rfx-chat-neg-stop").addEventListener("click", () => {
    stopNegotiation();
  });
}

function stopNegotiation() {
  if (!chatWoId) return;
  const state = negotiationState.get(chatWoId);
  if (!state || state.status !== "running") return;
  state.status = "done";
  negotiationState.set(chatWoId, state);
  playNegotiationSound();
  updateChatNegUI(chatWoId);
}

function getChatNegTheme() {
  return {
    runningBg: "#eff6ff",
    runningBorder: "#bfdbfe",
    runningTitle: "#2563eb",
    doneBg: "#e6f7f2",
    doneBorder: "#a7f3d0",
    success: "#067d62",
    ineligibleBg: "#f5f5f5",
    ineligibleBorder: "#e5e5e5",
    ineligible: "#888",
    text: "#0f1111",
    muted: "#565959",
  };
}

function startChatNegotiation() {
  const btn = document.getElementById("rfx-chat-neg-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Starting..."; }

  if (chatWoId) {
    startNegotiation(chatWoId, chatWoVersion, chatWoMajorVersion, chatOriginalPay);
    return;
  }

  // No data yet — send a quick initial query to get the load details
  if (btn) btn.textContent = "Getting load info...";

  // We need the WO ID to send the query, but we don't have it yet
  // Try to find it from the chat modal's content (Amazon renders the load ID somewhere)
  const chatBody = document.querySelector(".bot-play-area, [class*='bot-play-area']");
  if (!chatBody) {
    updateChatNegStatus("Could not find chat. Please send a message first, then try again.", "#cc3333");
    if (btn) { btn.disabled = false; btn.textContent = "Auto-Negotiate"; }
    return;
  }

  updateChatNegStatus("Send any message in the chat first so we can capture the load details, then click Auto-Negotiate again.", "#b8860b");
  if (btn) { btn.disabled = false; btn.textContent = "Auto-Negotiate"; }
}

function updateChatNegUI(woId) {
  const state = negotiationState.get(woId);
  if (!state) return;

  const statusEl = document.getElementById("rfx-chat-neg-status");
  const btn = document.getElementById("rfx-chat-neg-btn");
  const stopBtn = document.getElementById("rfx-chat-neg-stop");
  if (!statusEl) return;

  statusEl.style.display = "block";
  const theme = getChatNegTheme();

  if (state.status === "running") {
    const priceChain = state.prices.map(p => fmt$(p)).join(" → ");
    statusEl.innerHTML = `
      <div style="font-weight:600; color:${theme.runningTitle}; animation: rfxNegPulse 1s infinite;">Negotiating... Round ${state.round}</div>
      <div style="margin-top:4px; font-size:14px; color:${theme.text};">${priceChain}</div>
    `;
    statusEl.style.background = theme.runningBg;
    statusEl.style.border = `1px solid ${theme.runningBorder}`;
    statusEl.style.color = theme.text;
    statusEl.style.padding = "8px";
    statusEl.style.borderRadius = "6px";
    if (btn) { btn.disabled = true; btn.textContent = "Negotiating..."; }
    if (stopBtn) { stopBtn.style.display = "block"; }
  } else if (state.status === "done") {
    const gain = state.bestPay - state.originalPay;
    const priceChain = state.prices.map(p => fmt$(p)).join(" → ");
    statusEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:18px">✅</span>
        <span style="font-weight:700; font-size:20px; color:${theme.success};">${fmt$(state.bestPay)}</span>
        ${gain > 0.01 ? `<span style="font-weight:700; color:${theme.success}; font-size:15px;">+${fmt$(gain)} gained</span>` : ""}
        <span style="color:${theme.muted}; font-size:12px;">${state.round} rounds</span>
      </div>
      <div style="margin-top:4px; font-size:13px; color:${theme.text};">${priceChain}</div>
    `;
    statusEl.style.background = theme.doneBg;
    statusEl.style.border = `1px solid ${theme.doneBorder}`;
    statusEl.style.color = theme.text;
    statusEl.style.padding = "10px";
    statusEl.style.borderRadius = "6px";
    if (btn) { btn.disabled = true; btn.textContent = "Negotiation Complete"; btn.style.background = "#067d62"; }
    if (stopBtn) { stopBtn.style.display = "none"; }
  } else if (state.status === "ineligible") {
    statusEl.innerHTML = `<div style="color:${theme.ineligible};">Not eligible for negotiation</div>`;
    statusEl.style.background = theme.ineligibleBg;
    statusEl.style.border = `1px solid ${theme.ineligibleBorder}`;
    statusEl.style.color = theme.text;
    statusEl.style.padding = "8px";
    statusEl.style.borderRadius = "6px";
    if (btn) { btn.disabled = true; btn.textContent = "Not Eligible"; btn.style.background = "#888"; }
    if (stopBtn) { stopBtn.style.display = "none"; }
  }
}

function updateChatNegStatus(text, color) {
  const statusEl = document.getElementById("rfx-chat-neg-status");
  if (statusEl) {
    const theme = getChatNegTheme();
    statusEl.style.display = "block";
    statusEl.style.background = theme.ineligibleBg;
    statusEl.style.border = `1px solid ${theme.ineligibleBorder}`;
    statusEl.style.color = theme.text;
    statusEl.style.padding = "8px";
    statusEl.style.borderRadius = "6px";
    statusEl.innerHTML = `<div style="color:${color || theme.text}">${text}</div>`;
  }
}

// Intercept Amazon's own chat responses to capture workOpportunity details
window.addEventListener("relay-fetcher-chat-intercepted", (e) => {
  try {
    const { data } = JSON.parse(e.detail);
    if (data?.workOpportunity?.id) {
      chatWoId = data.workOpportunity.id;
      chatWoVersion = data.workOpportunity.version || 1;
      chatWoMajorVersion = data.workOpportunity.majorVersion || 1;
      // Get original price from the workOpportunity payout
      chatOriginalPay = data.workOpportunity?.payout?.value || data.updatedPrice?.value || 0;
    }
  } catch (err) {
    console.error("[Negotiator] Chat intercept error:", err);
  }
});

// ============================================================
// BOOK — multi-step DOM automation (manual)
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showToast(text) {
  // Remove existing toast
  const old = document.getElementById("rfx-toast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.id = "rfx-toast";
  toast.className = "rfx-toast";
  // Toast is outside shadow DOM so it's always visible
  toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#232f3e;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

async function sendDiscordTestNotification(button) {
  const webhookUrl = settings.discordWebhookUrl;
  if (!webhookUrl) {
    showToast("Discord webhook is not configured");
    return;
  }

  const oldText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Sending...";
  }

  const payload = {
    username: "Relay Load Fetcher",
    content: "✅ Test notification from Relay Load Fetcher. Discord webhook is connected.",
    embeds: [{
      title: "Discord Alert Test",
      description: "This is a test message from the Chrome extension.",
      color: 0x5865F2,
      fields: [
        { name: "Page", value: location.hostname || "relay.amazon.com", inline: true },
        { name: "Time", value: new Date().toLocaleString(), inline: true },
      ],
    }],
  };

  try {
    const response = await chrome.runtime.sendMessage({
      action: "sendDiscordWebhook",
      webhookUrl,
      payload,
    });
    if (!response?.ok) throw new Error(response?.error || "Discord request failed");
    showToast("Discord test sent");
  } catch (err) {
    console.error("[Discord] Test notification failed:", err);
    showToast(`Discord test failed: ${err?.message || err}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText || "Test Discord";
    }
  }
}

function showIgnoredLoadToast(woId) {
  const old = document.getElementById("rfx-toast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.id = "rfx-toast";
  toast.className = "rfx-toast";
  toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#232f3e;color:#fff;padding:10px 14px;border-radius:8px;font-size:14px;z-index:9999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;";
  toast.innerHTML = `<span>Load hidden</span><button type="button" style="border:1px solid rgba(255,255,255,.6);background:transparent;color:#fff;border-radius:6px;padding:4px 8px;font:inherit;font-weight:700;cursor:pointer;">Undo</button>`;
  const btn = toast.querySelector("button");
  btn?.addEventListener("click", () => {
    unignoreLoad(woId);
    toast.remove();
    showToast("Load restored");
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function findLoadForAction(woId) {
  return allLoads.find(w => w?.id === woId)
    || alertedLoads.find(a => a?.wo?.id === woId)?.wo
    || null;
}

function getLoadSearchIndex(woId) {
  const index = allLoads.findIndex(w => w.id === woId);
  if (index >= 0) return index;
  const alertIndex = alertedLoads.findIndex(a => a?.wo?.id === woId);
  return alertIndex >= 0 ? alertIndex : 0;
}

function buildBookingPayload(wo) {
  return {
    isCallFromRA: false,
    totalCost: {
      value: wo.payout?.value || 0,
      unit: wo.payout?.unit || "USD",
    },
    isCarrierEligibleForOneDayPayment: !!carrierDetails?.isCarrierEligibleForOneDayPayment,
    searchURL: "",
    auditContextMap: JSON.stringify({
      rlbChannel: "EXACT_MATCH",
      searchResultIndex: String(getLoadSearchIndex(wo.id)),
      userAgent: navigator.userAgent,
    }),
  };
}

function openPatModal(woId) {
  if (!findLoadForAction(woId)) {
    showToast("PAT: load data not found. Refresh search first.");
    return;
  }
  patModalWoId = woId;
  if (aiModeActive) injectCards();
}

function closePatModal() {
  patModalWoId = null;
  if (aiModeActive) injectCards();
}

function cancelAllPatOrders() {
  const orders = getOpenPatOrders();
  if (!orders.length) {
    showToast("No active PAT orders captured. Open Post A Truck once so Amazon sends /orders/get.");
    return;
  }
  const count = orders.length;
  const ok = window.confirm(`Cancel ${count} active Post-A-Truck order${count === 1 ? "" : "s"}?`);
  if (!ok) return;

  patCancelInFlight = true;
  if (aiModeActive) injectCards();
  showToast(`Canceling ${count} PAT order${count === 1 ? "" : "s"}...`);

  window.dispatchEvent(new CustomEvent("relay-fetcher-pat-cancel-all", {
    detail: JSON.stringify({ orders }),
  }));
}

function submitPatForm(form) {
  const woId = form?.dataset?.patWoId;
  const wo = findLoadForAction(woId);
  if (!wo) {
    showToast("PAT: load data not found.");
    return;
  }
  const endpoint = getSavedPatEndpoint();
  if (!endpoint) {
    showToast("PAT endpoint not learned yet. Use Amazon Post A Truck once first.");
    return;
  }

  const prefill = getPatPrefill(wo);
  const fd = new FormData(form);
  const values = {
    startTime: localDateTimeInputToIso(fd.get("startTime")),
    endTime: localDateTimeInputToIso(fd.get("endTime")),
    payout: Number(fd.get("payout")) || 0,
    pricePerMi: Number(fd.get("pricePerMi")) || 0,
    distanceMin: Number(fd.get("distanceMin")) || 0,
    distanceMax: Number(fd.get("distanceMax")) || 0,
    stemTime: Number(fd.get("stemTime")) || 60,
    runType: String(fd.get("runType") || prefill.runType),
    originRadius: Number(fd.get("originRadius")) || 25,
    destinationRadius: Number(fd.get("destinationRadius")) || 25,
    origin: parseCityInfoInput(fd.get("origin"), prefill.origin),
    destination: parseCityInfoInput(fd.get("destination"), prefill.destination),
    driverTypes: prefill.driverTypes,
    loadingTypeList: prefill.loadingTypeList,
    maxStops: prefill.maxStops,
  };

  if (!values.startTime || !values.endTime) {
    showToast("PAT: start and end time are required.");
    return;
  }

  const payload = buildPatPayload(wo, values);
  patState.set(woId, "posting");
  patModalWoId = null;
  if (aiModeActive) injectCards();
  showToast("Posting truck order...");

  window.dispatchEvent(new CustomEvent("relay-fetcher-pat-post", {
    detail: JSON.stringify({ woId, url: endpoint, payload }),
  }));
}

function bookLoadDirectFromSearch(woId) {
  const wo = findLoadForAction(woId);
  if (!wo) {
    console.warn("[DirectBook] Could not find load in search results:", woId);
    showToast("Direct book: load data not found. Refresh search first.");
    return;
  }

  const missing = [];
  if (!wo.id) missing.push("id");
  if (wo.version == null) missing.push("version");
  if (wo.majorVersion == null) missing.push("majorVersion");
  if (wo.workOpportunityOptionId == null) missing.push("workOpportunityOptionId");
  if (!wo.payout?.value) missing.push("payout");
  if (missing.length) {
    console.warn("[DirectBook] Missing required fields:", missing, wo);
    showToast(`Direct book: missing ${missing.join(", ")}`);
    return;
  }

  const url = `https://relay.amazon.com/api/loadboard/${wo.id}/${wo.version}/option/${wo.workOpportunityOptionId}/majorVersion/${wo.majorVersion}`;
  const payload = buildBookingPayload(wo);

  bookingState.set(woId, "pending");
  if (aiModeActive) injectCards();
  showToast(`Booking ${fmt$(wo.payout.value)} load directly...`);

  window.dispatchEvent(new CustomEvent("relay-fetcher-book-direct", {
    detail: JSON.stringify({ woId, url, payload }),
  }));
}

window.addEventListener("relay-fetcher-book-direct-result", (e) => {
  try {
    const { woId, status, ok, data, error } = JSON.parse(e.detail);
    if (error || !ok) {
      console.error("[DirectBook] Failed:", { woId, status, error, data });
      bookingState.set(woId, "failed");
      showToast(`Direct book failed${status ? ` (${status})` : ""}`);
      if (aiModeActive) injectCards();
      return;
    }

    bookingState.set(woId, "confirmed");
    armedFastBookLoads.delete(woId);
    alertedLoads = alertedLoads.filter(a => a.wo.id !== woId);
    seenLoads.delete(woId);
    playBookedSound();
    showToast("Load booked successfully!");
    if (aiModeActive) injectCards();
  } catch (err) {
    console.error("[DirectBook] Result handler error:", err);
  }
});

window.addEventListener("relay-fetcher-pat-template", (e) => {
  try {
    const { url, payload } = JSON.parse(e.detail);
    if (url) localStorage.setItem(PAT_ENDPOINT_KEY, url);
    if (payload) localStorage.setItem(PAT_TEMPLATE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("[PAT] Could not save captured template:", err);
  }
});

window.addEventListener("relay-fetcher-pat-orders", (e) => {
  try {
    const { data } = JSON.parse(e.detail);
    const orders = extractPatOrders(data);
    savePatOrders(orders);
    if (orders.length && aiModeActive) injectCards();
  } catch (err) {
    console.warn("[PAT] Could not read captured orders:", err);
  }
});

window.addEventListener("relay-fetcher-pat-post-result", (e) => {
  try {
    const { woId, status, ok, data, error } = JSON.parse(e.detail);
    if (error || !ok) {
      console.error("[PAT] Post failed:", { woId, status, error, data });
      patState.set(woId, "failed");
      showToast(`PAT post failed${status ? ` (${status})` : ""}`);
      if (aiModeActive) injectCards();
      return;
    }
    patState.set(woId, "posted");
    showToast("Post A Truck order created.");
    if (aiModeActive) injectCards();
  } catch (err) {
    console.error("[PAT] Result handler error:", err);
  }
});

window.addEventListener("relay-fetcher-pat-cancel-all-result", (e) => {
  patCancelInFlight = false;
  try {
    const { results = [], error } = JSON.parse(e.detail);
    if (error) {
      showToast(`PAT cancel failed: ${error}`);
      if (aiModeActive) injectCards();
      return;
    }

    const succeeded = results.filter(r => r.ok).map(r => r.id);
    const failed = results.filter(r => !r.ok);
    if (succeeded.length) {
      const canceled = new Set(succeeded);
      savePatOrders(getOpenPatOrders().filter(order => !canceled.has(order.id)));
    }
    showToast(failed.length
      ? `Canceled ${succeeded.length}; ${failed.length} failed`
      : `Canceled ${succeeded.length} PAT order${succeeded.length === 1 ? "" : "s"}`
    );
    if (aiModeActive) injectCards();
  } catch (err) {
    console.error("[PAT] Cancel result handler error:", err);
    showToast("PAT cancel result could not be read");
    if (aiModeActive) injectCards();
  }
});

async function forceAmazonRefresh() {

  let clicked = false;

  const candidates = document.querySelectorAll("button");
  for (const btn of candidates) {
    if (btn.closest("#rfx-host")) continue;
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`.trim();
    const svgPath = Array.from(btn.querySelectorAll("svg path"))
      .map(path => path.getAttribute("d") || "")
      .join(" ");
    const isRefreshIcon = /M20\.128\s+2l-.493\s+5\.635/i.test(svgPath) || /a9\s+9\s+0\s+10/i.test(svgPath);
    if (/^refresh$/i.test(label) || /auto.?refresh/i.test(label) || isRefreshIcon) {
      btn.click();
      clicked = true;
      break;
    }
  }

  if (clicked) {
    await sleep(500);
    for (let i = 0; i < 3; i++) {
      const loadList = document.querySelector(".load-list");
      if (loadList && loadList.children.length > 0) break;
      await sleep(300);
    }
  } else {
    await sleep(1000);
  }
}

// Direct book — we already have the load-card element, no searching needed
async function bookLoadDirect(woId, loadCard) {

  // Close any open panel
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);

  // Click the load card to open Amazon's detail panel
  const clickTarget = loadCard.querySelector(".wo-tag") || loadCard.querySelector("div[id]") || loadCard;
  clickTarget.click();
  await sleep(500);

  // Re-hide Amazon's content (React may have re-rendered and restored it)
  for (const child of loadCard.children) {
    if (!child.classList.contains("rfx-injected")) {
      child.style.display = "none";
    }
  }

  // Find the Book button in the panel
  let bookBtn = null;
  const allButtons = document.querySelectorAll("button, [role='button']");
  for (const btn of allButtons) {
    if (btn.closest("#rfx-host") || btn.closest(".rfx-injected")) continue;
    const txt = (btn.textContent || "").trim().toLowerCase();
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (txt === "book" || txt === "book load" || txt === "book this load" || label.includes("book")) {
      if (!txt.includes("confirm") && !txt.includes("accept")) {
        bookBtn = btn;
        break;
      }
    }
  }

  if (!bookBtn) {
    console.warn("[Booker] Could not find Book button in panel");
    showToast("Panel opened but could not find Book button");
    return;
  }

  // === BOOKING DISABLED FOR SAFETY — uncomment to enable ===
  // await sleep(200);
  // bookBtn.click();
  //
  // if (settings.fastBook) {
  //   await sleep(500);
  //   let confirmBtn = null;
  //   const confirmArea = document.querySelector("#confirmation-expander, [data-id='confirmation-expander']");
  //   if (confirmArea) {
  //     for (const btn of confirmArea.querySelectorAll("button, [role='button']")) {
  //       const txt = (btn.textContent || "").trim().toLowerCase();
  //       if (txt.includes("book") || txt.includes("confirm") || txt.includes("yes")) { confirmBtn = btn; break; }
  //     }
  //   }
  //   if (confirmBtn) {
  //     await sleep(200);
  //     confirmBtn.click();
  //     bookingState.set(woId, "confirmed");
  //     if (aiModeActive) injectCards();
  //     playBookedSound();
  //     showToast("Load booked!");
  //     return;
  //   }
  // }
  // bookingState.set(woId, "pending");
  // if (aiModeActive) injectCards();
  // showToast("Book clicked — confirm in panel");
  // === END BOOKING DISABLED ===

  showToast("Booking disabled for safety — found Book button");
}

function findLoadInDOM(woId, wo) {
  const dataEls = document.querySelectorAll("[data-work-opportunity-id], [data-wo-id], [data-id]");
  for (const el of dataEls) {
    for (const attr of el.attributes) { if (attr.value === woId) return el; }
  }
  const candidates = document.querySelectorAll("a[href], [id], [aria-label]");
  for (const el of candidates) {
    if (el.closest("#rfx-host")) continue;
    if (el.href?.includes(woId) || el.id?.includes(woId) || el.getAttribute("aria-label")?.includes(woId)) return el;
  }
  if (wo) {
    const payText = wo.payout?.value?.toFixed(2);
    const ll = document.querySelector(".load-list");
    if (ll && payText) {
      for (const row of ll.querySelectorAll(":scope > div, :scope > a, :scope > li")) {
        const text = row.textContent || "";
        if (text.includes(payText)) {
          const city = wo.loads?.[0]?.stops?.[0]?.location?.city;
          if (!city || text.toUpperCase().includes(city.toUpperCase())) return row;
        }
      }
    }
  }
  const ll = document.querySelector(".load-list");
  if (ll) { for (const row of ll.querySelectorAll(":scope > *")) { if (row.innerHTML?.includes(woId)) return row; } }
  return null;
}

async function refreshUntilFound(woId, wo, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    showToast(`Looking for load... (${attempt}/${maxAttempts})`);
    await forceAmazonRefresh();
    const row = findLoadInDOM(woId, wo);
    if (attempt < maxAttempts) await sleep(500);
  }
  return null;
}

async function bookLoad(woId) {
  const wo = allLoads.find(w => w.id === woId);

  // Close any open panel
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(200);

  // Refresh Amazon's UI and search — up to 5 attempts
  const loadRow = await refreshUntilFound(woId, wo, 5);

  if (!loadRow) {
    console.warn("[Booker] Could not find load after 5 refresh attempts for ID:", woId);
    showToast("Could not find load after multiple refreshes");
    bookingState.set(woId, "failed");
    if (aiModeActive) injectCards();
    return;
  }

	  // Step 2 — Click the load row to open the detail panel
	  const loadList = document.querySelector(".load-list");
	  const prevLoadListDisplay = loadList?.style.display;
	  if (loadList) loadList.style.display = "";
	  // Find the clickable element — might be the row itself, an anchor, or a child
	  const clickTarget = loadRow.querySelector("a") || loadRow.querySelector("[role='button']") || loadRow;
	  clickTarget.click();
	  await sleep(500);
	  if (loadList && aiModeActive) loadList.style.display = prevLoadListDisplay || "none";

  // Step 3 — Find and click the Book button inside the detail panel
  let bookBtn = null;

  // Search all buttons on the page for one that says "Book"
  const allButtons = document.querySelectorAll("button, [role='button']");
  for (const btn of allButtons) {
    if (btn.closest("#rfx-host")) continue; // skip our own buttons
    const txt = (btn.textContent || "").trim().toLowerCase();
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    // Match "Book" but NOT "Book Now", "Booked", "Book and Confirm", etc. — just "Book" or "Book load"
    if (txt === "book" || txt === "book load" || txt === "book this load" || label.includes("book")) {
      // Make sure it's not a confirm/accept button
      if (!txt.includes("confirm") && !txt.includes("accept")) {
        bookBtn = btn;
        break;
      }
    }
  }

  if (!bookBtn) {
    console.warn("[Booker] Could not find Book button in the detail panel");
    showToast("Load panel opened but could not find the Book button");
    return;
  }

  // === BOOKING DISABLED FOR SAFETY — uncomment to enable ===
  // await sleep(200);
  // bookBtn.click();
  //
  // if (!settings.fastBook) {
  //   bookingState.set(woId, "pending");
  //   if (aiModeActive) injectCards();
  //   showToast("Book clicked — review and confirm in Amazon's panel");
  //   return;
  // }
  //
  // await sleep(500);
  //
  // let confirmBtn = null;
  // const confirmArea = document.querySelector("#confirmation-expander, [data-id='confirmation-expander']");
  // if (confirmArea) {
  //   const btns = confirmArea.querySelectorAll("button, [role='button']");
  //   for (const btn of btns) {
  //     const txt = (btn.textContent || "").trim().toLowerCase();
  //     if (txt.includes("book") || txt.includes("confirm") || txt.includes("yes") || txt.includes("accept")) {
  //       confirmBtn = btn; break;
  //     }
  //   }
  // }
  // if (!confirmBtn) {
  //   const allBtns2 = document.querySelectorAll("button, [role='button']");
  //   for (const btn of allBtns2) {
  //     if (btn.closest("#rfx-host")) continue;
  //     if (btn === bookBtn) continue;
  //     const txt = (btn.textContent || "").trim().toLowerCase();
  //     if (txt === "confirm" || txt === "yes" || txt === "book this trip" || txt === "confirm booking" || txt.includes("yes") || txt.includes("confirm")) {
  //       confirmBtn = btn; break;
  //     }
  //   }
  // }
  // if (!confirmBtn) {
  //   bookingState.set(woId, "pending");
  //   if (aiModeActive) injectCards();
  //   showToast("Book clicked but could not find Confirm — confirm manually");
  //   return;
  // }
  // await sleep(200);
  // confirmBtn.click();
  // bookingState.set(woId, "confirmed");
  // if (aiModeActive) injectCards();
  // playBookedSound();
  // showToast("Load booked successfully!");
  // === END BOOKING DISABLED ===

  showToast("Booking is disabled for safety — found the load but did not book");
}

// ============================================================
// FETCH ALL (paginated, manual)
// ============================================================
function fetchAllLoads() {
  return new Promise((resolve) => {
    const btn = document.querySelector("#rfx-fetch-btn button");
    function onProgress(e) { const { fetched, total } = JSON.parse(e.detail); if (btn) btn.textContent = `${fetched}/${total}...`; }
    window.addEventListener("relay-fetcher-progress", onProgress);
    function onResult(e) {
      window.removeEventListener("relay-fetcher-result", onResult);
      window.removeEventListener("relay-fetcher-progress", onProgress);
      const { data, error } = JSON.parse(e.detail);
      if (btn) btn.textContent = "Fetch All";
      if (error || data?.errorCode) { resolve(); return; }
      carrierDetails = data?.carrierDetails || carrierDetails;
      currentSearchAuditId = data?.searchAuditId || currentSearchAuditId;
      allLoads = filterCustomExcludedLoads(data?.workOpportunities || []);
      processLookoutAlerts(allLoads, "fetch-all");
      // Populate seenLoads map so detection works correctly from here
      for (const wo of allLoads) {
        if (!seenLoads.has(wo.id)) {
          seenLoads.set(wo.id, { version: wo.version || 1, payout: wo.payout?.value || 0, pickupTime: wo.firstPickupTime || "" });
        }
      }
      isFirstPoll = false;
      if (aiModeActive) injectCards();
      if (!aiModeActive && allLoads.length > 0) toggleAiMode();
      resolve();
    }
    window.addEventListener("relay-fetcher-result", onResult);

    const fallback = {
      workOpportunityTypeList: ["ONE_WAY", "ROUND_TRIP", "HOSTLER_SHUTTLE"], originCity: null, liveCity: null,
      originCities: [{ displayValue: "TRACY, CA", stateCode: "CA", isCityLive: false, latitude: 37.724328, longitude: -121.444622, name: "TRACY" }],
      startCityName: null, startCityStateCode: null, startCityLatitude: null, startCityLongitude: null, startCityDisplayValue: null,
      isOriginCityLive: null, startCityRadius: 50, destinationCity: null,
      originCitiesRadiusFilters: [{ cityLatitude: 37.724328, cityLongitude: -121.444622, cityName: "TRACY", cityStateCode: "CA", cityDisplayValue: "TRACY, CA", radius: 50 }],
      destinationCitiesRadiusFilters: [], exclusionCitiesFilter: null, endCityName: null, endCityStateCode: null, endCityDisplayValue: null,
      endCityLatitude: null, endCityLongitude: null, isDestinationCityLive: null, endCityRadius: 5, startDate: null, endDate: null,
      minDistance: null, maxDistance: null, minimumDurationInMillis: null, maximumDurationInMillis: null, minPayout: null, minPricePerDistance: null,
      driverTypeFilters: ["SINGLE_DRIVER", "TEAM_DRIVER"], uiiaCertificationsFilter: [], workOpportunityOperatingRegionFilter: [],
      loadingTypeFilters: ["LIVE", "DROP"], maximumNumberOfStops: 3, workOpportunityAccessType: null,
      sortByField: "relevanceForSearchTab", sortOrder: "asc", visibilityStatusType: "ALL",
      categorizedEquipmentTypeList: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "SKIRTED_FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_DRY_VAN", "FIFTY_THREE_FOOT_A5_AIR_TRAILER", "FORTY_FIVE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
      categorizedEquipmentTypeListForFilterPills: [{ equipmentCategory: "PROVIDED", equipmentsList: ["FIFTY_THREE_FOOT_TRUCK", "FIFTY_THREE_FOOT_CONTAINER"] }],
      nextItemToken: 0, resultSize: 50, searchURL: "", isAutoRefreshCall: false, notificationId: "",
      auditContextMap: JSON.stringify({ rlbChannel: "EXACT_MATCH", isOriginCityLive: "false", isDestinationCityLive: "false", userAgent: navigator.userAgent, source: "AVAILABLE_WORK" }),
    };
    window.dispatchEvent(new CustomEvent("relay-fetcher-fetch", { detail: JSON.stringify({ payload: fallback }) }));
  });
}

// ============================================================
// AUTO-UPDATE from page's own search
// ============================================================
window.addEventListener("relay-fetcher-search-start", (e) => {
  try {
    const { seq } = JSON.parse(e.detail);
    const searchSeq = Number(seq);
    if (Number.isFinite(searchSeq) && searchSeq > latestAutoSearchSeq) {
      latestAutoSearchSeq = searchSeq;
    }
  } catch (err) {
    console.error("[Relay Fetcher] Search-start error:", err);
  }
});

window.addEventListener("relay-fetcher-auto-update", (e) => {
  try {
    const { data, payload, seq } = JSON.parse(e.detail);
    if (Number.isFinite(Number(seq))) {
      if (Number(seq) < latestAutoSearchSeq) return;
      latestAutoSearchSeq = Number(seq);
    }
    if (data?.workOpportunities) {
      carrierDetails = data?.carrierDetails || carrierDetails;
      currentSearchAuditId = data?.searchAuditId || currentSearchAuditId;
      const rawPageLoads = data.workOpportunities || [];
      const pageLoads = filterCustomExcludedLoads(rawPageLoads);
      const alertPaused = alertedLoads.length > 0;
      const pageSignature = getSearchSignature(payload);
      const isPartialPage = !!data._rfxPartialPage;
      const filterChanged = !!pageSignature && pageSignature !== currentSearchSignature;
      const completesFilterChange = !isPartialPage && !!pageSignature && pageSignature === pendingPartialSearchSignature;
      const replacesSearchResults = filterChanged || completesFilterChange;
      if (filterChanged) {
        currentSearchSignature = pageSignature;
        pendingPartialSearchSignature = isPartialPage ? pageSignature : "";
      } else if (completesFilterChange) {
        pendingPartialSearchSignature = "";
      }

      // A partial response for the current filters adds no new information. For a newly
      // changed filter, however, it is the fastest authoritative result set available.
      if (isPartialPage && !filterChanged) return;

      if (pageLoads.length > 0) lastNonEmptySearchAt = Date.now();

      if (replacesSearchResults) {
        allLoads = dedupeLoads(pageLoads);
        alertedLoads = [];
        missingCounts.clear();
        recentlyMissingLoads.clear();
        goneLoads.clear();
        seedSeenLoads(allLoads);
        isFirstPoll = allLoads.length === 0;
        if (!isPartialPage) processLookoutAlerts(allLoads, "page-search-filter-change");
        if (aiModeActive) injectCards();
        return;
      }

      if (pageLoads.length === 0 && shouldIgnoreEmptySearchResult("Bot:AutoUpdate")) {
        if (aiModeActive) injectCards();
        return;
      }

      if (pageLoads.length === 0) {
        if (botRunning || botStarting || alertPaused) {
          return;
        }
        allLoads = [];
        alertedLoads = [];
        seenLoads.clear();
        missingCounts.clear();
        recentlyMissingLoads.clear();
        goneLoads.clear();
        isFirstPoll = false;
        if (aiModeActive) injectCards();
        return;
      }

      // Deduplicate — keep highest payout per ID
      const dedupMap = new Map();
      if (botRunning || botStarting || alertPaused) {
        for (const wo of allLoads) dedupMap.set(wo.id, wo);
      }
      for (const wo of pageLoads) {
        const existing = dedupMap.get(wo.id);
        if (!existing || (wo.payout?.value || 0) > (existing.payout?.value || 0)) {
          dedupMap.set(wo.id, wo);
        }
      }
      allLoads = Array.from(dedupMap.values());
      processLookoutAlerts(allLoads, "page-search");

      if (!botRunning && !botStarting && !alertPaused) {
        allLoads = dedupeLoads(pageLoads);
        seedSeenLoads(allLoads);
        isFirstPoll = false;
      } else {
        // Bot is active or alert-paused — do NOT touch seenLoads. Let the bot's own poll/alert state decide.
      }
      if (aiModeActive) injectCards();
    }
  } catch (err) { console.error("[Relay Fetcher] Auto-update error:", err); }
});

// Keepalive handler
chrome.runtime.onMessage.addListener((msg) => { if (msg.action === "keepalive") return; });

// ============================================================
// TRIPS PAGES — fuel profit badges for upcoming/in-transit/history
// ============================================================
function ensureTripsProfitStyle() {
  if (document.getElementById("rfx-trips-profit-style")) return;
  const style = document.createElement("style");
  style.id = "rfx-trips-profit-style";
  style.textContent = `
    .rfx-trip-profit-badge {
      display: block; width: max-content; max-width: 190px;
      margin-top: 3px; padding: 3px 7px; border-radius: 5px;
      background: #e6f7f2; color: #067d62;
      font: 800 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .rfx-trip-profit-badge.negative {
      background: #fdecea; color: #b12704;
    }
    .rfx-trip-profit-badge small {
      color: inherit; opacity: 0.68; font-weight: 700; margin-left: 3px;
    }
    html.rfx-page-dark .rfx-trip-profit-badge {
      background: #0f3129;
      border: 1px solid #1f6d5b;
      color: #7ee7c8;
      box-shadow: none;
    }
    html.rfx-page-dark .rfx-trip-profit-badge.negative {
      background: #3a1515;
      border-color: #7f1d1d;
      color: #fca5a5;
    }
    html.rfx-page-dark .rfx-trip-profit-badge small {
      color: #b8c3ca;
      opacity: 1;
    }
    @media (max-width: 700px) {
      .rfx-trip-profit-badge { max-width: 165px; font-size: 11px; padding: 2px 6px; }
    }
  `;
  document.head.appendChild(style);
}

function parseMoneyFromText(text) {
  const matches = [...String(text || "").matchAll(/\$([\d,]+(?:\.\d{1,2})?)/g)]
    .map(m => Number(m[1].replace(/,/g, "")))
    .filter(n => Number.isFinite(n));
  if (!matches.length) return 0;
  return Math.max(...matches);
}

function parseLoadedMilesFromText(text) {
  const matches = [...String(text || "").matchAll(/([\d,]+(?:\.\d+)?)\s*mi\b/gi)]
    .map(m => Number(m[1].replace(/,/g, "")))
    .filter(n => Number.isFinite(n));
  if (!matches.length) return 0;
  return Math.max(...matches);
}

function getTripRowId(text) {
  const match = String(text || "").match(/\b(?:T-)?[A-Z0-9]{7,12}\b/);
  return match?.[0] || "";
}

function isVisibleTripRow(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 500 || rect.height < 40 || rect.height > 180) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function findTripRows() {
  const candidates = [];
  for (const el of document.querySelectorAll("div")) {
    if (el.closest("#rfx-host") || el.closest(".rfx-trip-profit-badge")) continue;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 1000) continue;
    const tripId = getTripRowId(text);
    if (!tripId || !/\$\d/.test(text) || !/\bmi\b/i.test(text)) continue;
    if (!isVisibleTripRow(el)) continue;

    const rect = el.getBoundingClientRect();
    candidates.push({ el, text, tripId, area: rect.width * rect.height });
  }

  candidates.sort((a, b) => a.area - b.area);

  const rows = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.tripId)) continue;
    if (rows.some(row => candidate.el.contains(row.el) || row.el.contains(candidate.el))) continue;
    seen.add(candidate.tripId);
    rows.push(candidate);
  }
  return rows;
}

let tripsProfitTimer = null;
function scheduleTripsProfitCalculator(delay = 600) {
  if (!isTripsPage()) return;
  if (tripsProfitTimer) clearTimeout(tripsProfitTimer);
  tripsProfitTimer = setTimeout(() => {
    tripsProfitTimer = null;
    applyTripsProfitCalculator();
  }, delay);
}

function applyTripsProfitCalculator() {
  if (!isTripsPage()) return;
  const pageText = (document.body?.innerText || "").slice(0, 2000);
  if (/one moment please/i.test(pageText)) {
    scheduleTripsProfitCalculator(1000);
    return;
  }
  ensureTripsProfitStyle();

  const rows = findTripRows();
  const validHosts = new Set(rows.map(row => row.el));
  document.querySelectorAll(".rfx-trip-profit-badge").forEach(badge => {
    if (!validHosts.has(badge.parentElement)) badge.remove();
  });
  for (const row of rows) {
    const payout = parseMoneyFromText(row.text);
    const miles = parseLoadedMilesFromText(row.text);
    const estimate = calcFuelProfitFromTrip(payout, miles);
    if (!estimate || !payout || !miles) continue;

    let badge = row.el.querySelector(":scope > .rfx-trip-profit-badge");
    const signature = [
      payout,
      miles,
      settings.profitMpg,
      settings.profitFuelPrice,
      settings.profitDeadheadMiles,
      settings.profitReturnMiles,
      settings.showProfitEstimate,
    ].join("|");
    if (badge?.dataset.sig === signature) continue;

    if (!settings.showProfitEstimate) {
      if (badge) badge.remove();
      continue;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rfx-trip-profit-badge";
      row.el.appendChild(badge);
    }
    badge.dataset.sig = signature;
    badge.classList.toggle("negative", estimate.profit < 0);
    badge.title = `Fuel-only estimate: ${estimate.totalMiles.toFixed(1)} total mi / ${estimate.mpg.toFixed(1)} MPG × ${fmt$(estimate.fuelPrice)} = ${fmt$(estimate.fuelCost)} fuel`;
    badge.innerHTML = `${fmt$(estimate.profit)} / <small>${fmt$(estimate.fuelCost)}</small>`;
  }
}

// MutationObserver — injects our UI, re-injects if removed, hides Amazon content
const observer = new MutationObserver((mutations) => {
  if (settings.hideFuzzyPatFooter) {
    applyFuzzyPatFooterVisibility();
  }
  if (isTripsPage()) {
    if (mutations.some(m => m.target?.closest?.(".rfx-trip-profit-badge"))) return;
    scheduleTripsProfitCalculator();
    return;
  }
  if (!isLoadBoardPage()) return;
  for (const m of mutations) {
    if (m.target.id === "rfx-host" || m.target.closest?.("#rfx-host")) return;
  }
  if (!aiModeActive) return;

  // Check if our host got disconnected (Amazon re-rendered the page)
  if (ourHost && !document.contains(ourHost)) {
    ourHost = null;
    shadowRoot = null;
    amazonContainer = null;
  }

  if (!ourHost) {
    injectCards();
	  } else {
	    applyHideAmazonLoads();
	  }
});
let observerStarted = false;
function ensureObserverStarted() {
  if (observerStarted || !document.body) return;
  observer.observe(document.body, { childList: true, subtree: true });
  observerStarted = true;
  applyPageTheme();
  ensurePageThemeMediaListener();
  applyFuzzyPatFooterVisibility();
  scheduleDisableAmazonAutoRefresh(800);
}

// ============================================================
// INIT
// ============================================================
function init() {
  ensurePageFontReset();
  applyPageTheme();
  ensurePageThemeMediaListener();
  ensureObserverStarted();
  if (isTripsPage()) {
    scheduleTripsProfitCalculator(800);
    return;
  }
  if (!isLoadBoardPage()) return;

  // Persistent "AI Loads" button — injected into the same area as the load list
  const backBtn = document.createElement("div");
  backBtn.id = "rfx-back-btn";
  backBtn.style.cssText = "display:none; padding:12px 0;";
  backBtn.innerHTML = `<button style="
    padding:10px 24px; font-size:14px; font-weight:600;
    border-radius:8px; cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,0.15);
    font-family:${RFX_SYSTEM_FONT_STACK}; border:none;
    background:#232f3e; color:#fff;
  ">AI Loads</button>`;
  backBtn.querySelector("button").addEventListener("click", toggleAiMode);
  document.body.appendChild(backBtn);

  setupChatObserver();
  scheduleDisableAmazonAutoRefresh(800);
  setTimeout(disableAmazonAutoRefreshIfEnabled, 2500);
  injectCards();
}

if (document.body) init();
else document.addEventListener("DOMContentLoaded", init);
