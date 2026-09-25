import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, createSign, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Pool } from "pg";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function createIdToken(privateKey, issuer, clientId, claims) {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: issuer,
      aud: clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startOidcProvider() {
  const directory = mkdtempSync(`${tmpdir()}/pmp-oidc-`);
  const keyPath = `${directory}/key.pem`;
  const certPath = `${directory}/cert.pem`;
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );

  const privateKey = createPrivateKey(readFileSync(keyPath));
  const publicJwk = {
    ...createPublicKey(privateKey).export({ format: "jwk" }),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
  const authorizationCodes = new Map();
  let refreshGrantCalls = 0;
  let refreshTokenRotation = null;
  let nextRefreshError = null;
  let dropNextRefreshConnection = false;
  let nextTokenError = null;
  let nextNonceOverride;
  let omitNextSubject = false;
  let issuer;

  const server = createHttpsServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    async (request, response) => {
      const url = new URL(request.url, issuer);
      response.setHeader("cache-control", "no-store");

      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            end_session_endpoint: `${issuer}/logout`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/authorize") {
        const code = randomUUID();
        authorizationCodes.set(code, {
          clientId: url.searchParams.get("client_id"),
          codeChallenge: url.searchParams.get("code_challenge"),
          nonce: url.searchParams.get("nonce"),
          redirectUri: url.searchParams.get("redirect_uri"),
        });
        const redirectUri = new URL(url.searchParams.get("redirect_uri"));
        redirectUri.searchParams.set("code", code);
        redirectUri.searchParams.set("state", url.searchParams.get("state"));
        response.writeHead(302, { location: redirectUri.href });
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/token") {
        const body = new URLSearchParams(await readBody(request));
        if (body.get("grant_type") === "refresh_token") {
          refreshGrantCalls += 1;
          if (dropNextRefreshConnection) {
            dropNextRefreshConnection = false;
            response.socket.destroy();
            return;
          }
          if (nextRefreshError) {
            const error = nextRefreshError;
            nextRefreshError = null;
            response.writeHead(error.status, { "content-type": "application/json" });
            response.end(JSON.stringify(error.body));
            return;
          }
          if (
            refreshTokenRotation &&
            body.get("refresh_token") === refreshTokenRotation.current
          ) {
            const rotation = refreshTokenRotation;
            rotation.current = rotation.next;
            if (rotation.responseDelayMs) {
              await new Promise((resolve) =>
                setTimeout(resolve, rotation.responseDelayMs),
              );
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                access_token: "rotated-access-token",
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: rotation.next,
              }),
            );
            return;
          }
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }

        const code = authorizationCodes.get(body.get("code"));
        const codeVerifier = body.get("code_verifier");

        if (
          !code ||
          body.get("client_id") !== code.clientId ||
          body.get("redirect_uri") !== code.redirectUri ||
          !codeVerifier
        ) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }

        const verifierDigest = cryptoDigest(codeVerifier);
        if (verifierDigest !== code.codeChallenge) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }

        if (nextTokenError) {
          const error = nextTokenError;
          nextTokenError = null;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify(error));
          return;
        }

        authorizationCodes.delete(body.get("code"));
        const claims = {
          email: "instructor@example.test",
          first_name: "OIDC",
          last_name: "Instructor",
          nonce: nextNonceOverride ?? code.nonce,
        };
        if (!omitNextSubject) claims.sub = "oidc-instructor-1";
        nextNonceOverride = undefined;
        omitNextSubject = false;
        const idToken = createIdToken(privateKey, issuer, code.clientId, claims);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "oidc-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: idToken,
          }),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/jwks") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/logout") {
        const redirectUri = url.searchParams.get("post_logout_redirect_uri");
        response.writeHead(302, { location: redirectUri });
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    },
  );

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  issuer = `https://127.0.0.1:${port}`;

  return {
    issuer,
    getRefreshGrantCalls: () => refreshGrantCalls,
    setRefreshTokenRotation: (
      initialToken,
      nextToken,
      responseDelayMs = 0,
    ) => {
      refreshTokenRotation = {
        current: initialToken,
        next: nextToken,
        responseDelayMs,
      };
    },
    setNextRefreshError: (status, body) => {
      nextRefreshError = { status, body };
    },
    dropNextRefreshConnection: () => {
      dropNextRefreshConnection = true;
    },
    setNextTokenError: (error) => {
      nextTokenError = error;
    },
    setNextNonceOverride: (nonce) => {
      nextNonceOverride = nonce;
    },
    omitNextSubject: () => {
      omitNextSubject = true;
    },
    async stop() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function cryptoDigest(value) {
  return createHash("sha256").update(value).digest("base64url");
}

async function unusedPort() {
  const server = (await import("node:http")).createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startApi(provider) {
  const port = await unusedPort();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const child = spawn("node", ["--enable-source-maps", "dist/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      ISSUER_URL: provider.issuer,
      REPL_ID: "test-client",
      INSTRUCTOR_EMAILS: "instructor@example.test",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs += chunk;
    });
  }

  const origin = `http://127.0.0.1:${port}`;
  const baseUrl = `${origin}/api`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return {
          origin,
          baseUrl,
          pool,
          child,
          stop: async () => {
            child.kill("SIGTERM");
            await once(child, "exit");
            await pool.end();
          },
          getLogs: () => logs,
        };
      }
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  await pool.end();
  throw new Error(`API server did not start${logs ? `: ${logs}` : ""}`);
}

