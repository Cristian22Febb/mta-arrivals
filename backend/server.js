const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const AdmZip = require("adm-zip");
const fetch = require("node-fetch");
const { parse } = require("csv-parse");
const { parse: parseSync } = require("csv-parse/sync");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const { FEEDS, getFeedsForRoutes } = require("./feeds");

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const GTFS_PROXY_BASE = process.env.GTFS_PROXY_BASE || "";
const GTFS_PROXY_MODE = process.env.GTFS_PROXY_MODE || "nyctrains";

const GTFS_DIR = path.join(__dirname, "gtfs");
const STATIC_GTFS_URL =
  "http://web.mta.info/developers/data/nyct/subway/google_transit.zip";
const ALERTS_FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts";
const ZIP_GEOJSON_PATH = path.join(__dirname, "..", "nyc_zipcodes.geojson");
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT || "mta-arrivals/1.0 (local dev)";
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "";
const REQUIRED_FILES = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];

let stationCache = null;
let zipcodeCache = null;

app.use(cors());
app.use(express.json());  // Parse JSON bodies for POST requests
app.use(express.text());  // Parse text/plain bodies for crash logs
app.use(express.static(FRONTEND_DIR));

function fileIsMissingOrEmpty(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.size < 10;
  } catch (error) {
    return true;
  }
}

