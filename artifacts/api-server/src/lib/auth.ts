import crypto from "node:crypto";
import type { AuthUser } from "@workspace/api-zod";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import * as oidc from "openid-client";

export const ISSUER_URL = process.env.ISSUER_URL ?? "https://replit.com/oidc";
export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

export class SessionRefreshUnavailableError extends Error {
  constructor() {
    super("Session refresh provider temporarily unavailable");
    this.name = "SessionRefreshUnavailableError";
  }
}

let oidcConfig: oidc.Configuration | null = null;

export async function getOidcConfig(): Promise<oidc.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await oidc.discovery(new URL(ISSUER_URL), process.env.REPL_ID!);
  }
  return oidcConfig;
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function refreshSessionIfExpired(
  sid: string,
): Promise<SessionData | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sid, sid))
      .for("update");

    if (!row || row.expire < new Date()) {
      if (row) await tx.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
      return null;
    }

    const session = row.sess as unknown as SessionData;
    const now = Math.floor(Date.now() / 1000);
    if (!session.expires_at || now <= session.expires_at) return session;

    if (!session.refresh_token) {
      await tx.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
      return null;
    }

    let tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
    try {
      tokens = await oidc.refreshTokenGrant(
        await getOidcConfig(),
        session.refresh_token,
      );
    } catch (error) {
      if (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") {
        await tx.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
        return null;
      }
      throw new SessionRefreshUnavailableError();
    }

    session.access_token = tokens.access_token;
    session.refresh_token = tokens.refresh_token ?? session.refresh_token;
    session.expires_at = tokens.expiresIn()
      ? now + tokens.expiresIn()!
      : session.expires_at;

    await tx
      .update(sessionsTable)
      .set({
        sess: session as unknown as Record<string, unknown>,
        expire: new Date(Date.now() + SESSION_TTL),
      })
      .where(eq(sessionsTable.sid, sid));
    return session;
  });
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return req.cookies?.[SESSION_COOKIE];
}