function setCookies(jar, response) {
  for (const setCookie of response.headers.getSetCookie()) {
    const [nameValue, ...attributes] = setCookie.split(";");
    const separator = nameValue.indexOf("=");
    const name = nameValue.slice(0, separator);
    const value = decodeURIComponent(nameValue.slice(separator + 1));
    const maxAge = attributes.find((attribute) => attribute.trim().toLowerCase().startsWith("max-age="));
    if (!value || maxAge?.trim().toLowerCase() === "max-age=0") {
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function request(api, path, jar, options = {}) {
  const headers = {
    "x-forwarded-proto": "http",
    ...(cookieHeader(jar) ? { cookie: cookieHeader(jar) } : {}),
    ...options.headers,
  };
  const response = await fetch(`${api.baseUrl}${path}`, {
    redirect: "manual",
    ...options,
    headers,
  });
  setCookies(jar, response);
  return response;
}

async function getCallbackUrl(api, cookies) {
  const login = await request(api, "/login", cookies);
  assert.equal(login.status, 302);
  const authorization = await fetch(login.headers.get("location"), { redirect: "manual" });
  assert.equal(authorization.status, 302);
  return new URL(authorization.headers.get("location"));
}

async function assertRejectedCallback(response, cookies, authorizationCode) {
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  const body = await response.text();
  assert.equal(body.includes("provider-private-detail"), false);
  assert.equal(body.includes("oidc-access-token"), false);
  assert.equal(body.includes(authorizationCode), false);
  for (const name of ["code_verifier", "nonce", "state", "return_to"]) {
    assert.equal(cookies[name], undefined, `${name} should be cleared`);
  }
}

async function insertExpiredSession(
  api,
  refreshToken,
  userId = "expired-session-user",
) {
  const sid = randomUUID();
  const session = {
    user: {
      id: userId,
      email: "expired@example.test",
      firstName: "Expired",
      lastName: "Session",
      profileImageUrl: null,
      role: "learner",
    },
    access_token: "expired-access-token",
    expires_at: Math.floor(Date.now() / 1000) - 60,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };

  await api.pool.query(
    `insert into sessions (sid, sess, expire)
     values ($1, $2::jsonb, now() + interval '1 hour')`,
    [sid, JSON.stringify(session)],
  );
  return sid;
}

test("OIDC sign-in creates a role-bearing session and logout returns to the app", async (t) => {
  const provider = await startOidcProvider();
  const api = await startApi(provider);
  t.after(async () => {
    await api.stop();
    await provider.stop();
  });

  const cookies = {};
  const login = await request(api, "/login?returnTo=%2Finstructor%2Fquestions", cookies);
  assert.equal(login.status, 302);
  const authorizationUrl = new URL(login.headers.get("location"));
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), `${api.origin}/api/callback`);
  assert.equal(cookies.return_to, "/instructor/questions");

  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(authorization.status, 302);
  const callbackLocation = authorization.headers.get("location");
  assert.ok(callbackLocation);

  const callback = await request(
    api,
    new URL(callbackLocation).pathname.replace(/^\/api/, "") + new URL(callbackLocation).search,
    cookies,
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/instructor/questions");
  assert.match(cookies.sid, /^[a-f0-9]{64}$/);
  assert.equal(cookies.code_verifier, undefined);
  assert.equal(cookies.nonce, undefined);
  assert.equal(cookies.state, undefined);
  assert.equal(cookies.return_to, undefined);

  const authenticated = await request(api, "/auth/user", cookies);
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), {
    user: {
      id: "oidc-instructor-1",
      email: "instructor@example.test",
      firstName: "OIDC",
      lastName: "Instructor",
      profileImageUrl: null,
      role: "instructor",
    },
  });

  const storedSession = await api.pool.query("select sid from sessions where sid = $1", [cookies.sid]);
  assert.equal(storedSession.rowCount, 1);
  const sessionId = storedSession.rows[0].sid;

  const crossOriginLogout = await request(api, "/logout?returnTo=%2F", cookies, {
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(crossOriginLogout.status, 403);
  assert.equal(cookies.sid, sessionId);

  const logout = await request(api, "/logout?returnTo=%2F", cookies, {
    headers: { origin: api.origin },
  });
  assert.equal(logout.status, 302);
  assert.match(logout.headers.get("location"), new RegExp(`^${provider.issuer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/logout\\?`));
  assert.equal(cookies.sid, undefined);

  const providerLogout = await fetch(logout.headers.get("location"), { redirect: "manual" });
  assert.equal(providerLogout.status, 302);
  assert.equal(providerLogout.headers.get("location"), `${api.origin}/`);

  const deletedSession = await api.pool.query("select sid from sessions where sid = $1", [sessionId]);
  assert.equal(deletedSession.rowCount, 0);
  const signedOut = await request(api, "/auth/user", { sid: storedSession.rows[0].sid });
  assert.deepEqual(await signedOut.json(), { user: null });
});

test("rejected OIDC callbacks clear temporary state and return to sign-in without leaking details", async (t) => {
  const provider = await startOidcProvider();
  const api = await startApi(provider);
  t.after(async () => {
    await api.stop();
    await provider.stop();
  });

  const callbackCodes = [];
  const attempt = async (prepare) => {
    const cookies = {};
    const callbackUrl = await getCallbackUrl(api, cookies);
    callbackCodes.push(callbackUrl.searchParams.get("code"));
    prepare?.(callbackUrl);
    const response = await request(
      api,
      callbackUrl.pathname.replace(/^\/api/, "") + callbackUrl.search,
      cookies,
    );
    await assertRejectedCallback(
      response,
      cookies,
      callbackUrl.searchParams.get("code"),
    );
  };

  await attempt((callbackUrl) => {
    callbackUrl.searchParams.set("state", "incorrect-state");
  });

  provider.setNextNonceOverride("incorrect-nonce");
  await attempt();

  provider.setNextTokenError({
    error: "invalid_grant",
    error_description: "provider-private-detail",
  });
  await attempt();

  provider.omitNextSubject();
  await attempt();

  await new Promise((resolve) => setTimeout(resolve, 25));
  const logs = api.getLogs();
  assert.equal(logs.includes("provider-private-detail"), false);
  assert.equal(logs.includes("oidc-access-token"), false);
  for (const code of callbackCodes) {
    assert.equal(logs.includes(code), false, "authorization code should not appear in logs");
  }
});

test("expired sessions are cleared through the API authentication middleware", async (t) => {
  const provider = await startOidcProvider();
  const api = await startApi(provider);
  t.after(async () => {
    await api.stop();
    await provider.stop();
  });

  await t.test("expires without a refresh token", async () => {
    const sid = await insertExpiredSession(api);
    const cookies = { sid };

    const response = await request(api, "/auth/user", cookies);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: null });
    assert.equal(cookies.sid, undefined);
    assert.equal(provider.getRefreshGrantCalls(), 0);
    const storedSession = await api.pool.query("select sid from sessions where sid = $1", [sid]);
    assert.equal(storedSession.rowCount, 0);
  });

  await t.test("clears a session when the refresh grant is rejected", async () => {
    const sid = await insertExpiredSession(api, "rejected-refresh-token");
    const cookies = { sid };
    const concurrentCookies = { sid };

    const [response, concurrentResponse] = await Promise.all([
      request(api, "/auth/user", cookies),
      request(api, "/auth/user", concurrentCookies),
    ]);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: null });
    assert.equal(concurrentResponse.status, 200);
    assert.deepEqual(await concurrentResponse.json(), { user: null });
    assert.equal(cookies.sid, undefined);
    assert.equal(concurrentCookies.sid, undefined);
    assert.equal(provider.getRefreshGrantCalls(), 1);
    const storedSession = await api.pool.query("select sid from sessions where sid = $1", [sid]);
    assert.equal(storedSession.rowCount, 0);

    const staleCookieResponse = await request(api, "/auth/user", { sid });
    assert.equal(staleCookieResponse.status, 200);
    assert.deepEqual(await staleCookieResponse.json(), { user: null });
    assert.equal(provider.getRefreshGrantCalls(), 1);
  });

  await t.test("preserves a session during a provider outage and retries successfully", async () => {
    const userId = randomUUID();
    await api.pool.query(
      `insert into users (id, email, first_name, last_name, role)
       values ($1, $2, 'Refresh', 'Learner', 'learner')`,
      [userId, `${userId}@example.test`],
    );

    const oldRefreshToken = "temporarily-unavailable-refresh-token";
    const newRefreshToken = "recovered-refresh-token";
    provider.setRefreshTokenRotation(oldRefreshToken, newRefreshToken);
    provider.setNextRefreshError(503, {
      error: "temporarily_unavailable",
      error_description: "provider-private-detail",
    });
    const sid = await insertExpiredSession(api, oldRefreshToken, userId);
    const cookies = { sid };
    const refreshCallsBeforeOutage = provider.getRefreshGrantCalls();

    const unavailable = await request(api, "/auth/user", cookies);

    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("retry-after"), "30");
    assert.deepEqual(await unavailable.json(), {
      error: "Authentication temporarily unavailable",
    });
    assert.equal(cookies.sid, sid);
    const preservedSession = await api.pool.query(
      "select sess from sessions where sid = $1",
      [sid],
    );
    assert.equal(preservedSession.rowCount, 1);
    assert.equal(preservedSession.rows[0].sess.refresh_token, oldRefreshToken);
    assert.equal(preservedSession.rows[0].sess.access_token, "expired-access-token");
    assert.equal(provider.getRefreshGrantCalls(), refreshCallsBeforeOutage + 1);

    const recovered = await request(api, "/auth/user", cookies);

    assert.equal(recovered.status, 200);
    assert.deepEqual((await recovered.json()).user, {
      id: userId,
      email: "expired@example.test",
      firstName: "Expired",
      lastName: "Session",
      profileImageUrl: null,
      role: "learner",
    });
    assert.equal(cookies.sid, sid);
    assert.equal(provider.getRefreshGrantCalls(), refreshCallsBeforeOutage + 2);
    const refreshedSession = await api.pool.query(
      "select sess from sessions where sid = $1",
      [sid],
    );
    assert.equal(refreshedSession.rowCount, 1);
    assert.equal(refreshedSession.rows[0].sess.access_token, "rotated-access-token");
    assert.equal(refreshedSession.rows[0].sess.refresh_token, newRefreshToken);
  });

  await t.test("preserves a session when the refresh connection drops and retries successfully", async () => {
    const userId = randomUUID();
    await api.pool.query(
      `insert into users (id, email, first_name, last_name, role)
       values ($1, $2, 'Refresh', 'Learner', 'learner')`,
      [userId, `${userId}@example.test`],
    );

    const oldRefreshToken = "dropped-connection-refresh-token";
    const newRefreshToken = "recovered-dropped-connection-refresh-token";
    provider.setRefreshTokenRotation(oldRefreshToken, newRefreshToken);
    provider.dropNextRefreshConnection();
    const sid = await insertExpiredSession(api, oldRefreshToken, userId);
    const cookies = { sid };
    const refreshCallsBeforeDrop = provider.getRefreshGrantCalls();

    const unavailable = await request(api, "/auth/user", cookies);

    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("retry-after"), "30");
    assert.deepEqual(await unavailable.json(), {
      error: "Authentication temporarily unavailable",
    });
    assert.equal(cookies.sid, sid);
    const preservedSession = await api.pool.query(
      "select sess from sessions where sid = $1",
      [sid],
    );
    assert.equal(preservedSession.rowCount, 1);
    assert.equal(preservedSession.rows[0].sess.refresh_token, oldRefreshToken);
    assert.equal(preservedSession.rows[0].sess.access_token, "expired-access-token");
    assert.equal(provider.getRefreshGrantCalls(), refreshCallsBeforeDrop + 1);

    const recovered = await request(api, "/auth/user", cookies);

    assert.equal(recovered.status, 200);
    assert.deepEqual((await recovered.json()).user, {
      id: userId,
      email: "expired@example.test",
      firstName: "Expired",
      lastName: "Session",
      profileImageUrl: null,
      role: "learner",
    });
    assert.equal(cookies.sid, sid);
    assert.equal(provider.getRefreshGrantCalls(), refreshCallsBeforeDrop + 2);
    const refreshedSession = await api.pool.query(
      "select sess from sessions where sid = $1",
      [sid],
    );
    assert.equal(refreshedSession.rowCount, 1);
    assert.equal(refreshedSession.rows[0].sess.access_token, "rotated-access-token");
    assert.equal(refreshedSession.rows[0].sess.refresh_token, newRefreshToken);
  });
});