async function ensureStaticGtfs() {
  const missing = REQUIRED_FILES.some((file) =>
    fileIsMissingOrEmpty(path.join(GTFS_DIR, file))
  );
  if (!missing) {
    return;
  }

  fs.mkdirSync(GTFS_DIR, { recursive: true });

  const response = await fetch(STATIC_GTFS_URL);
  if (!response.ok) {
    throw new Error(`Failed to download GTFS static data: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const zip = new AdmZip(Buffer.from(arrayBuffer));
  REQUIRED_FILES.forEach((fileName) => {
    zip.extractEntryTo(fileName, GTFS_DIR, false, true);
  });
}

function normalizeRoute(route) {
  if (route === "SIR") return "SI";
  return route;
}

function splitDirections(stopIds) {
  const north = [];
  const south = [];
  const other = [];

  (stopIds || []).forEach((stopId) => {
    if (stopId.endsWith("N")) {
      north.push(stopId);
    } else if (stopId.endsWith("S")) {
      south.push(stopId);
    } else {
      other.push(stopId);
    }
  });

  if (other.length > 0) {
    north.push(...other);
    south.push(...other);
  }

  if (north.length === 0 && south.length === 0) {
    return { north: stopIds || [], south: stopIds || [] };
  }

  return { north, south };
}

function displayRoute(route) {
  if (route === "SI") return "SIR";
  return route;
}

function getProxyFeedKey(feedKey) {
  if (GTFS_PROXY_MODE === "nyctrains") {
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

function getTripUpdate(entity) {
  return entity.tripUpdate || entity.trip_update || null;
}

function getStopTimeUpdates(update) {
  return update.stopTimeUpdate || update.stop_time_update || [];
}

function getRouteId(trip) {
  return trip.route_id || trip.routeId || "";
}

function getStopId(stopUpdate) {
  return stopUpdate.stop_id || stopUpdate.stopId || "";
}

function getStopName(stopUpdate) {
  return stopUpdate.stop_name || stopUpdate.stopName || "";
}

function getDestinationName(update) {
  const updates = getStopTimeUpdates(update);
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const name = getStopName(updates[i]);
    if (name) return name;
  }
  return "";
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeArrivalValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    const numeric = Number(value);
    return Number.isNaN(numeric) ? null : numeric;
  }
  return null;
}

function getArrivalTime(stopUpdate) {
  const arrival = stopUpdate.arrival || stopUpdate.arrivalTime || null;
  const departure = stopUpdate.departure || stopUpdate.departureTime || null;
  const arrivalValue = normalizeArrivalValue(
    arrival && (arrival.time ?? arrival.time_sec ?? arrival.timeSec)
  );
  const departureValue = normalizeArrivalValue(
    departure && (departure.time ?? departure.time_sec ?? departure.timeSec)
  );
  return arrivalValue ?? departureValue ?? null;
}

function getTranslationText(field) {
  if (!field) return "";
  if (typeof field === "string") return field;
  const translations = field.translation || field.translations || [];
  if (!Array.isArray(translations) || translations.length === 0) return "";
  const english = translations.find(
    (item) => (item.language || item.lang) === "en"
  );
  const choice = english || translations[0];
  return choice && choice.text ? choice.text : "";
}

function getAlertHeader(alert) {
  return getTranslationText(alert.headerText || alert.header_text);
}

function getAlertDescription(alert) {
  return getTranslationText(alert.descriptionText || alert.description_text);
}

function normalizeAlertText(value) {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]*icon[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getAlertEffect(alert) {
  return (
    alert.effect ||
    alert.effectEnum ||
    alert.effect_enum ||
    alert.effectType ||
    ""
  );
}

function getAlertPeriods(alert) {
  return alert.activePeriod || alert.active_period || [];
}

function isAlertActive(alert, nowSeconds) {
  const periods = getAlertPeriods(alert);
  if (!Array.isArray(periods) || periods.length === 0) return true;
  return periods.some((period) => {
    const start = normalizeArrivalValue(
      period.start ?? period.start_time ?? period.startTime
    );
    const end = normalizeArrivalValue(
      period.end ?? period.end_time ?? period.endTime
    );
    if (start !== null && nowSeconds < start) return false;
    if (end !== null && nowSeconds > end) return false;
    return true;
  });
}

function normalizeStopIdForAlert(stopId) {
  if (!stopId) return "";
  return stopId.replace(/[NS]$/, "");
}

function getAlertRoutes(informedEntities) {
  if (!Array.isArray(informedEntities) || informedEntities.length === 0) {
    return [];
  }
  const routes = new Set();
  informedEntities.forEach((entity) => {
    const routeId = entity.routeId || entity.route_id || "";
    if (!routeId) return;
    const normalized = normalizeRoute(routeId);
    if (!normalized) return;
    routes.add(displayRoute(normalized));
  });
  return Array.from(routes).sort();
}

function alertMatches(informedEntities, routeList, stopList, stationList) {
  if (!routeList.length && !stopList.length && !stationList.length) return true;
  if (!Array.isArray(informedEntities) || informedEntities.length === 0) {
    return true;
  }
  const stopSet = new Set(stopList);
  const stationSet = new Set(stationList);
  return informedEntities.some((entity) => {
    const routeId = entity.routeId || entity.route_id || "";
    const stopId = entity.stopId || entity.stop_id || "";
    if (routeId) {
      const normalized = normalizeRoute(routeId);
      if (routeList.includes(normalized)) return true;
    }
    if (stopId) {
      if (stopSet.has(stopId)) return true;
      const normalizedStop = normalizeStopIdForAlert(stopId);
      if (normalizedStop && stationSet.has(normalizedStop)) return true;
    }
    return false;
  });
}

async function collectAlerts(routeList, stopList, stationList, apiKey) {
  const alertMessage = await fetchAlertsFeed(apiKey);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const alertMap = new Map();
  if (alertMessage && alertMessage.entity) {
    alertMessage.entity.forEach((entity) => {
      const alert = entity.alert || entity.Alert || null;
      if (!alert) return;
      if (!isAlertActive(alert, nowSeconds)) return;
      const informed = alert.informedEntity || alert.informed_entity || [];
      if (!alertMatches(informed, routeList, stopList, stationList)) return;
      const header = getAlertHeader(alert);
      const description = getAlertDescription(alert);
      if (!header && !description) return;
      const routesForAlert = getAlertRoutes(informed);
      const effect = getAlertEffect(alert);
      const id = entity.id || `${header}-${description}`;
      const key = normalizeAlertText(header);
      const existing = alertMap.get(key);
      if (existing) {
        const mergedRoutes = new Set([
          ...(existing.routes || []),
          ...routesForAlert
        ]);
        existing.routes = Array.from(mergedRoutes).sort();
        if (!existing.effect && effect) {
          existing.effect = effect;
        }
        if (!existing.id && id) {
          existing.id = id;
        }
      } else {
        alertMap.set(key, {
          id,
          header,
          description,
          routes: routesForAlert,
          effect
        });
      }
    });
  }
  return Array.from(alertMap.values());
}

async function addRoutesFromStopTimes(stopIdToStationId, tripIdToRoute, stations) {
  const stopTimesPath = path.join(GTFS_DIR, "stop_times.txt");

  return new Promise((resolve, reject) => {
    const parser = parse({ columns: true, skip_empty_lines: true });

    parser.on("readable", () => {
      let record;
      while ((record = parser.read())) {
        const stopId = record.stop_id;
        const tripId = record.trip_id;
        const stationId = stopIdToStationId.get(stopId);
        if (!stationId) continue;

        const route = tripIdToRoute.get(tripId);
        if (!route) continue;

        const station = stations.get(stationId);
        if (!station) continue;
        station.routes.add(displayRoute(route));
      }
    });

    parser.on("error", (err) => reject(err));
    parser.on("end", () => resolve());

    fs.createReadStream(stopTimesPath).pipe(parser);
  });
}

async function buildStationIndex() {
  await ensureStaticGtfs();

  const stopsPath = path.join(GTFS_DIR, "stops.txt");
  const routesPath = path.join(GTFS_DIR, "routes.txt");
  const tripsPath = path.join(GTFS_DIR, "trips.txt");

  const stopsRecords = parseSync(fs.readFileSync(stopsPath), {
    columns: true,
    skip_empty_lines: true
  });

  const stations = new Map();
  const stopIdToStationId = new Map();

  stopsRecords.forEach((stop) => {
    if (stop.location_type === "1") {
      const lat = parseNumber(stop.stop_lat);
      const lon = parseNumber(stop.stop_lon);
      stations.set(stop.stop_id, {
        id: stop.stop_id,
        name: stop.stop_name,
        stopIds: [],
        routes: new Set(),
        lat,
        lon,
        coords: lat !== null && lon !== null ? [{ lat, lon }] : []
      });
    }
  });

  stopsRecords.forEach((stop) => {
    if (stop.location_type === "1") return;
    const stationId = stop.parent_station || stop.stop_id;
    if (!stations.has(stationId)) {
      const lat = parseNumber(stop.stop_lat);
      const lon = parseNumber(stop.stop_lon);
      stations.set(stationId, {
        id: stationId,
        name: stop.stop_name,
        stopIds: [],
        routes: new Set(),
        lat,
        lon,
        coords: lat !== null && lon !== null ? [{ lat, lon }] : []
      });
    }
    stopIdToStationId.set(stop.stop_id, stationId);
    const station = stations.get(stationId);
    station.stopIds.push(stop.stop_id);
    const lat = parseNumber(stop.stop_lat);
    const lon = parseNumber(stop.stop_lon);
    if (lat !== null && lon !== null) {
      station.coords.push({ lat, lon });
      if (station.lat === null || station.lon === null) {
        station.lat = lat;
        station.lon = lon;
      }
    }
  });

  const routesRecords = parseSync(fs.readFileSync(routesPath), {
    columns: true,
    skip_empty_lines: true
  });
  const routeIdToShort = new Map();
  routesRecords.forEach((route) => {
    if (route.route_id && route.route_short_name) {
      routeIdToShort.set(route.route_id, route.route_short_name);
    }
  });

  const tripsRecords = parseSync(fs.readFileSync(tripsPath), {
    columns: true,
    skip_empty_lines: true
  });
  const tripIdToRoute = new Map();
  tripsRecords.forEach((trip) => {
    const routeShort =
      routeIdToShort.get(trip.route_id) || trip.route_id || "";
    if (trip.trip_id && routeShort) {
      tripIdToRoute.set(trip.trip_id, routeShort);
    }
  });

  await addRoutesFromStopTimes(stopIdToStationId, tripIdToRoute, stations);

  stations.forEach((station) => {
    if ((station.lat === null || station.lon === null) && station.coords.length) {
      const sum = station.coords.reduce(
        (acc, coord) => ({
          lat: acc.lat + coord.lat,
          lon: acc.lon + coord.lon
        }),
        { lat: 0, lon: 0 }
      );
      station.lat = sum.lat / station.coords.length;
      station.lon = sum.lon / station.coords.length;
    }
  });

  const stationList = Array.from(stations.values())
    .map((station) => ({
      id: station.id,
      name: station.name,
      stopIds: Array.from(new Set(station.stopIds)).sort(),
      routes: Array.from(new Set(station.routes)).sort(),
      lat: station.lat,
      lon: station.lon
    }))
    .filter((station) => station.stopIds.length > 0);
  const stationById = new Map();
  stationList.forEach((station) => {
    stationById.set(station.id, station);
  });

  stationCache = {
    stations: stationList,
    stopIdToStationId,
    stationById
  };

  return stationCache;
}

async function getStationIndex() {
  if (stationCache) return stationCache;
  return buildStationIndex();
}

function getStationById(stationId, stationIndex) {
  const id = String(stationId || "");
  if (!id) return null;
  return stationIndex.stationById.get(id) || null;
}

function getZipcodeIndex() {
  if (zipcodeCache) return zipcodeCache;
  const raw = fs.readFileSync(ZIP_GEOJSON_PATH, "utf8");
  const data = JSON.parse(raw);
  const map = new Map();
  const features = Array.isArray(data.features) ? data.features : [];
  features.forEach((feature) => {
    const props = feature.properties || {};
    const modzcta = props.modzcta || props.MODZCTA || props.zipcode || "";
    if (modzcta) {
      map.set(String(modzcta), feature);
    }
  });
  zipcodeCache = { features, map };
  return zipcodeCache;
}

function extractZipcodeFeature(zipcode) {
  const normalized = String(zipcode).trim();
  const { features, map } = getZipcodeIndex();
  if (map.has(normalized)) return map.get(normalized);
  return (
    features.find((feature) => {
      const props = feature.properties || {};
      const label = String(props.label || "");
      const zcta = String(props.zcta || "");
      return label.includes(normalized) || zcta.includes(normalized);
    }) || null
  );
}

function getGeometryCentroid(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const coords = geometry.coordinates;
  let sumLat = 0;
  let sumLon = 0;
  let count = 0;

  function addPoint(point) {
    if (!Array.isArray(point) || point.length < 2) return;
    const lon = parseNumber(point[0]);
    const lat = parseNumber(point[1]);
    if (lat === null || lon === null) return;
    sumLat += lat;
    sumLon += lon;
    count += 1;
  }

  function walkPoints(points) {
    if (!Array.isArray(points)) return;
    if (typeof points[0] === "number") {
      addPoint(points);
      return;
    }
    points.forEach(walkPoints);
  }

  walkPoints(coords);
  if (!count) return null;
  return { lat: sumLat / count, lon: sumLon / count };
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 3958.8 * c;
}

function getWeatherCondition(code) {
  if (code === undefined || code === null) return "Unknown";
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly Clear";
  if (code === 2) return "Partly Cloudy";
  if (code === 3) return "Overcast";
  if (code >= 45 && code <= 48) return "Foggy";
  if (code >= 51 && code <= 55) return "Drizzle";
  if (code >= 56 && code <= 57) return "Freezing Drizzle";
  if (code >= 61 && code <= 65) return "Rain";
  if (code >= 66 && code <= 67) return "Freezing Rain";
  if (code >= 71 && code <= 75) return "Snow";
  if (code === 77) return "Snow Grains";
  if (code >= 80 && code <= 82) return "Rain Showers";
  if (code >= 85 && code <= 86) return "Snow Showers";
  if (code === 95) return "Thunderstorm";
  if (code >= 96 && code <= 99) return "Thunderstorm w/ Hail";
  return "Unknown";
}

function getWeatherIcon(code) {
  if (code === undefined || code === null) return "☁";
  if (code === 0) return "☀";
  if (code === 1) return "🌤";
  if (code === 2) return "⛅";
  if (code === 3) return "☁";
  if (code >= 45 && code <= 48) return "🌫";
  if (code >= 51 && code <= 57) return "🌧";
  if (code >= 61 && code <= 67) return "🌧";
  if (code >= 71 && code <= 77) return "❄";
  if (code >= 80 && code <= 82) return "🌦";
  if (code >= 85 && code <= 86) return "🌨";
  if (code === 95) return "⛈";
  if (code >= 96 && code <= 99) return "⛈";
  return "☁";
}

async function fetchWeather(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weathercode,wind_speed_10m,relative_humidity_2m"
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", "America/New_York");
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error("Weather request failed.");
  }
  const data = await response.json();
  const current = data.current || {};
  const tempF = Number(current.temperature_2m ?? 0);
  const feelsLikeF = Number(current.apparent_temperature ?? tempF);
  const daily = data.daily || {};
  const dates = daily.time || [];
  const maxF = (daily.temperature_2m_max || []).map((value) => Math.round(value));
  const minF = (daily.temperature_2m_min || []).map((value) => Math.round(value));
  const maxC = maxF.map((value) => Math.round(((value - 32) * 5) / 9));
  const minC = minF.map((value) => Math.round(((value - 32) * 5) / 9));
  const codes = daily.weathercode || [];
  const precipMax = (daily.precipitation_probability_max || []).map((value) =>
    Math.round(value)
  );
  const todayMaxF = maxF[0] ?? Math.round(tempF);
  const todayMinF = minF[0] ?? Math.round(tempF);
  return {
    temperatureF: Math.round(tempF),
    temperatureC: Math.round(((tempF - 32) * 5) / 9),
    feelsLikeF: Math.round(feelsLikeF),
    feelsLikeC: Math.round(((feelsLikeF - 32) * 5) / 9),
    minF: todayMinF,
    maxF: todayMaxF,
    minC: Math.round(((todayMinF - 32) * 5) / 9),
    maxC: Math.round(((todayMaxF - 32) * 5) / 9),
    windSpeed: Math.round(current.wind_speed_10m ?? 0),
    humidity: Math.round(current.relative_humidity_2m ?? 0),
    code: current.weathercode,
    condition: getWeatherCondition(current.weathercode),
    icon: getWeatherIcon(current.weathercode),
    daily: {
      time: dates,
      maxF,
      minF,
      maxC,
      minC,
      codes,
      precipMax
    }
  };
}

async function fetchFeed(feedKey, apiKey) {
  const feed = FEEDS[feedKey];
  if (!feed) return null;

  if (GTFS_PROXY_BASE) {
    const proxyKey = getProxyFeedKey(feedKey);
    const proxyUrl = new URL(`/subway/${proxyKey}/json`, GTFS_PROXY_BASE);
    const response = await fetch(proxyUrl.toString());
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to fetch ${feedKey} feed from proxy: ${response.status} (${text.trim() || "no body"})`
      );
    }
    return response.json();
  }

  const options = apiKey
    ? { headers: { "x-api-key": apiKey } }
    : undefined;
  const response = await fetch(feed.url, options);

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const text = buffer.toString("utf8", 0, 500);
    throw new Error(
      `Failed to fetch ${feedKey} feed: ${response.status} (${text.trim() || "no body"})`
    );
  }

  try {
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  } catch (error) {
    const preview = buffer.toString("utf8", 0, 500).trim();
    throw new Error(
      `Decode failed for ${feedKey} feed (content-type: ${contentType || "unknown"}). ` +
        `Body preview: ${preview || "binary data"}`
    );
  }
}

