import type { AuthUser } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  clearSession,
  getSession,
  getSessionId,
  refreshSessionIfExpired,
  SessionRefreshUnavailableError,
  type SessionData,
} from "../lib/auth";

declare global {
  namespace Express {
    interface User extends AuthUser {}
    interface Request {
      isAuthenticated(): this is AuthedRequest;
      user?: User | undefined;
    }
    interface AuthedRequest {
      user: User;
    }
  }
}

async function refreshIfExpired(
  sid: string,
  session: SessionData,
): Promise<SessionData | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at) return session;
  return refreshSessionIfExpired(sid);
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    next();
    return;
  }

  let refreshed: SessionData | null;
  try {
    refreshed = await refreshIfExpired(sid, session);
  } catch (error) {
    if (!(error instanceof SessionRefreshUnavailableError)) throw error;

    res
      .set("Retry-After", "30")
      .status(503)
      .json({ error: "Authentication temporarily unavailable" });
    return;
  }

  if (!refreshed) {
    // Expired or rejected sessions are removed while holding the session row
    // lock in refreshSessionIfExpired; don't delete a newer concurrent update.
    await clearSession(res);
    next();
    return;
  }

  const [currentUser] = await db
    .select({
      role: usersTable.role,
    })
    .from(usersTable)
    .where(eq(usersTable.id, refreshed.user.id));

  if (!currentUser) {
    await clearSession(res, sid);
    next();
    return;
  }

  req.user = { ...refreshed.user, role: currentUser.role };
  next();
}