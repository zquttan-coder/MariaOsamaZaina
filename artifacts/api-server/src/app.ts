import express, { type ErrorRequestHandler, type Express } from "express";
import cors, { type CorsOptionsDelegate } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger, recordUnknownApiRoute } from "./lib/logger";
import cookieParser from "cookie-parser";
import { authMiddleware } from "./middlewares/authMiddleware";
import { csrfProtection } from "./middlewares/csrfProtection";
import type { Request } from "express";

const app: Express = express();

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim();
}

function parseOrigin(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function getApplicationOrigin(req: Request): string | null {
  const host = req.get("host");
  const protocol =
    firstForwardedValue(req.get("x-forwarded-proto")) ?? req.protocol;
  if (!host) return null;

  try {
    const url = new URL(`${protocol}://${host}`);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const corsOptions: CorsOptionsDelegate<Request> = (req, callback) => {
  const requestOrigin = parseOrigin(req.get("origin"));
  const applicationOrigin = getApplicationOrigin(req);
  if (requestOrigin && requestOrigin === applicationOrigin) {
    callback(null, { origin: applicationOrigin, credentials: true });
    return;
  }
  callback(null, { origin: false });
};

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);
app.use(csrfProtection);

app.use("/api", router);

app.use("/api", (req, res) => {
  const path = req.originalUrl.split("?")[0];
  logger.warn(
    {
      event: "api.route_not_found",
      method: req.method,
      path,
      status: 404,
    },
    "Unknown API route",
  );
  recordUnknownApiRoute(req.method, path);
  res.status(404).json({ error: "API route not found" });
});

function isMalformedJsonError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

function isPayloadTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}

const handleApiError: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isMalformedJsonError(error)) {
    res.status(400).json({ error: "Malformed JSON request body" });
    return;
  }

  if (isPayloadTooLargeError(error)) {
    res.status(413).json({ error: "Request body too large" });
    return;
  }

  logger.error(
    {
      err: error,
      method: req.method,
      url: req.path,
    },
    "Unhandled API request error",
  );
  res.status(500).json({ error: "Internal server error" });
};

app.use(handleApiError);

export default app;
