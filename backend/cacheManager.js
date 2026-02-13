const fetch = require("node-fetch");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const { FEEDS } = require("./feeds");

const ALERTS_FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts";

const DEFAULT_ARRIVALS_POLL_MS = 15_000;
const DEFAULT_ALERTS_POLL_MS = 30_000;
const DEFAULT_WEATHER_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REVERSE_TTL_MS = 30 * 60 * 1000;

const state = {
  started: false,
  arrivalsTimer: null,
  alertsTimer: null,
  arrivalsPolling: false,
  alertsPolling: false,
  arrivalsSnapshot: {
    updatedAt: 0,
    feeds: {},
    error: null
  },
  alertsSnapshot: {
    updatedAt: 0,
    feed: null,
    error: null
  },
  weatherCache: new Map(),
  reverseGeocodeCache: new Map()
};

let config = {
  apiKey: "",
  gtfsProxyBase: "",
  gtfsProxyMode: "nyctrains",
  arrivalsPollMs: DEFAULT_ARRIVALS_POLL_MS,
  alertsPollMs: DEFAULT_ALERTS_POLL_MS,
  weatherTtlMs: DEFAULT_WEATHER_TTL_MS,
  reverseTtlMs: DEFAULT_REVERSE_TTL_MS,
  logger: console
};

function getProxyFeedKey(feedKey, gtfsProxyMode) {
  if (gtfsProxyMode === "nyctrains") {
    const map = {
      ACE: "ace",
      BDFM: "bdfm",
      NQRW: "nqrw",
      G: "g",
      JZ: "jz",
      L: "l",
      SIR: "si",
      "123": "1234567",
      "456": "1234567",
      "7": "1234567"
    };
    return map[feedKey] || feedKey.toLowerCase();
  }
  return feedKey.toLowerCase();
}

