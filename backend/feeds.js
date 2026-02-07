const FEEDS = {
  ACE: {
    routes: ["A", "C", "E"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-ace"
  },
  BDFM: {
    routes: ["B", "D", "F", "M"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-bdfm"
  },
  NQRW: {
    routes: ["N", "Q", "R", "W"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-nqrw"
  },
  G: {
    routes: ["G"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-g"
  },
  JZ: {
    routes: ["J", "Z"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-jz"
  },
  L: {
    routes: ["L"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-l"
  },
  "123": {
    routes: ["1", "2", "3", "S"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs"
  },
  "456": {
    routes: ["4", "5", "6"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-4"
  },
  "7": {
    routes: ["7"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-7"
  },
  SIR: {
    routes: ["SI", "SIR"],
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-si"
  }
};

const ROUTE_TO_FEED = Object.entries(FEEDS).reduce((acc, [feedKey, cfg]) => {
  cfg.routes.forEach((route) => {
    acc[route] = feedKey;
  });
  return acc;
}, {});

function getFeedsForRoutes(routes) {
  if (!routes || routes.length === 0) {
    return Object.keys(FEEDS);
  }
  const keys = new Set();
  routes.forEach((route) => {
    const key = ROUTE_TO_FEED[route];
    if (key) {
      keys.add(key);
    }
  });
  return Array.from(keys);
}

module.exports = {
  FEEDS,
  ROUTE_TO_FEED,
  getFeedsForRoutes
};
