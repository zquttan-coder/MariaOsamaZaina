import {
  GetCurrentAuthUserResponse,
  type AuthUser,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import {
  clearSession,
  createSession,
  getOidcConfig,
  getSessionId,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";
import { requireSameOrigin } from "../middlewares/csrfProtection";

const router: IRouter = Router();
const OIDC_COOKIE_TTL = 10 * 60 * 1000;
const OIDC_COOKIE_NAMES = ["code_verifier", "nonce", "state", "return_to"] as const;

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function setOidcCookie(res: Response, name: string, value: string): void {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
  });
}

function clearOidcCookies(res: Response): void {
  for (const name of OIDC_COOKIE_NAMES) {
    res.clearCookie(name, { path: "/" });
  }
}

function rejectCallback(res: Response): void {
  clearOidcCookies(res);
  res.redirect("/");
}

function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function instructorEmails(): Set<string> {
  return new Set(
    (process.env.INSTRUCTOR_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function upsertUser(claims: Record<string, unknown>) {
  const email = typeof claims.email === "string" ? claims.email : null;
  const userData = {
    id: String(claims.sub),
    email,
    firstName: typeof claims.first_name === "string" ? claims.first_name : null,
    lastName: typeof claims.last_name === "string" ? claims.last_name : null,
    profileImageUrl:
      typeof (claims.profile_image_url ?? claims.picture) === "string"
        ? String(claims.profile_image_url ?? claims.picture)
        : null,
  };
  const normalizedEmail = email?.toLowerCase();
  const bootstrapRole = normalizedEmail && adminEmails().has(normalizedEmail)
    ? "admin"
    : normalizedEmail && instructorEmails().has(normalizedEmail)
      ? "instructor"
      : "learner";

  const [user] = await db
    .insert(usersTable)
    .values({ ...userData, role: bootstrapRole })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        ...userData,
        ...(bootstrapRole === "admin" ? { role: "admin" as const } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  return user;
}

function authUser(user: {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  role: "learner" | "instructor" | "admin";
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    profileImageUrl: user.profileImageUrl,
    role: user.role,
  };
}

router.get("/auth/user", (req, res): void => {
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

router.get("/login", async (req, res): Promise<void> => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });

  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", getSafeReturnTo(req.query.returnTo));
  res.redirect(redirectTo.href);
});

router.get("/callback", async (req, res): Promise<void> => {
  try {
    const codeVerifier = req.cookies?.code_verifier;
    const nonce = req.cookies?.nonce;
    const expectedState = req.cookies?.state;
    if (!codeVerifier || !nonce || !expectedState) {
      rejectCallback(res);
      return;
    }

    const config = await getOidcConfig();
    const callbackUrl = `${getOrigin(req)}/api/callback`;
    const currentUrl = new URL(
      `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
    );
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || claims.sub.trim().length === 0) {
      rejectCallback(res);
      return;
    }

    const returnTo = getSafeReturnTo(req.cookies?.return_to);
    clearOidcCookies(res);
    const dbUser = await upsertUser(claims as unknown as Record<string, unknown>);
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = tokens.expiresIn();
    const sessionData: SessionData = {
      user: authUser(dbUser),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresIn ? now + expiresIn : claims.exp,
    };
    setSessionCookie(res, await createSession(sessionData));
    res.redirect(returnTo);
  } catch {
    // Callback parameters and provider errors can contain credentials. Keep failures out of logs and responses.
    rejectCallback(res);
  }
});

router.get("/logout", requireSameOrigin, async (req, res): Promise<void> => {
  const config = await getOidcConfig();
  const origin = getOrigin(req);
  const returnTo = getSafeReturnTo(req.query.returnTo);
  await clearSession(res, getSessionId(req));
  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: new URL(returnTo, `${origin}/`).href,
  });
  res.redirect(endSessionUrl.href);
});

export default router;