async function fetchFeedSnapshot(feedKey) {
  const feed = FEEDS[feedKey];
  if (!feed) return null;

  if (config.gtfsProxyBase) {
    const proxyKey = getProxyFeedKey(feedKey, config.gtfsProxyMode);
    const proxyUrl = new URL(`/subway/${proxyKey}/json`, config.gtfsProxyBase);
    const response = await fetch(proxyUrl.toString());
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed proxy feed ${feedKey}: ${response.status} (${text.trim() || "no body"})`
      );
    }
    return response.json();
  }

  const options = config.apiKey
    ? { headers: { "x-api-key": config.apiKey } }
    : undefined;
  const response = await fetch(feed.url, options);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const text = buffer.toString("utf8", 0, 300);
    throw new Error(
      `Failed MTA feed ${feedKey}: ${response.status} (${text.trim() || "no body"})`
    );
  }

  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
}

async function fetchAlertsSnapshot() {
  const options = config.apiKey
    ? { headers: { "x-api-key": config.apiKey } }
    : undefined;
  const response = await fetch(ALERTS_FEED_URL, options);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const text = buffer.toString("utf8", 0, 300);
    throw new Error(
      `Failed alerts feed: ${response.status} (${text.trim() || "no body"})`
    );
  }

  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
}

async function pollArrivalsSnapshot() {
  if (state.arrivalsPolling) return;
  state.arrivalsPolling = true;
  try {
    const feedKeys = Object.keys(FEEDS);
    const feedMessages = await Promise.all(
      feedKeys.map((feedKey) => fetchFeedSnapshot(feedKey))
    );

    const nextFeeds = {};
    feedKeys.forEach((feedKey, idx) => {
      nextFeeds[feedKey] = feedMessages[idx];
    });

    state.arrivalsSnapshot = {
      updatedAt: Date.now(),
      feeds: nextFeeds,
      error: null
    };
  } catch (error) {
    state.arrivalsSnapshot = {
      ...state.arrivalsSnapshot,
      error: error.message,
      updatedAt: Date.now()
    };
    config.logger.warn?.(`[cache] arrivals poll failed: ${error.message}`);
  } finally {
    state.arrivalsPolling = false;
  }
}

async function pollAlertsSnapshot() {
  if (state.alertsPolling) return;
  state.alertsPolling = true;
  try {
    const feed = await fetchAlertsSnapshot();
    state.alertsSnapshot = {
      updatedAt: Date.now(),
      feed,
      error: null
    };
  } catch (error) {
    state.alertsSnapshot = {
      ...state.alertsSnapshot,
      error: error.message,
      updatedAt: Date.now()
    };
    config.logger.warn?.(`[cache] alerts poll failed: ${error.message}`);
  } finally {
    state.alertsPolling = false;
  }
}

function makeGeoKey(lat, lon) {
  // 4 decimals ~ 11m; good dedupe for nearby station polls
  const latKey = Number(lat).toFixed(4);
  const lonKey = Number(lon).toFixed(4);
  return `${latKey},${lonKey}`;
}

async function getWithTtl(map, key, ttlMs, fetcher) {
  const now = Date.now();
  const cached = map.get(key);
  if (cached && now - cached.updatedAt < ttlMs) {
    return cached.value;
  }
  const value = await fetcher();
  map.set(key, { value, updatedAt: now });
  return value;
}

function getArrivalsSnapshot() {
  return state.arrivalsSnapshot;
}

function getAlertsSnapshot() {
  return state.alertsSnapshot;
}

function getFeedSnapshotByKey(feedKey) {
  return state.arrivalsSnapshot.feeds[feedKey] || null;
}

/**
 * Weather cache accessor with 5-minute TTL by default.
 * `fetchWeatherFn` should match existing server fetchWeather(lat, lon).
 */
async function getWeather(lat, lon, fetchWeatherFn) {
  if (typeof fetchWeatherFn !== "function") {
    throw new Error("getWeather requires fetchWeatherFn");
  }
  const key = makeGeoKey(lat, lon);
  return getWithTtl(
    state.weatherCache,
    key,
    config.weatherTtlMs,
    () => fetchWeatherFn(lat, lon)
  );
}

/**
 * Optional reverse geocode cache.
 * `fetchReverseFn` should match existing reverseGeocode(lat, lon).
 */
async function getReverseGeocode(lat, lon, fetchReverseFn) {
  if (typeof fetchReverseFn !== "function") {
    throw new Error("getReverseGeocode requires fetchReverseFn");
  }
  const key = makeGeoKey(lat, lon);
  return getWithTtl(
    state.reverseGeocodeCache,
    key,
    config.reverseTtlMs,
    () => fetchReverseFn(lat, lon)
  );
}

function clearWeatherCache() {
  state.weatherCache.clear();
}

function clearReverseGeocodeCache() {
  state.reverseGeocodeCache.clear();
}

async function warmup() {
  await Promise.all([pollArrivalsSnapshot(), pollAlertsSnapshot()]);
}

function start() {
  if (state.started) return;
  state.started = true;

  // Immediate warm start
  void warmup();

  state.arrivalsTimer = setInterval(() => {
    void pollArrivalsSnapshot();
  }, config.arrivalsPollMs);

  state.alertsTimer = setInterval(() => {
    void pollAlertsSnapshot();
  }, config.alertsPollMs);

  // Do not keep process alive solely for timers
  if (typeof state.arrivalsTimer.unref === "function") state.arrivalsTimer.unref();
  if (typeof state.alertsTimer.unref === "function") state.alertsTimer.unref();
}

function stop() {
  if (!state.started) return;
  state.started = false;
  if (state.arrivalsTimer) clearInterval(state.arrivalsTimer);
  if (state.alertsTimer) clearInterval(state.alertsTimer);
  state.arrivalsTimer = null;
  state.alertsTimer = null;
}

function configure(options = {}) {
  config = {
    ...config,
    ...options
  };
}

module.exports = {
  configure,
  start,
  stop,
  warmup,
  getArrivalsSnapshot,
  getAlertsSnapshot,
  getFeedSnapshotByKey,
  getWeather,
  getReverseGeocode,
  clearWeatherCache,
  clearReverseGeocodeCache
};
