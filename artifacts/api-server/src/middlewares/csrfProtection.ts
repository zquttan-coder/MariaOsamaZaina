import type { NextFunction, Request, Response } from "express";

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue?.split(",")[0]?.trim();
}

function applicationOrigin(req: Request): string | null {
  const protocol =
    firstHeaderValue(req.headers["x-forwarded-proto"]) ?? req.protocol;
  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ?? req.get("host");
  if (!host) return null;

  try {
    const url = new URL(`${protocol}://${host}`);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function originFromHeader(value: string, header: "origin" | "referer"): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    if (
      header === "origin" &&
      (url.pathname !== "/" || url.search || url.hash)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(req: Request): boolean {
  const expectedOrigin = applicationOrigin(req);
  if (!expectedOrigin) return false;

  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = req.get("origin");
  if (origin !== undefined) {
    return originFromHeader(origin, "origin") === expectedOrigin;
  }

  const referer = req.get("referer");
  if (referer !== undefined) {
    return originFromHeader(referer, "referer") === expectedOrigin;
  }

  return false;
}

export function requireSameOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: "Same-origin request required" });
    return;
  }
  next();
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user || !STATE_CHANGING_METHODS.has(req.method)) {
    next();
    return;
  }
  requireSameOrigin(req, res, next);
}