test("concurrent expired-session requests keep a rotated refresh token", async (t) => {
  const provider = await startOidcProvider();
  const api = await startApi(provider);
  t.after(async () => {
    await api.stop();
    await provider.stop();
  });

  const userId = randomUUID();
  await api.pool.query(
    `insert into users (id, email, first_name, last_name, role)
     values ($1, $2, 'Refresh', 'Learner', 'learner')`,
    [userId, `${userId}@example.test`],
  );

  const oldRefreshToken = "rotating-refresh-token";
  const newRefreshToken = "rotated-refresh-token";
  provider.setRefreshTokenRotation(oldRefreshToken, newRefreshToken, 100);
  const sid = await insertExpiredSession(api, oldRefreshToken, userId);
  const firstCookies = { sid };
  const secondCookies = { sid };

  const [firstResponse, secondResponse] = await Promise.all([
    request(api, "/auth/user", firstCookies),
    request(api, "/auth/user", secondCookies),
  ]);

  for (const response of [firstResponse, secondResponse]) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      user: {
        id: userId,
        email: "expired@example.test",
        firstName: "Expired",
        lastName: "Session",
        profileImageUrl: null,
        role: "learner",
      },
    });
  }
  assert.equal(firstCookies.sid, sid);
  assert.equal(secondCookies.sid, sid);
  assert.equal(provider.getRefreshGrantCalls(), 1);

  const storedSession = await api.pool.query(
    "select sess from sessions where sid = $1",
    [sid],
  );
  assert.equal(storedSession.rowCount, 1);
  assert.equal(storedSession.rows[0].sess.access_token, "rotated-access-token");
  assert.equal(storedSession.rows[0].sess.refresh_token, newRefreshToken);
});

test("login falls back to the application root for external return paths", async (t) => {
  const provider = await startOidcProvider();
  const api = await startApi(provider);
  t.after(async () => {
    await api.stop();
    await provider.stop();
  });

  const cookies = {};
  const login = await request(
    api,
    `/login?returnTo=${encodeURIComponent("https://evil.example/phishing")}`,
    cookies,
  );
  assert.equal(login.status, 302);
  assert.equal(cookies.return_to, "/");

  const protocolRelative = await request(api, "/login?returnTo=%2F%2Fevil.example%2Fphishing", cookies);
  assert.equal(protocolRelative.status, 302);
  assert.equal(cookies.return_to, "/");
});