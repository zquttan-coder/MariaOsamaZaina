import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

const defaultUnknownRouteSummaryIntervalMs = 5 * 60 * 1000;
const configuredUnknownRouteSummaryIntervalMs = Number(
  process.env.API_UNKNOWN_ROUTE_SUMMARY_INTERVAL_MS ??
    defaultUnknownRouteSummaryIntervalMs,
);

if (
  !Number.isInteger(configuredUnknownRouteSummaryIntervalMs) ||
  configuredUnknownRouteSummaryIntervalMs <= 0
) {
  throw new Error(
    "API_UNKNOWN_ROUTE_SUMMARY_INTERVAL_MS must be a positive integer.",
  );
}

function readPositiveIntegerSetting(
  settingName: string,
  defaultValue: number,
): number {
  const configuredValue = Number(process.env[settingName] ?? defaultValue);
  if (!Number.isInteger(configuredValue) || configuredValue <= 0) {
    throw new Error(`${settingName} must be a positive integer.`);
  }
  return configuredValue;
}

const unknownRouteSpikeMinRequests = readPositiveIntegerSetting(
  "API_UNKNOWN_ROUTE_SPIKE_MIN_REQUESTS",
  25,
);
const unknownRoutePatternSpikeMinRequests = readPositiveIntegerSetting(
  "API_UNKNOWN_ROUTE_PATTERN_SPIKE_MIN_REQUESTS",
  10,
);
const unknownRouteSpikeMultiplier = Number(
  process.env.API_UNKNOWN_ROUTE_SPIKE_MULTIPLIER ?? 3,
);

if (
  !Number.isFinite(unknownRouteSpikeMultiplier) ||
  unknownRouteSpikeMultiplier <= 1
) {
  throw new Error("API_UNKNOWN_ROUTE_SPIKE_MULTIPLIER must be greater than 1.");
}

type UnknownRouteCount = {
  method: string;
  path: string;
  count: number;
};

const uuidPathSegmentPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const compactUuidPathSegmentPattern = /^[0-9a-f]{32}$/i;
const objectIdPathSegmentPattern = /^[0-9a-f]{24}$/i;
const ulidPathSegmentPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const cuidPathSegmentPattern = /^c[a-z0-9]{24}$/i;

function isUnknownRouteIdentifier(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    uuidPathSegmentPattern.test(segment) ||
    compactUuidPathSegmentPattern.test(segment) ||
    objectIdPathSegmentPattern.test(segment) ||
    ulidPathSegmentPattern.test(segment) ||
    cuidPathSegmentPattern.test(segment)
  );
}

function getUnknownRoutePattern(path: string): string {
  const pathWithoutQuery = path.split("?")[0];
  return pathWithoutQuery
    .split("/")
    .map((segment) => (isUnknownRouteIdentifier(segment) ? ":id" : segment))
    .join("/");
}

let unknownRouteCounts = new Map<string, UnknownRouteCount>();
let unknownRouteWindowStartedAt = Date.now();
let unknownRouteRequestCount = 0;
let previousUnknownRouteCounts = new Map<string, number>();
let previousUnknownRouteRequestCount = 0;

function isUnknownRouteSpike(
  requestCount: number,
  previousRequestCount: number,
  minimumRequestCount: number,
): boolean {
  return (
    requestCount >= minimumRequestCount &&
    (previousRequestCount === 0 ||
      requestCount >= previousRequestCount * unknownRouteSpikeMultiplier)
  );
}

function getIncreaseFactor(
  requestCount: number,
  previousRequestCount: number,
): number | null {
  return previousRequestCount === 0
    ? null
    : Math.round((requestCount / previousRequestCount) * 100) / 100;
}

export function recordUnknownApiRoute(method: string, path: string): void {
  unknownRouteRequestCount += 1;
  const pattern = getUnknownRoutePattern(path);
  const key = `${method}\u0000${pattern}`;
  const current = unknownRouteCounts.get(key);

  if (current) {
    current.count += 1;
    return;
  }

  unknownRouteCounts.set(key, { method, path: pattern, count: 1 });
}

function emitUnknownRouteSummary(): void {
  const windowEndedAt = Date.now();
  const routeCounts = unknownRouteCounts;
  const windowStartedAt = unknownRouteWindowStartedAt;
  const requestCount = unknownRouteRequestCount;
  unknownRouteCounts = new Map();
  unknownRouteWindowStartedAt = windowEndedAt;
  unknownRouteRequestCount = 0;

  if (routeCounts.size === 0) {
    previousUnknownRouteCounts = new Map();
    previousUnknownRouteRequestCount = 0;
    return;
  }

  if (
    isUnknownRouteSpike(
      requestCount,
      previousUnknownRouteRequestCount,
      unknownRouteSpikeMinRequests,
    )
  ) {
    logger.warn(
      {
        event: "api.route_not_found.spike",
        scope: "all_routes",
        windowStartedAt: new Date(windowStartedAt).toISOString(),
        windowEndedAt: new Date(windowEndedAt).toISOString(),
        windowMs: windowEndedAt - windowStartedAt,
        requestCount,
        previousRequestCount: previousUnknownRouteRequestCount,
        increaseFactor: getIncreaseFactor(
          requestCount,
          previousUnknownRouteRequestCount,
        ),
        minimumRequestCount: unknownRouteSpikeMinRequests,
        multiplier: unknownRouteSpikeMultiplier,
        uniqueRouteCount: routeCounts.size,
      },
      "Unknown API route traffic spike",
    );
  }

  for (const [key, route] of routeCounts) {
    const previousRequestCount = previousUnknownRouteCounts.get(key) ?? 0;
    if (
      !isUnknownRouteSpike(
        route.count,
        previousRequestCount,
        unknownRoutePatternSpikeMinRequests,
      )
    ) {
      continue;
    }

    logger.warn(
      {
        event: "api.route_not_found.spike",
        scope: "route_pattern",
        windowStartedAt: new Date(windowStartedAt).toISOString(),
        windowEndedAt: new Date(windowEndedAt).toISOString(),
        windowMs: windowEndedAt - windowStartedAt,
        method: route.method,
        path: route.path,
        requestCount: route.count,
        previousRequestCount,
        increaseFactor: getIncreaseFactor(route.count, previousRequestCount),
        minimumRequestCount: unknownRoutePatternSpikeMinRequests,
        multiplier: unknownRouteSpikeMultiplier,
      },
      "Unknown API route pattern spike",
    );
  }

  const routes = [...routeCounts.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.method.localeCompare(b.method) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, 50);

  logger.info(
    {
      event: "api.route_not_found.summary",
      windowStartedAt: new Date(windowStartedAt).toISOString(),
      windowEndedAt: new Date(windowEndedAt).toISOString(),
      windowMs: windowEndedAt - windowStartedAt,
      requestCount,
      uniqueRouteCount: routeCounts.size,
      routes,
    },
    "Unknown API route summary",
  );

  previousUnknownRouteCounts = new Map(
    [...routeCounts].map(([key, route]) => [key, route.count]),
  );
  previousUnknownRouteRequestCount = requestCount;
}

const unknownRouteSummaryTimer = setInterval(
  emitUnknownRouteSummary,
  configuredUnknownRouteSummaryIntervalMs,
);
unknownRouteSummaryTimer.unref();