async function fetchArrivals(stopIds, routeList, apiKey) {
  if (!Array.isArray(stopIds) || stopIds.length === 0) {
    return [];
  }

  const feedKeys = getFeedsForRoutes(routeList);
  const feedMessages = await Promise.all(
    feedKeys.map((feedKey) => fetchFeed(feedKey, apiKey))
  );

  const arrivals = [];
  feedMessages.forEach((message) => {
    if (!message || !message.entity) return;
    message.entity.forEach((entity) => {
      const update = getTripUpdate(entity);
      if (!update || !update.trip) return;
      const routeId = getRouteId(update.trip);
      if (!routeId) return;
      const normalizedRoute = normalizeRoute(routeId);
      if (routeList.length > 0 && !routeList.includes(normalizedRoute)) return;

      const destination = getDestinationName(update);
      getStopTimeUpdates(update).forEach((stopUpdate) => {
        const stopId = getStopId(stopUpdate);
        if (!stopIds.includes(stopId)) return;
        const arrival = getArrivalTime(stopUpdate);
        if (!arrival) return;
        arrivals.push({
          route: displayRoute(routeId),
          arrival: Number(arrival),
          destination: destination || null
        });
      });
    });
  });

  arrivals.sort((a, b) => a.arrival - b.arrival);
  return arrivals.slice(0, 5);
}

async function fetchAlertsFeed(apiKey) {
  const options = apiKey
    ? { headers: { "x-api-key": apiKey } }
    : undefined;
  const response = await fetch(ALERTS_FEED_URL, options);
  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!response.ok) {
    const text = buffer.toString("utf8", 0, 500);
    throw new Error(
      `Failed to fetch alerts feed: ${response.status} (${text.trim() || "no body"})`
    );
  }

  try {
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  } catch (error) {
    const preview = buffer.toString("utf8", 0, 500).trim();
    throw new Error(
      `Decode failed for alerts feed (content-type: ${contentType || "unknown"}). ` +
        `Body preview: ${preview || "binary data"}`
    );
  }
}

app.get("/stations", async (req, res) => {
  try {
    const { stations } = await getStationIndex();
    res.json(stations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/stations/search", async (req, res) => {
  try {
    const { query } = req.query;
    const term = String(query || "").trim().toLowerCase();
    if (!term) {
      return res.status(400).json({ error: "query is required" });
    }
    const { stations } = await getStationIndex();
    const matches = stations
      .filter((station) => station.name.toLowerCase().includes(term))
      .slice(0, 10);
    res.json(matches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/stations/by-id", async (req, res) => {
  try {
    const { stationId } = req.query;
    if (!stationId) {
      return res.status(400).json({ error: "stationId is required" });
    }
    const stationIndex = await getStationIndex();
    const station = getStationById(stationId, stationIndex);
    if (!station) {
      return res.status(404).json({ error: "station not found" });
    }
    res.json(station);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/zipcode-info", async (req, res) => {
  try {
    const { zip } = req.query;
    const normalizedZip = String(zip || "").trim();
    if (!/^\d{5}$/.test(normalizedZip)) {
      return res.status(400).json({ error: "zip must be a 5-digit code" });
    }
    const feature = extractZipcodeFeature(normalizedZip);
    if (!feature) {
      return res.status(404).json({ error: "zipcode not found" });
    }
    const centroid = getGeometryCentroid(feature.geometry);
    if (!centroid) {
      return res.status(500).json({ error: "zipcode geometry not available" });
    }
    const { stations } = await getStationIndex();
    const nearest = stations
      .filter((station) => station.lat !== null && station.lon !== null)
      .map((station) => ({
        ...station,
        distance_miles: haversineMiles(
          centroid.lat,
          centroid.lon,
          station.lat,
          station.lon
        )
      }))
      .sort((a, b) => a.distance_miles - b.distance_miles)
      .slice(0, 5);
    res.json({
      zip: normalizedZip,
      centroid,
      stations: nearest
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/weather", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const latitude = parseNumber(lat);
    const longitude = parseNumber(lon);
    if (latitude === null || longitude === null) {
      return res.status(400).json({ error: "lat and lon are required" });
    }
    const weather = await fetchWeather(latitude, longitude);
    res.json(weather);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/device/setup", async (req, res) => {
  try {
    const { zip, station } = req.query;
    const stationIndex = await getStationIndex();
    if (zip) {
      const normalizedZip = String(zip).trim();
      if (!/^\d{5}$/.test(normalizedZip)) {
        return res.status(400).json({ error: "zip must be a 5-digit code" });
      }
      const feature = extractZipcodeFeature(normalizedZip);
      if (!feature) {
        return res.status(404).json({ error: "zipcode not found" });
      }
      const centroid = getGeometryCentroid(feature.geometry);
      if (!centroid) {
        return res.status(500).json({ error: "zipcode geometry not available" });
      }
      const stations = stationIndex.stations
        .filter((stationItem) => stationItem.lat !== null && stationItem.lon !== null)
        .map((stationItem) => ({
          ...stationItem,
          distance_miles: haversineMiles(
            centroid.lat,
            centroid.lon,
            stationItem.lat,
            stationItem.lon
          )
        }))
        .sort((a, b) => a.distance_miles - b.distance_miles)
        .slice(0, 5);
      return res.json({
        mode: "zip",
        zip: normalizedZip,
        centroid,
        stations
      });
    }

    if (station) {
      const term = String(station).trim().toLowerCase();
      if (!term) {
        return res.status(400).json({ error: "station is required" });
      }
      const matches = stationIndex.stations
        .filter((stationItem) =>
          stationItem.name.toLowerCase().includes(term)
        )
        .slice(0, 10);
      return res.json({
        mode: "station",
        stations: matches
      });
    }

    res.status(400).json({ error: "zip or station is required" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function reverseGeocode(lat, lon) {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "json");
    url.searchParams.set("lat", lat);
    url.searchParams.set("lon", lon);
    url.searchParams.set("zoom", "14");
    url.searchParams.set("addressdetails", "1");
    const headers = {
      "User-Agent": NOMINATIM_USER_AGENT
    };
    if (NOMINATIM_EMAIL) {
      headers["Referer"] = `mailto:${NOMINATIM_EMAIL}`;
    }
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const address = data.address || {};
    const borough =
      address.borough ||
      address.city_district ||
      address.suburb ||
      address.county ||
      address.city;
    return borough ? `${borough}, New York` : "New York, NY";
  } catch (error) {
    return "New York, NY";
  }
}

app.get("/device/status", async (req, res) => {
  try {
    const { stationId, routes } = req.query;
    if (!stationId) {
      return res.status(400).json({ error: "stationId is required" });
    }
    const stationIndex = await getStationIndex();
    const station = getStationById(stationId, stationIndex);
    if (!station) {
      return res.status(404).json({ error: "station not found" });
    }
    const apiKey = process.env.MTA_API_KEY;
    if (!GTFS_PROXY_BASE && !apiKey) {
      return res.status(500).json({
        error:
          "MTA_API_KEY is required to access MTA GTFS-Realtime feeds. Set the environment variable and restart the server."
      });
    }
    const routeList = routes
      ? routes
          .split(",")
          .map((route) => route.trim())
          .filter(Boolean)
          .map(normalizeRoute)
      : [];
    const { north, south } = splitDirections(station.stopIds);
    const [northArrivals, southArrivals, alerts, weather, location] = await Promise.all([
      fetchArrivals(north, routeList, apiKey),
      fetchArrivals(south, routeList, apiKey),
      collectAlerts(
        routeList,
        station.stopIds,
        Array.from(
          new Set(station.stopIds.map((stopId) => stopId.replace(/[NS]$/, "")))
        ),
        apiKey
      ),
      station.lat !== null && station.lon !== null
        ? fetchWeather(station.lat, station.lon)
        : null,
      station.lat !== null && station.lon !== null
        ? reverseGeocode(station.lat, station.lon)
        : "New York, NY"
    ]);
    
    if (weather && location) {
      weather.location = location;
    }
    
    res.json({
      station,
      arrivals: { north: northArrivals, south: southArrivals },
      alerts,
      weather
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dual station endpoint - returns data for two stations at once
app.get("/device/dual-status", async (req, res) => {
  try {
    const { stationId1, stationId2, routes1, routes2 } = req.query;
    if (!stationId1 || !stationId2) {
      return res.status(400).json({ error: "stationId1 and stationId2 are required" });
    }
    const stationIndex = await getStationIndex();
    const station1 = getStationById(stationId1, stationIndex);
    const station2 = getStationById(stationId2, stationIndex);
    
    if (!station1) {
      return res.status(404).json({ error: "station1 not found" });
    }
    if (!station2) {
      return res.status(404).json({ error: "station2 not found" });
    }
    
    const apiKey = process.env.MTA_API_KEY;
    if (!GTFS_PROXY_BASE && !apiKey) {
      return res.status(500).json({
        error:
          "MTA_API_KEY is required to access MTA GTFS-Realtime feeds. Set the environment variable and restart the server."
      });
    }
    
    // Parse route filters for each station separately
    const routeList1 = routes1
      ? routes1
          .split(",")
          .map((route) => route.trim())
          .filter(Boolean)
          .map(normalizeRoute)
      : [];
    
    const routeList2 = routes2
      ? routes2
          .split(",")
          .map((route) => route.trim())
          .filter(Boolean)
          .map(normalizeRoute)
      : [];
    
    // Fetch data for station 1 with its own route filter
    const { north: north1, south: south1 } = splitDirections(station1.stopIds);
    const [northArrivals1, southArrivals1, alerts1] = await Promise.all([
      fetchArrivals(north1, routeList1, apiKey),
      fetchArrivals(south1, routeList1, apiKey),
      collectAlerts(
        routeList1,
        station1.stopIds,
        Array.from(
          new Set(station1.stopIds.map((stopId) => stopId.replace(/[NS]$/, "")))
        ),
        apiKey
      )
    ]);
    
    // Fetch data for station 2 with its own route filter
    const { north: north2, south: south2 } = splitDirections(station2.stopIds);
    const [northArrivals2, southArrivals2, alerts2] = await Promise.all([
      fetchArrivals(north2, routeList2, apiKey),
      fetchArrivals(south2, routeList2, apiKey),
      collectAlerts(
        routeList2,
        station2.stopIds,
        Array.from(
          new Set(station2.stopIds.map((stopId) => stopId.replace(/[NS]$/, "")))
        ),
        apiKey
      )
    ]);
    
    // Fetch weather and location (use station1's location)
    const [weather, location] = await Promise.all([
      station1.lat !== null && station1.lon !== null
        ? fetchWeather(station1.lat, station1.lon)
        : null,
      station1.lat !== null && station1.lon !== null
        ? reverseGeocode(station1.lat, station1.lon)
        : "New York, NY"
    ]);
    
    if (weather && location) {
      weather.location = location;
    }
    
    res.json({
      station1: {
        station: station1,
        arrivals: { north: northArrivals1, south: southArrivals1 },
        alerts: alerts1
      },
      station2: {
        station: station2,
        arrivals: { north: northArrivals2, south: southArrivals2 },
        alerts: alerts2
      },
      weather
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/reverse-geocode", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const latitude = parseNumber(lat);
    const longitude = parseNumber(lon);
    if (latitude === null || longitude === null) {
      return res.status(400).json({ error: "lat and lon are required" });
    }
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "json");
    url.searchParams.set("lat", latitude);
    url.searchParams.set("lon", longitude);
    url.searchParams.set("zoom", "14");
    url.searchParams.set("addressdetails", "1");
    const headers = {
      "User-Agent": NOMINATIM_USER_AGENT
    };
    if (NOMINATIM_EMAIL) {
      headers["Referer"] = `mailto:${NOMINATIM_EMAIL}`;
    }
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Reverse geocode failed: ${response.status} (${text.trim() || "no body"})`
      );
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/arrivals", async (req, res) => {
  try {
    const { stopId, routes } = req.query;
    if (!stopId) {
      return res.status(400).json({ error: "stopId is required" });
    }

    const apiKey = process.env.MTA_API_KEY;
    if (!GTFS_PROXY_BASE && !apiKey) {
      return res.status(500).json({
        error:
          "MTA_API_KEY is required to access MTA GTFS-Realtime feeds. Set the environment variable and restart the server."
      });
    }

    const routeList = routes
      ? routes
          .split(",")
          .map((route) => route.trim())
          .filter(Boolean)
          .map(normalizeRoute)
      : [];

    const feedKeys = getFeedsForRoutes(routeList);
    const feedMessages = await Promise.all(
      feedKeys.map((feedKey) => fetchFeed(feedKey, apiKey))
    );

    const arrivals = [];
    feedMessages.forEach((message) => {
      if (!message || !message.entity) return;
      message.entity.forEach((entity) => {
        const update = getTripUpdate(entity);
        if (!update || !update.trip) return;
        const routeId = getRouteId(update.trip);
        if (!routeId) return;
        const normalizedRoute = normalizeRoute(routeId);
        if (routeList.length > 0 && !routeList.includes(normalizedRoute)) return;

          const destination = getDestinationName(update);
          getStopTimeUpdates(update).forEach((stopUpdate) => {
          if (getStopId(stopUpdate) !== stopId) return;
          const arrival = getArrivalTime(stopUpdate);
          if (!arrival) return;
          arrivals.push({
            route: displayRoute(routeId),
              arrival: Number(arrival),
              destination: destination || null
          });
        });
      });
    });

    arrivals.sort((a, b) => a.arrival - b.arrival);
    res.json({ stopId, arrivals: arrivals.slice(0, 5) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const { routes, stopIds, stationIds } = req.query;
    const apiKey = process.env.MTA_API_KEY;
    if (!GTFS_PROXY_BASE && !apiKey) {
      return res.status(500).json({
        error:
          "MTA_API_KEY is required to access MTA GTFS-Realtime feeds. Set the environment variable and restart the server."
      });
    }

    const routeList = routes
      ? routes
          .split(",")
          .map((route) => route.trim())
          .filter(Boolean)
          .map(normalizeRoute)
      : [];
    const stopList = stopIds
      ? stopIds
          .split(",")
          .map((stopId) => stopId.trim())
          .filter(Boolean)
      : [];
    const stationList = stationIds
      ? stationIds
          .split(",")
          .map((stationId) => stationId.trim())
          .filter(Boolean)
      : [];

    const alerts = await collectAlerts(
      routeList,
      stopList,
      stationList,
      apiKey
    );

    res.json({
      routes: routeList,
      stopIds: stopList,
      alerts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/time", (req, res) => {
  const now = new Date();
  
  // Convert to NYC timezone (America/New_York)
  const nycTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  
  res.json({
    timestamp: Math.floor(now.getTime() / 1000),
    timezoneOffset: -5 * 3600, // NYC is UTC-5 (EST) or UTC-4 (EDT), using -5 for consistency
    iso: now.toISOString(),
    hour: nycTime.getHours(),
    minute: nycTime.getMinutes(),
    second: nycTime.getSeconds(),
    formatted: now.toLocaleTimeString('en-US', { 
      timeZone: 'America/New_York',
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    })
  });
});

// ==================== USER MANAGEMENT ====================

const USERS_PATH = path.join(__dirname, "users.json");

function loadUsers() {
  try {
    const data = fs.readFileSync(USERS_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading users:', error);
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving users:', error);
    return false;
  }
}

// POST /user/register - Register device with username
app.post("/user/register", (req, res) => {
  try {
    const { device, name } = req.body;
    
    if (!device || !name) {
      return res.status(400).json({ 
        error: "device and name are required" 
      });
    }
    
    const users = loadUsers();
    users[device] = {
      name: String(name).trim(),
      registeredAt: new Date().toISOString()
    };
    
    if (!saveUsers(users)) {
      return res.status(500).json({ error: "Failed to save user" });
    }
    
    res.json({
      success: true,
      device,
      name: users[device].name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /user/info/:device - Get user info by device ID
app.get("/user/info/:device", (req, res) => {
  try {
    const { device } = req.params;
    const users = loadUsers();
    const userInfo = users[device];
    
    if (!userInfo) {
      return res.status(404).json({ 
        error: "User not found",
        registered: false
      });
    }
    
    res.json({
      device,
      name: userInfo.name,
      registeredAt: userInfo.registeredAt,
      registered: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== DAILY QUIZ ENDPOINTS ====================

const QUIZZES_PATH = path.join(__dirname, "quizzes.json");
const LEADERBOARD_PATH = path.join(__dirname, "leaderboard.json");

function getTodayDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadQuizzes() {
  try {
    const data = fs.readFileSync(QUIZZES_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading quizzes:', error);
    return {};
  }
}

function loadLeaderboard() {
  try {
    const data = fs.readFileSync(LEADERBOARD_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading leaderboard:', error);
    return {};
  }
}

function saveLeaderboard(leaderboard) {
  try {
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(leaderboard, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving leaderboard:', error);
    return false;
  }
}

// GET /quiz/daily - Get today's quiz question
app.get("/quiz/daily", (req, res) => {
  try {
    const today = getTodayDateKey();
    const quizzes = loadQuizzes();
    const todayQuiz = quizzes[today];
    
    if (!todayQuiz) {
      return res.status(404).json({ 
        error: "No quiz available for today",
        date: today 
      });
    }
    
    res.json({
      date: today,
      question: todayQuiz.question,
      answerLength: todayQuiz.answer.length,
      category: todayQuiz.category
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /quiz/submit - Submit answer and time
app.post("/quiz/submit", (req, res) => {
  try {
    const { device, answer, time } = req.body;
    
    if (!device || !answer || time === undefined) {
      return res.status(400).json({ 
        error: "device, answer, and time are required" 
      });
    }
    
    // Get user name from users.json
    const users = loadUsers();
    const userInfo = users[device];
    if (!userInfo) {
      return res.status(404).json({ 
        error: "User not registered. Please register first." 
      });
    }
    const name = userInfo.name;
    
    const today = getTodayDateKey();
    const quizzes = loadQuizzes();
    const todayQuiz = quizzes[today];
    
    if (!todayQuiz) {
      return res.status(404).json({ 
        error: "No quiz available for today" 
      });
    }
    
    // Validate answer (case-insensitive, remove spaces)
    const normalizedAnswer = String(answer).toUpperCase().replace(/\s+/g, '');
    const correctAnswer = String(todayQuiz.answer).toUpperCase().replace(/\s+/g, '');
    const isCorrect = normalizedAnswer === correctAnswer;
    
    if (!isCorrect) {
      return res.json({
        correct: false,
        message: "Incorrect answer. Try again!",
        correctAnswer: todayQuiz.answer
      });
    }
    
    // Load leaderboard and add/update entry
    const leaderboard = loadLeaderboard();
    if (!leaderboard[today]) {
      leaderboard[today] = [];
    }
    
    // Check if device already completed today
    const existingIndex = leaderboard[today].findIndex(entry => entry.device === device);
    
    if (existingIndex >= 0) {
      // Update if new time is faster
      if (time < leaderboard[today][existingIndex].time) {
        leaderboard[today][existingIndex] = {
          device,
          name,
          time: parseFloat(time),
          timestamp: new Date().toISOString()
        };
      }
    } else {
      // Add new entry
      leaderboard[today].push({
        device,
        name,
        time: parseFloat(time),
        timestamp: new Date().toISOString()
      });
    }
    
    // Sort by time (fastest first)
    leaderboard[today].sort((a, b) => a.time - b.time);
    
    // Save leaderboard
    if (!saveLeaderboard(leaderboard)) {
      return res.status(500).json({ error: "Failed to save leaderboard" });
    }
    
    // Find user's rank
    const rank = leaderboard[today].findIndex(entry => entry.device === device) + 1;
    
    res.json({
      correct: true,
      message: "Correct! Well done!",
      rank,
      time: parseFloat(time),
      totalEntries: leaderboard[today].length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /quiz/leaderboard - Get today's leaderboard
app.get("/quiz/leaderboard", (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || getTodayDateKey();
    const leaderboard = loadLeaderboard();
    const dayLeaderboard = leaderboard[targetDate] || [];
    
    res.json({
      date: targetDate,
      entries: dayLeaderboard.slice(0, 10)  // Top 10
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /quiz/status/:device - Check if device completed today's quiz
app.get("/quiz/status/:device", (req, res) => {
  try {
    const { device } = req.params;
    const today = getTodayDateKey();
    const quizzes = loadQuizzes();
    const leaderboard = loadLeaderboard();
    
    const todayQuiz = quizzes[today];
    const available = !!todayQuiz;
    
    const dayLeaderboard = leaderboard[today] || [];
    const completed = dayLeaderboard.some(entry => entry.device === device);
    
    res.json({
      date: today,
      available,
      completed,
      category: todayQuiz ? todayQuiz.category : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to receive crash logs from ESP32
app.post('/device/crash-log', (req, res) => {
  try {
    const crashLog = req.body;
    console.log('\n========================================');
    console.log('ESP32 CRASH LOG RECEIVED:');
    console.log('========================================');
    console.log(crashLog);
    console.log('========================================\n');
    
    // Save to file
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.appendFileSync('crash_logs.txt', `\n[${timestamp}]\n${crashLog}\n`);
    
    res.json({ success: true, message: 'Crash log received' });
  } catch (error) {
    console.error('Error receiving crash log:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to read crash logs
app.get('/api/crash-logs', (req, res) => {
  try {
    const fs = require('fs');
    
    if (!fs.existsSync('crash_logs.txt')) {
      return res.json({ logs: '', count: 0 });
    }
    
    const logs = fs.readFileSync('crash_logs.txt', 'utf8');
    const crashCount = (logs.match(/========== CRASH LOG ==========/g) || []).length;
    
    res.json({ 
      logs: logs,
      count: crashCount,
      fileSize: Buffer.byteLength(logs, 'utf8')
    });
  } catch (error) {
    console.error('Error reading crash logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to clear crash logs
app.delete('/api/crash-logs', (req, res) => {
  try {
    const fs = require('fs');
    
    if (fs.existsSync('crash_logs.txt')) {
      fs.unlinkSync('crash_logs.txt');
      console.log('Crash logs cleared');
    }
    
    res.json({ success: true, message: 'Crash logs cleared' });
  } catch (error) {
    console.error('Error clearing crash logs:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`MTA arrivals backend running on port ${PORT}`);
});
