import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import crypto from "node:crypto";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import pg from "pg";

const { Pool } = pg;
let instructorCookie = "";
let learnerCookie = "";

const questionFields = {
  domain: "People",
  topic: `Visibility test ${Date.now()}`,
  approach: "agile",
  difficulty: "easy",
  question: "Which action protects learner visibility?",
  translation: "",
  options: ["Publish the question", "Leave it as a draft"],
  correctAnswer: 0,
  explanation: "Only published questions are delivered to learners.",
};

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startApi({
  nodeEnv = "test",
  unknownRouteSummaryIntervalMs = 5 * 60 * 1000,
  unknownRouteSpikeMinRequests = 25,
  unknownRoutePatternSpikeMinRequests = 10,
  unknownRouteSpikeMultiplier = 3,
  includeSecondaryInstructor = false,
} = {}) {
  const port = await unusedPort();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const userId = `test-instructor-${crypto.randomUUID()}`;
  const sid = crypto.randomBytes(32).toString("hex");
  const learnerId = `test-learner-${crypto.randomUUID()}`;
  const learnerSid = crypto.randomBytes(32).toString("hex");
  const secondaryInstructorId = `test-instructor-${crypto.randomUUID()}`;
  const secondaryInstructorSid = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `insert into users (id, email, first_name, last_name, role)
     values ($1, $2, $3, $4, 'instructor')`,
    [userId, `${userId}@example.test`, "Test", "Instructor"],
  );
  await pool.query(
    `insert into sessions (sid, sess, expire)
     values ($1, $2::jsonb, now() + interval '1 hour')`,
    [
      sid,
      JSON.stringify({
        user: {
          id: userId,
          email: `${userId}@example.test`,
          firstName: "Test",
          lastName: "Instructor",
          profileImageUrl: null,
          role: "instructor",
        },
        access_token: "test-access-token",
      }),
    ],
  );
  await pool.query(
    `insert into users (id, email, first_name, last_name, role)
     values ($1, $2, $3, $4, 'learner')`,
    [learnerId, `${learnerId}@example.test`, "Test", "Learner"],
  );
  if (includeSecondaryInstructor) {
    await pool.query(
      `insert into users (id, email, first_name, last_name, role)
       values ($1, $2, $3, $4, 'instructor')`,
      [
        secondaryInstructorId,
        `${secondaryInstructorId}@example.test`,
        "Other",
        "Instructor",
      ],
    );
    await pool.query(
      `insert into sessions (sid, sess, expire)
       values ($1, $2::jsonb, now() + interval '1 hour')`,
      [
        secondaryInstructorSid,
        JSON.stringify({
          user: {
            id: secondaryInstructorId,
            email: `${secondaryInstructorId}@example.test`,
            firstName: "Other",
            lastName: "Instructor",
            profileImageUrl: null,
            role: "instructor",
          },
          access_token: "test-access-token",
        }),
      ],
    );
  }
  await pool.query(
    `insert into sessions (sid, sess, expire)
     values ($1, $2::jsonb, now() + interval '1 hour')`,
    [
      learnerSid,
      JSON.stringify({
        user: {
          id: learnerId,
          email: `${learnerId}@example.test`,
          firstName: "Test",
          lastName: "Learner",
          profileImageUrl: null,
          role: "learner",
        },
        access_token: "test-access-token",
      }),
    ],
  );
  instructorCookie = `sid=${sid}`;
  learnerCookie = `sid=${learnerSid}`;
  const child = spawn("node", ["--enable-source-maps", "dist/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: nodeEnv,
      API_UNKNOWN_ROUTE_SUMMARY_INTERVAL_MS: String(
        unknownRouteSummaryIntervalMs,
      ),
      API_UNKNOWN_ROUTE_SPIKE_MIN_REQUESTS: String(
        unknownRouteSpikeMinRequests,
      ),
      API_UNKNOWN_ROUTE_PATTERN_SPIKE_MIN_REQUESTS: String(
        unknownRoutePatternSpikeMinRequests,
      ),
      API_UNKNOWN_ROUTE_SPIKE_MULTIPLIER: String(
        unknownRouteSpikeMultiplier,
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let output = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    output += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });

  const baseUrl = `http://127.0.0.1:${port}/api`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return {
          baseUrl,
          learnerId,
          secondaryInstructorCookie: includeSecondaryInstructor
            ? `sid=${secondaryInstructorSid}`
            : null,
          child,
          getOutput: () => output,
          stop: async () => {
            child.kill("SIGTERM");
            await once(child, "exit");
            await pool.end();
          },
        };
      }
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  throw new Error(`API server did not start${stderr ? `: ${stderr}` : ""}`);
}

async function request(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

function parseStructuredLogs(output) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line));
}

async function instructorRequest(baseUrl, path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  return request(baseUrl, path, {
    ...options,
    headers: {
      "content-type": "application/json",
      cookie: instructorCookie,
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
        ? { origin: new URL(baseUrl).origin }
        : {}),
      ...options.headers,
    },
  });
}

async function createQuestion(baseUrl, overrides = {}) {
  const { response, body } = await instructorRequest(
    baseUrl,
    "/instructor/questions",
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        ...questionFields,
        topic: `${questionFields.topic} ${Math.random()}`,
        ...overrides,
      }),
    },
  );
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

async function publishQuestion(baseUrl, id) {
  const { response, body } = await instructorRequest(
    baseUrl,
    `/instructor/questions/${id}/publish`,
    {
      method: "POST",
    },
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function archiveQuestion(baseUrl, id) {
  const { response, body } = await instructorRequest(
    baseUrl,
    `/instructor/questions/${id}/archive`,
    {
      method: "POST",
    },
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function restoreQuestion(baseUrl, id) {
  const { response, body } = await instructorRequest(
    baseUrl,
    `/instructor/questions/${id}/restore`,
    {
      method: "POST",
    },
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function updateQuestion(baseUrl, id, overrides = {}) {
  const { response, body } = await instructorRequest(
    baseUrl,
    `/instructor/questions/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...questionFields, ...overrides }),
    },
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function assertInstructorQuestionPage(result, expectedIds, { limit, offset }) {
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const pageIds = expectedIds.slice(offset, offset + limit);
  assert.deepEqual(
    result.body.items.map((question) => question.id),
    pageIds,
  );
  const hasNext = offset + pageIds.length < expectedIds.length;
  assert.deepEqual(result.body.pagination, {
    offset,
    limit,
    total: expectedIds.length,
    hasNext,
    nextOffset: hasNext ? offset + limit : null,
  });
}

test("instructor writes reject untrusted origins and allow same-origin requests", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const topic = `CSRF protection ${crypto.randomUUID()}`;
  const payload = { ...questionFields, topic };
  const key = crypto.randomUUID();
  const rejected = await instructorRequest(
    api.baseUrl,
    "/instructor/questions",
    {
      method: "POST",
      headers: {
        origin: "https://untrusted.example",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    },
  );
  assert.equal(rejected.response.status, 403);

  const allowed = await instructorRequest(
    api.baseUrl,
    "/instructor/questions",
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(payload),
    },
  );
  assert.equal(allowed.response.status, 201, JSON.stringify(allowed.body));
  assert.equal(allowed.body.topic, topic);

  const bookmarkPath = `/bookmarks/${allowed.body.id}`;
  const bookmarkOptions = {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: learnerCookie,
      "x-learner-id": api.learnerId,
      origin: "https://untrusted.example",
    },
    body: JSON.stringify({ saved: true }),
  };
  const rejectedBookmark = await request(
    api.baseUrl,
    bookmarkPath,
    bookmarkOptions,
  );
  assert.equal(rejectedBookmark.response.status, 403);

  const allowedBookmark = await request(api.baseUrl, bookmarkPath, {
    ...bookmarkOptions,
    headers: { ...bookmarkOptions.headers, origin: new URL(api.baseUrl).origin },
  });
  assert.equal(allowedBookmark.response.status, 200);
  assert.deepEqual(allowedBookmark.body, {
    questionId: allowed.body.id,
    saved: true,
  });
});

test("question creation retries return the original draft without duplicating it", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const idempotencyKey = crypto.randomUUID();
  const marker = `Idempotent create ${crypto.randomUUID()}`;
  const payload = { ...questionFields, topic: marker };
  const missingKey = await instructorRequest(api.baseUrl, "/instructor/questions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  assert.equal(missingKey.response.status, 400);

  const create = () =>
    instructorRequest(api.baseUrl, "/instructor/questions", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
    });

  const firstAttempt = await create();
  assert.equal(firstAttempt.response.status, 201, JSON.stringify(firstAttempt.body));

  // The browser test drops the first committed response; this verifies server-side replay.
  const retry = await create();
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body, firstAttempt.body);

  const conflictingReuse = await instructorRequest(
    api.baseUrl,
    "/instructor/questions",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ ...payload, topic: `${marker} changed` }),
    },
  );
  assert.equal(conflictingReuse.response.status, 409);

  const listed = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?search=${encodeURIComponent(marker)}`,
  );
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.pagination.total, 1);
  assert.equal(listed.body.items[0].id, firstAttempt.body.id);
});

test("published learner delivery excludes drafts and archived questions", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const draft = await createQuestion(api.baseUrl);
  const published = await createQuestion(api.baseUrl, {
    topic: `${questionFields.topic} published`,
  });
  await publishQuestion(api.baseUrl, published.id);
  const archived = await createQuestion(api.baseUrl, {
    topic: `${questionFields.topic} archived`,
  });
  await publishQuestion(api.baseUrl, archived.id);
  await archiveQuestion(api.baseUrl, archived.id);

  const { response, body } = await request(api.baseUrl, "/questions");
  assert.equal(response.status, 200);
  const visibleIds = new Set(body.map((question) => question.id));

  assert.equal(visibleIds.has(published.id), true);
  assert.equal(visibleIds.has(draft.id), false);
  assert.equal(visibleIds.has(archived.id), false);

  await publishQuestion(api.baseUrl, draft.id);
  await archiveQuestion(api.baseUrl, published.id);
  await archiveQuestion(api.baseUrl, draft.id);
});

test("instructors can restore only archived questions as drafts", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const question = await createQuestion(api.baseUrl);
  await publishQuestion(api.baseUrl, question.id);
  await archiveQuestion(api.baseUrl, question.id);

  const restored = await restoreQuestion(api.baseUrl, question.id);
  assert.equal(restored.id, question.id);
  assert.equal(restored.status, "draft");
  assert.equal(restored.question, question.question);

  const repeatedRestore = await instructorRequest(
    api.baseUrl,
    `/instructor/questions/${question.id}/restore`,
    { method: "POST" },
  );
  assert.equal(repeatedRestore.response.status, 409);
  assert.deepEqual(repeatedRestore.body, {
    error: "Only archived questions can be restored",
  });
});

test("instructor routes reject callers without the instructor role", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const unauthenticatedRequests = [
    request(api.baseUrl, "/instructor/questions"),
    request(api.baseUrl, "/instructor/questions", {
      method: "POST",
      body: JSON.stringify(questionFields),
    }),
    request(api.baseUrl, "/instructor/questions/missing", {
      method: "PATCH",
      body: JSON.stringify(questionFields),
    }),
    request(api.baseUrl, "/instructor/questions/missing/publish", {
      method: "POST",
    }),
    request(api.baseUrl, "/instructor/questions/missing/archive", {
      method: "POST",
    }),
    request(api.baseUrl, "/instructor/questions/missing/restore", {
      method: "POST",
    }),
    request(api.baseUrl, "/instructor/questions", {
      headers: { "x-user-role": "learner" },
    }),
    request(api.baseUrl, "/instructor/questions", {
      headers: { "x-user-role": "instructor" },
    }),
    request(api.baseUrl, "/instructor/preferences"),
  ];
  const unauthorizedRequests = [
    request(api.baseUrl, "/instructor/questions", {
      headers: { cookie: learnerCookie },
    }),
    request(api.baseUrl, "/instructor/questions/missing/restore", {
      method: "POST",
      headers: { cookie: learnerCookie, origin: new URL(api.baseUrl).origin },
    }),
    request(api.baseUrl, "/instructor/preferences", {
      headers: { cookie: learnerCookie },
    }),
  ];

  for (const result of await Promise.all(unauthenticatedRequests)) {
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, { error: "Authentication required" });
  }

  for (const result of await Promise.all(unauthorizedRequests)) {
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.body, { error: "Instructor role required" });
  }

  const learnerDelivery = await request(api.baseUrl, "/questions");
  assert.equal(learnerDelivery.response.status, 200);
});

test("instructor page-size preferences persist per signed-in account", async (t) => {
  const api = await startApi({ includeSecondaryInstructor: true });
  t.after(() => api.stop());

  const readPreferences = (cookie) =>
    request(api.baseUrl, "/instructor/preferences", {
      headers: { cookie },
    });
  const updatePreferences = (cookie, pageSize) =>
    request(api.baseUrl, "/instructor/preferences", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: new URL(api.baseUrl).origin,
      },
      body: JSON.stringify({ pageSize }),
    });

  assert.deepEqual((await readPreferences(instructorCookie)).body, { pageSize: 25 });
  const changed = await updatePreferences(instructorCookie, 10);
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body, { pageSize: 10 });
  assert.deepEqual((await readPreferences(instructorCookie)).body, { pageSize: 10 });

  const otherInstructorCookie = api.secondaryInstructorCookie;
  assert.ok(otherInstructorCookie);
  assert.deepEqual((await readPreferences(otherInstructorCookie)).body, { pageSize: 25 });
  const otherChanged = await updatePreferences(otherInstructorCookie, 50);
  assert.equal(otherChanged.response.status, 200, JSON.stringify(otherChanged.body));
  assert.deepEqual(otherChanged.body, { pageSize: 50 });
  assert.deepEqual((await readPreferences(instructorCookie)).body, { pageSize: 10 });

  const invalid = await updatePreferences(instructorCookie, 20);
  assert.equal(invalid.response.status, 400);
  assert.deepEqual((await readPreferences(instructorCookie)).body, { pageSize: 10 });
});

test("admin routes distinguish unauthenticated requests from non-admin users", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const unauthenticatedRequests = [
    request(api.baseUrl, "/admin/users"),
    request(api.baseUrl, "/admin/access-audit"),
    request(api.baseUrl, "/admin/users/missing/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "instructor" }),
    }),
    request(api.baseUrl, "/admin/users/missing/admin-access", {
      method: "DELETE",
    }),
  ];

  for (const result of await Promise.all(unauthenticatedRequests)) {
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, { error: "Authentication required" });
  }

  const nonAdminRequests = [
    request(api.baseUrl, "/admin/users", {
      headers: { cookie: instructorCookie },
    }),
    request(api.baseUrl, "/admin/users", {
      headers: { cookie: learnerCookie },
    }),
  ];

  for (const result of await Promise.all(nonAdminRequests)) {
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.body, { error: "Administrator role required" });
  }
});

test("the auth session is the source of the signed-in role", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const result = await request(api.baseUrl, "/auth/user", {
    headers: { cookie: instructorCookie },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.user.role, "instructor");
});

test("malformed JSON returns a documented client error without parser details", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const response = await fetch(`${api.baseUrl}/instructor/questions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: instructorCookie,
    },
    body: "{ invalid json",
  });

  assert.equal(response.status, 400);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  assert.deepEqual(await response.json(), {
    error: "Malformed JSON request body",
  });
});

test("oversized JSON returns a documented 413 without parser details", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const response = await fetch(`${api.baseUrl}/instructor/questions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: instructorCookie,
    },
    body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
  });

  assert.equal(response.status, 413);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  const body = await response.json();
  assert.deepEqual(body, { error: "Request body too large" });
  assert.doesNotMatch(
    JSON.stringify(body),
    /entity\.too\.large|PayloadTooLargeError|stack/i,
  );
});

test("oversized compressed JSON returns a documented 413 without parser details", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const expandedBody = Buffer.from(
    JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
  );
  const compressedBodies = [
    { encoding: "gzip", body: gzipSync(expandedBody) },
    { encoding: "deflate", body: deflateSync(expandedBody) },
    { encoding: "br", body: brotliCompressSync(expandedBody) },
  ];

  for (const { encoding, body: compressedBody } of compressedBodies) {
    await t.test(encoding, async () => {
      assert.ok(
        compressedBody.length < 100 * 1024,
        "compressed request is below the parser limit before decompression",
      );

      const response = await fetch(`${api.baseUrl}/instructor/questions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": encoding,
          cookie: instructorCookie,
        },
        body: compressedBody,
      });

      assert.equal(response.status, 413);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/json/,
      );
      const responseBody = await response.json();
      assert.deepEqual(responseBody, { error: "Request body too large" });
      assert.doesNotMatch(
        JSON.stringify(responseBody),
        /gzip|gunzip|deflate|brotli|entity\.too\.large|PayloadTooLargeError|stack|zlib|Z_DATA_ERROR/i,
      );
    });
  }
});

test("oversized URL-encoded form returns a documented 413 without parser details", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const response = await fetch(`${api.baseUrl}/instructor/questions`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: instructorCookie,
    },
    body: `payload=${"x".repeat(1024 * 1024)}`,
  });

  assert.equal(response.status, 413);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  const body = await response.json();
  assert.deepEqual(body, { error: "Request body too large" });
  assert.doesNotMatch(
    JSON.stringify(body),
    /entity\.too\.large|PayloadTooLargeError|stack/i,
  );
});

test("malformed JSON on learner write routes returns a documented client error", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const requests = [
    ["/practice/sessions", "POST"],
    ["/practice/sessions/session-malformed-answer", "POST"],
    ["/bookmarks/question-malformed-bookmark", "PUT"],
  ];

  for (const [path, method] of requests) {
    const response = await fetch(`${api.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-learner-id": "learner-malformed-json",
      },
      body: "{ invalid json",
    });
    const body = await response.json();

    assert.equal(response.status, 400, `${method} ${path}`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json/,
      `${method} ${path}`,
    );
    assert.deepEqual(
      body,
      { error: "Malformed JSON request body" },
      `${method} ${path}`,
    );
    assert.equal(JSON.stringify(body).includes("Unexpected token"), false);
  }
});

test("unexpected API failures return the documented error shape without internals", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const response = await fetch(`${api.baseUrl}/instructor/questions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      cookie: instructorCookie,
    },
    body: "{ valid-looking but undecodable body }",
  });

  assert.equal(response.status, 500);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  const body = await response.json();
  assert.deepEqual(body, {
    error: "Internal server error",
  });
  assert.doesNotMatch(
    JSON.stringify(body),
    /gzip|undecodable|Z_DATA_ERROR|stack/i,
  );
});

test("unknown API routes return JSON not-found errors across routed request methods", async (t) => {
  const api = await startApi({
    nodeEnv: "production",
    unknownRouteSummaryIntervalMs: 100,
  });
  t.after(() => api.stop());

  const cases = [
    { method: "GET", path: "/does-not-exist" },
    { method: "POST", path: "/nested/does-not-exist" },
    { method: "PUT", path: "/nested/deeper/does-not-exist" },
    { method: "PATCH", path: "/does-not-exist/with/segments" },
    { method: "DELETE", path: "/nested/does-not-exist" },
  ];

  for (const { method, path } of cases) {
    const response = await fetch(`${api.baseUrl}${path}`, {
      method,
      headers: { accept: "text/html" },
    });

    assert.equal(response.status, 404, `${method} ${path}`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json/,
      `${method} ${path}`,
    );
    assert.deepEqual(
      await response.json(),
      {
        error: "API route not found",
      },
      `${method} ${path}`,
    );
  }

  const sensitiveQuery = "query-secret-marker";
  const sensitiveCookie = "cookie-secret-marker";
  const sensitiveBody = "body-secret-marker";
  const response = await fetch(
    `${api.baseUrl}/nested/logging-check?token=${sensitiveQuery}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `session=${sensitiveCookie}`,
      },
      body: JSON.stringify({ privateValue: sensitiveBody }),
    },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "API route not found",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repeatedResponse = await fetch(
      `${api.baseUrl}/nested/logging-check?token=another-query-${attempt}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `session=another-cookie-${attempt}`,
        },
        body: JSON.stringify({ privateValue: `another-body-${attempt}` }),
      },
    );
    assert.equal(repeatedResponse.status, 404);
    assert.deepEqual(await repeatedResponse.json(), {
      error: "API route not found",
    });
  }

  const hasSummaryForAllRepeatedRequests = () => {
    const summarizedRequestCount = parseStructuredLogs(api.getOutput())
      .filter((line) => line.event === "api.route_not_found.summary")
      .flatMap((summary) => summary.routes)
      .filter(
        (route) =>
          route.method === "POST" && route.path === "/api/nested/logging-check",
      )
      .reduce((sum, route) => sum + route.count, 0);

    return summarizedRequestCount === 3;
  };
  for (
    let attempt = 0;
    attempt < 100 && !hasSummaryForAllRepeatedRequests();
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const parsedLogs = parseStructuredLogs(api.getOutput());
  const logLines = parsedLogs.filter(
    (line) => line.event === "api.route_not_found",
  );
  assert.ok(
    logLines.length > 0,
    "unknown API requests emit a structured log event",
  );
  const event = logLines.find(
    (line) => line.path === "/api/nested/logging-check",
  );
  assert.deepEqual(
    {
      event: event?.event,
      method: event?.method,
      path: event?.path,
      status: event?.status,
    },
    {
      event: "api.route_not_found",
      method: "POST",
      path: "/api/nested/logging-check",
      status: 404,
    },
  );

  const summaries = parsedLogs.filter(
    (line) => line.event === "api.route_not_found.summary",
  );
  assert.ok(
    summaries.length > 0,
    "unknown API routes are summarized periodically",
  );
  const repeatedRouteCount = summaries
    .flatMap((summary) => summary.routes)
    .filter(
      (route) =>
        route.method === "POST" && route.path === "/api/nested/logging-check",
    )
    .reduce((sum, route) => sum + route.count, 0);
  assert.equal(repeatedRouteCount, 3);
  assert.ok(
    summaries.some(
      (summary) => summary.windowMs > 0 && summary.requestCount > 0,
    ),
    "summaries include their time window and request count",
  );
  assert.doesNotMatch(
    api.getOutput(),
    /query-secret-marker|cookie-secret-marker|body-secret-marker|another-query-|another-cookie-|another-body-/,
  );
});

test("unknown API route summaries group changing identifiers without merging unrelated paths", async (t) => {
  const api = await startApi({
    nodeEnv: "production",
    unknownRouteSummaryIntervalMs: 100,
  });
  t.after(() => api.stop());

  const identifierPaths = [
    "/missing-resource/550e8400-e29b-41d4-a716-446655440000?token=query-secret",
    "/missing-resource/550e8400-e29b-41d4-a716-446655440001?token=another-query-secret",
  ];
  const unrelatedPaths = [
    "/missing-resource/static-name",
    "/different-resource/550e8400-e29b-41d4-a716-446655440002",
  ];

  for (const path of [...identifierPaths, ...unrelatedPaths]) {
    const response = await fetch(`${api.baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "API route not found",
    });
  }

  const hasAllSummaryRoutes = () => {
    const routes = parseStructuredLogs(api.getOutput())
      .filter((line) => line.event === "api.route_not_found.summary")
      .flatMap((summary) => summary.routes);
    return (
      routes.some(
        (route) =>
          route.method === "GET" &&
          route.path === "/api/missing-resource/:id" &&
          route.count === 2,
      ) &&
      routes.some(
        (route) =>
          route.method === "GET" &&
          route.path === "/api/missing-resource/static-name" &&
          route.count === 1,
      ) &&
      routes.some(
        (route) =>
          route.method === "GET" &&
          route.path === "/api/different-resource/:id" &&
          route.count === 1,
      )
    );
  };

  for (let attempt = 0; attempt < 100 && !hasAllSummaryRoutes(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const logs = parseStructuredLogs(api.getOutput());
  const requestEvents = logs.filter(
    (line) => line.event === "api.route_not_found",
  );
  for (const path of identifierPaths) {
    const pathWithoutQuery = path.split("?")[0];
    assert.ok(
      requestEvents.some(
        (event) =>
          event.method === "GET" && event.path === `/api${pathWithoutQuery}`,
      ),
      `individual route event retains ${pathWithoutQuery}`,
    );
  }
  assert.ok(
    hasAllSummaryRoutes(),
    "summaries group only matching route patterns",
  );
  assert.doesNotMatch(api.getOutput(), /query-secret/);
});

test("unknown API route spikes distinguish aggregate traffic from a noisy route pattern", async (t) => {
  const api = await startApi({
    nodeEnv: "production",
    unknownRouteSummaryIntervalMs: 1000,
    unknownRouteSpikeMinRequests: 5,
    unknownRoutePatternSpikeMinRequests: 3,
    unknownRouteSpikeMultiplier: 2,
  });
  t.after(() => api.stop());

  const requestNotFound = async (path) => {
    const response = await fetch(`${api.baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "API route not found",
    });
  };
  const hasSummary = (predicate) =>
    parseStructuredLogs(api.getOutput())
      .filter((line) => line.event === "api.route_not_found.summary")
      .some(predicate);
  const waitForSummary = async (predicate) => {
    for (let attempt = 0; attempt < 400 && !hasSummary(predicate); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(hasSummary(predicate), "unknown routes are summarized");
  };

  await requestNotFound("/spike-baseline");
  await waitForSummary((summary) =>
    summary.routes.some(
      (route) => route.path === "/api/spike-baseline" && route.count === 1,
    ),
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await requestNotFound(
      `/noisy/pattern?token=spike-query-secret-${attempt}`,
    );
  }
  await waitForSummary((summary) =>
    summary.routes.some(
      (route) => route.path === "/api/noisy/pattern" && route.count === 3,
    ),
  );

  let logs = parseStructuredLogs(api.getOutput());
  const patternSpike = logs.find(
    (line) =>
      line.event === "api.route_not_found.spike" &&
      line.scope === "route_pattern",
  );
  assert.deepEqual(
    {
      scope: patternSpike?.scope,
      method: patternSpike?.method,
      path: patternSpike?.path,
      requestCount: patternSpike?.requestCount,
      previousRequestCount: patternSpike?.previousRequestCount,
      minimumRequestCount: patternSpike?.minimumRequestCount,
    },
    {
      scope: "route_pattern",
      method: "GET",
      path: "/api/noisy/pattern",
      requestCount: 3,
      previousRequestCount: 0,
      minimumRequestCount: 3,
    },
  );
  assert.ok(
    !logs.some(
      (line) =>
        line.event === "api.route_not_found.spike" &&
        line.scope === "all_routes",
    ),
    "one noisy route below the aggregate threshold does not trigger an aggregate spike",
  );

  const broadRouteNames = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
  ];
  for (const [index, name] of broadRouteNames.entries()) {
    const query = index === 0 ? "?token=broad-spike-query-secret" : "";
    await requestNotFound(`/broad/${name}${query}`);
  }
  await waitForSummary((summary) => summary.requestCount === 8);

  logs = parseStructuredLogs(api.getOutput());
  const aggregateSpike = logs.find(
    (line) =>
      line.event === "api.route_not_found.spike" &&
      line.scope === "all_routes",
  );
  assert.deepEqual(
    {
      scope: aggregateSpike?.scope,
      requestCount: aggregateSpike?.requestCount,
      previousRequestCount: aggregateSpike?.previousRequestCount,
      minimumRequestCount: aggregateSpike?.minimumRequestCount,
      uniqueRouteCount: aggregateSpike?.uniqueRouteCount,
    },
    {
      scope: "all_routes",
      requestCount: 8,
      previousRequestCount: 3,
      minimumRequestCount: 5,
      uniqueRouteCount: 8,
    },
  );
  assert.equal(
    logs.filter(
      (line) =>
        line.event === "api.route_not_found.spike" &&
        line.scope === "route_pattern",
    ).length,
    1,
    "the broad increase is separate from the single route-pattern warning",
  );
  assert.doesNotMatch(
    api.getOutput(),
    /spike-query-secret|broad-spike-query-secret/,
  );
});

test("CORS allows the application origin and rejects unapproved origins", async (t) => {
  const api = await startApi({ nodeEnv: "production" });
  t.after(() => api.stop());

  const origin = `https://${new URL(api.baseUrl).host}`;
  const preflight = await fetch(`${api.baseUrl}/nested/deeper/does-not-exist`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "X-Forwarded-Proto": "https",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(
    preflight.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.match(
    preflight.headers.get("access-control-allow-methods") ?? "",
    /(?:^|,\s*)POST(?:,|$)/i,
  );
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "content-type",
  );
  assert.equal(await preflight.text(), "");

  const credentialedRequest = await fetch(`${api.baseUrl}/auth/user`, {
    headers: {
      Origin: origin,
      Cookie: instructorCookie,
      "X-Forwarded-Proto": "https",
    },
  });
  assert.equal(credentialedRequest.status, 200);
  assert.equal(
    credentialedRequest.headers.get("access-control-allow-origin"),
    origin,
  );
  assert.equal(
    credentialedRequest.headers.get("access-control-allow-credentials"),
    "true",
  );

  const unapprovedOrigin = "https://unapproved.example.test";
  const rejectedPreflight = await fetch(
    `${api.baseUrl}/nested/deeper/does-not-exist`,
    {
      method: "OPTIONS",
      headers: {
        Origin: unapprovedOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "X-Forwarded-Host": "unapproved.example.test",
        "X-Forwarded-Proto": "https",
      },
    },
  );
  assert.notEqual(rejectedPreflight.status, 204);
  assert.equal(
    rejectedPreflight.headers.get("access-control-allow-origin"),
    null,
  );
  assert.equal(
    rejectedPreflight.headers.get("access-control-allow-credentials"),
    null,
  );

  const rejectedRequest = await fetch(`${api.baseUrl}/auth/user`, {
    headers: {
      Origin: unapprovedOrigin,
      Cookie: instructorCookie,
    },
  });
  assert.equal(rejectedRequest.status, 200);
  assert.equal(
    rejectedRequest.headers.get("access-control-allow-origin"),
    null,
  );
  assert.equal(
    rejectedRequest.headers.get("access-control-allow-credentials"),
    null,
  );
});

test("published learner delivery applies domain, approach, and difficulty filters", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const matching = await createQuestion(api.baseUrl, {
    domain: "People",
    approach: "agile",
    difficulty: "easy",
  });
  const otherDomain = await createQuestion(api.baseUrl, { domain: "Process" });
  const otherApproach = await createQuestion(api.baseUrl, {
    approach: "predictive",
  });
  const otherDifficulty = await createQuestion(api.baseUrl, {
    difficulty: "hard",
  });
  for (const question of [
    matching,
    otherDomain,
    otherApproach,
    otherDifficulty,
  ]) {
    await publishQuestion(api.baseUrl, question.id);
  }

  const filterCases = [
    ["domain=People", matching.id, [otherDomain.id]],
    ["approach=agile", matching.id, [otherApproach.id]],
    ["difficulty=easy", matching.id, [otherDifficulty.id]],
    [
      "domain=People&approach=agile&difficulty=easy",
      matching.id,
      [otherDomain.id, otherApproach.id, otherDifficulty.id],
    ],
  ];

  for (const [query, includedId, excludedIds] of filterCases) {
    const { response, body } = await request(
      api.baseUrl,
      `/questions?${query}`,
    );
    assert.equal(response.status, 200, query);
    const ids = new Set(body.map((question) => question.id));
    assert.equal(ids.has(includedId), true, query);
    for (const excludedId of excludedIds) {
      assert.equal(
        ids.has(excludedId),
        false,
        `${query} exposed ${excludedId}`,
      );
    }
  }

  for (const question of [
    matching,
    otherDomain,
    otherApproach,
    otherDifficulty,
  ]) {
    await archiveQuestion(api.baseUrl, question.id);
  }
});

test("learner practice sessions persist answers, scores, dashboard activity, and bookmarks", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const learnerId = `learner-practice-${Date.now()}-${Math.random()}`;
  const questionsResponse = await request(api.baseUrl, "/questions");
  assert.equal(questionsResponse.response.status, 200);
  const question = questionsResponse.body[0];
  assert.ok(question?.id);

  const sessionResult = await request(api.baseUrl, "/practice/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
    body: JSON.stringify({
      mode: "quick",
      domain: null,
      approach: null,
      timed: false,
      questionIds: [question.id],
    }),
  });
  assert.equal(
    sessionResult.response.status,
    201,
    JSON.stringify(sessionResult.body),
  );

  const answerResult = await request(
    api.baseUrl,
    `/practice/sessions/${sessionResult.body.id}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-learner-id": learnerId,
      },
      body: JSON.stringify({
        questionId: question.id,
        selectedAnswer: question.correctAnswer,
      }),
    },
  );
  assert.equal(
    answerResult.response.status,
    200,
    JSON.stringify(answerResult.body),
  );
  assert.equal(answerResult.body.isCorrect, true);

  const completeResult = await request(
    api.baseUrl,
    `/practice/sessions/${sessionResult.body.id}/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-learner-id": learnerId,
      },
    },
  );
  assert.equal(
    completeResult.response.status,
    200,
    JSON.stringify(completeResult.body),
  );
  assert.equal(completeResult.body.score, 100);
  assert.equal(completeResult.body.answers.length, 1);

  const latestResult = await request(api.baseUrl, "/practice/sessions/latest", {
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
  });
  assert.equal(latestResult.response.status, 200);
  assert.equal(latestResult.body.id, sessionResult.body.id);
  assert.equal(
    latestResult.body.answers[0].selectedAnswer,
    question.correctAnswer,
  );

  const progressResult = await request(api.baseUrl, "/progress/dashboard", {
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
  });
  assert.equal(progressResult.response.status, 200);
  assert.equal(progressResult.body.completedSessions, 1);
  assert.equal(progressResult.body.lastScore, 100);
  assert.equal(
    progressResult.body.recentActivity[0].sessionId,
    sessionResult.body.id,
  );

  const bookmarkResult = await request(
    api.baseUrl,
    `/bookmarks/${question.id}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-learner-id": learnerId,
      },
      body: JSON.stringify({ saved: true }),
    },
  );
  assert.deepEqual(bookmarkResult.body, {
    questionId: question.id,
    saved: true,
  });
  const bookmarks = await request(api.baseUrl, "/bookmarks", {
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
  });
  assert.deepEqual(bookmarks.body, [question.id]);
});

test("timed practice expires into a completed result without losing saved answers", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const learnerId = `learner-expiry-${Date.now()}-${Math.random()}`;
  const questionsResponse = await request(api.baseUrl, "/questions");
  assert.equal(questionsResponse.response.status, 200);
  const question = questionsResponse.body[0];
  assert.ok(question?.id);

  const sessionResult = await request(api.baseUrl, "/practice/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
    body: JSON.stringify({
      mode: "mock",
      domain: null,
      approach: null,
      timed: true,
      questionIds: [question.id],
    }),
  });
  assert.equal(
    sessionResult.response.status,
    201,
    JSON.stringify(sessionResult.body),
  );
  assert.equal(sessionResult.body.completionReason, "manual");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    "update practice_sessions set started_at = now() - interval '2 minutes' where id = $1",
    [sessionResult.body.id],
  );
  await pool.end();

  const answerResult = await request(
    api.baseUrl,
    `/practice/sessions/${sessionResult.body.id}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-learner-id": learnerId,
      },
      body: JSON.stringify({
        questionId: question.id,
        selectedAnswer: question.correctAnswer,
      }),
    },
  );
  assert.equal(
    answerResult.response.status,
    200,
    JSON.stringify(answerResult.body),
  );

  const completeResult = await request(
    api.baseUrl,
    `/practice/sessions/${sessionResult.body.id}/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-learner-id": learnerId,
      },
    },
  );
  assert.equal(
    completeResult.response.status,
    200,
    JSON.stringify(completeResult.body),
  );
  assert.equal(completeResult.body.status, "completed");
  assert.equal(completeResult.body.completionReason, "time_expired");
  assert.equal(completeResult.body.score, 100);
  assert.equal(
    completeResult.body.answers[0].selectedAnswer,
    question.correctAnswer,
  );

  const historyResult = await request(api.baseUrl, "/practice/sessions", {
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
  });
  assert.equal(historyResult.response.status, 200);
  assert.equal(historyResult.body[0].completionReason, "time_expired");

  const progressResult = await request(api.baseUrl, "/progress/dashboard", {
    headers: { "content-type": "application/json", "x-learner-id": learnerId },
  });
  assert.equal(progressResult.response.status, 200);
  assert.equal(
    progressResult.body.recentActivity[0].completionReason,
    "time_expired",
  );
});

test("dashboard and in-progress reads finalize expired timed sessions", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const learnerId = `learner-read-expiry-${crypto.randomUUID()}`;
  const headers = {
    "content-type": "application/json",
    "x-learner-id": learnerId,
  };
  const questionsResponse = await request(api.baseUrl, "/questions");
  assert.equal(questionsResponse.response.status, 200);
  const question = questionsResponse.body[0];
  assert.ok(question?.id);

  const createTimedSession = async () => {
    const created = await request(api.baseUrl, "/practice/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        mode: "mock",
        domain: null,
        approach: null,
        timed: true,
        questionIds: [question.id],
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      "update practice_sessions set started_at = now() - interval '2 minutes' where id = $1",
      [created.body.id],
    );
    await pool.end();
    return created.body;
  };

  const dashboardSession = await createTimedSession();
  const savedAnswer = await request(
    api.baseUrl,
    `/practice/sessions/${dashboardSession.id}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionId: question.id,
        selectedAnswer: question.correctAnswer,
      }),
    },
  );
  assert.equal(
    savedAnswer.response.status,
    200,
    JSON.stringify(savedAnswer.body),
  );

  const progress = await request(api.baseUrl, "/progress/dashboard", {
    headers,
  });
  assert.equal(progress.response.status, 200);
  assert.equal(progress.body.completedSessions, 1);
  assert.equal(
    progress.body.recentActivity[0].completionReason,
    "time_expired",
  );

  const history = await request(api.baseUrl, "/practice/sessions", { headers });
  assert.equal(history.response.status, 200);
  assert.equal(history.body[0].id, dashboardSession.id);
  assert.equal(history.body[0].completionReason, "time_expired");
  const completedDetail = await request(
    api.baseUrl,
    `/practice/sessions/${dashboardSession.id}`,
    { headers },
  );
  assert.equal(completedDetail.body.status, "completed");
  assert.equal(
    completedDetail.body.answers[0].selectedAnswer,
    question.correctAnswer,
  );

  const inProgressSession = await createTimedSession();
  const inProgress = await request(
    api.baseUrl,
    "/practice/sessions/in-progress",
    { headers },
  );
  assert.equal(inProgress.response.status, 200);
  assert.deepEqual(inProgress.body, []);

  const finalizedDetail = await request(
    api.baseUrl,
    `/practice/sessions/${inProgressSession.id}`,
    { headers },
  );
  assert.equal(finalizedDetail.response.status, 200);
  assert.equal(finalizedDetail.body.status, "completed");
  assert.equal(finalizedDetail.body.completionReason, "time_expired");
});

test("instructor question library filters by status and metadata", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const draft = await createQuestion(api.baseUrl, {
    topic: `${questionFields.topic} instructor draft`,
  });
  const published = await createQuestion(api.baseUrl, {
    topic: `${questionFields.topic} instructor published`,
  });
  await publishQuestion(api.baseUrl, published.id);
  const archived = await createQuestion(api.baseUrl, {
    topic: `${questionFields.topic} instructor archived`,
  });
  await publishQuestion(api.baseUrl, archived.id);
  await archiveQuestion(api.baseUrl, archived.id);

  const differentDomain = await createQuestion(api.baseUrl, {
    domain: "Process",
    topic: `${questionFields.topic} different domain`,
  });
  await publishQuestion(api.baseUrl, differentDomain.id);
  const differentApproach = await createQuestion(api.baseUrl, {
    approach: "predictive",
    topic: `${questionFields.topic} different approach`,
  });
  await publishQuestion(api.baseUrl, differentApproach.id);
  const differentDifficulty = await createQuestion(api.baseUrl, {
    difficulty: "hard",
    topic: `${questionFields.topic} different difficulty`,
  });
  await publishQuestion(api.baseUrl, differentDifficulty.id);

  const statusCases = [
    ["draft", draft.id, [published.id, archived.id]],
    ["published", published.id, [draft.id, archived.id]],
    ["archived", archived.id, [draft.id, published.id]],
  ];
  for (const [status, includedId, excludedIds] of statusCases) {
    const { response, body } = await instructorRequest(
      api.baseUrl,
      `/instructor/questions?status=${status}`,
    );
    assert.equal(response.status, 200, status);
    const ids = new Set(body.items.map((question) => question.id));
    assert.equal(ids.has(includedId), true, status);
    for (const excludedId of excludedIds) {
      assert.equal(
        ids.has(excludedId),
        false,
        `${status} exposed ${excludedId}`,
      );
    }
  }

  const combined = await instructorRequest(
    api.baseUrl,
    "/instructor/questions?status=published&domain=People&approach=agile&difficulty=easy",
  );
  assert.equal(combined.response.status, 200);
  const combinedIds = new Set(
    combined.body.items.map((question) => question.id),
  );
  assert.equal(combinedIds.has(published.id), true);
  for (const excludedId of [
    draft.id,
    archived.id,
    differentDomain.id,
    differentApproach.id,
    differentDifficulty.id,
  ]) {
    assert.equal(
      combinedIds.has(excludedId),
      false,
      `combined filters exposed ${excludedId}`,
    );
  }

  const invalidCases = [
    [
      "status",
      "retired",
      ["draft", "published", "archived"],
      "Invalid enum value. Expected 'draft' | 'published' | 'archived', received 'retired'",
    ],
    [
      "domain",
      "Unknown",
      ["People", "Process", "Business environment"],
      "Invalid enum value. Expected 'People' | 'Process' | 'Business environment', received 'Unknown'",
    ],
    [
      "approach",
      "waterfall",
      ["agile", "predictive", "hybrid"],
      "Invalid enum value. Expected 'agile' | 'predictive' | 'hybrid', received 'waterfall'",
    ],
    [
      "difficulty",
      "expert",
      ["easy", "medium", "hard"],
      "Invalid enum value. Expected 'easy' | 'medium' | 'hard', received 'expert'",
    ],
  ];
  for (const [field, value, options, message] of invalidCases) {
    const query = `${field}=${value}`;
    const result = await instructorRequest(
      api.baseUrl,
      `/instructor/questions?${query}`,
    );
    assert.equal(result.response.status, 400, query);
    assert.deepEqual(JSON.parse(result.body.error), [
      {
        received: value,
        code: "invalid_enum_value",
        options,
        path: [field],
        message,
      },
    ]);
  }
});

test("instructor question library paginates pages and keeps filters applied", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const marker = `pagination marker ${Date.now()}-${Math.random()}`;
  const matchingQuestions = [];
  for (let index = 0; index < 5; index += 1) {
    matchingQuestions.push(
      await createQuestion(api.baseUrl, {
        topic: `${marker} matching ${index}`,
        domain: "People",
        approach: "agile",
        difficulty: "easy",
      }),
    );
  }
  await createQuestion(api.baseUrl, {
    topic: `${marker} wrong domain`,
    domain: "Process",
    approach: "agile",
    difficulty: "easy",
  });
  await createQuestion(api.baseUrl, {
    topic: `${marker} wrong approach`,
    domain: "People",
    approach: "predictive",
    difficulty: "easy",
  });

  const filterQuery = `search=${encodeURIComponent(marker)}&status=draft&domain=People&approach=agile&difficulty=easy`;
  const firstPage = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?${filterQuery}&limit=2&offset=0`,
  );
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.items.length, 2);
  assert.deepEqual(firstPage.body.pagination, {
    offset: 0,
    limit: 2,
    total: 5,
    hasNext: true,
    nextOffset: 2,
  });

  const secondPage = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?${filterQuery}&limit=2&offset=2`,
  );
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.body.items.length, 2);
  assert.deepEqual(secondPage.body.pagination, {
    offset: 2,
    limit: 2,
    total: 5,
    hasNext: true,
    nextOffset: 4,
  });

  const thirdPage = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?${filterQuery}&limit=2&offset=4`,
  );
  assert.equal(thirdPage.response.status, 200);
  assert.equal(thirdPage.body.items.length, 1);
  assert.deepEqual(thirdPage.body.pagination, {
    offset: 4,
    limit: 2,
    total: 5,
    hasNext: false,
    nextOffset: null,
  });

  const pagedIds = [
    ...firstPage.body.items,
    ...secondPage.body.items,
    ...thirdPage.body.items,
  ].map((question) => question.id);
  assert.deepEqual(
    new Set(pagedIds),
    new Set(matchingQuestions.map((question) => question.id)),
  );

  const limited = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?${filterQuery}&limit=1&offset=0`,
  );
  assert.equal(limited.response.status, 200);
  assert.equal(limited.body.items.length, 1);
  assert.equal(limited.body.pagination.limit, 1);
  assert.equal(limited.body.pagination.total, 5);

  for (const query of ["limit=0", "limit=101", "offset=-1"]) {
    const invalid = await instructorRequest(
      api.baseUrl,
      `/instructor/questions?${query}`,
    );
    assert.equal(invalid.response.status, 400, query);
  }
});

test("instructor pagination stays correct when later-page questions are edited, published, or archived", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());
  const limit = 2;
  const readPage = (marker, status, offset) =>
    instructorRequest(
      api.baseUrl,
      `/instructor/questions?search=${encodeURIComponent(marker)}&status=${status}&limit=${limit}&offset=${offset}`,
    );
  const makeQuestions = async (marker, publish = false) => {
    const questions = [];
    for (let index = 0; index < 5; index += 1) {
      const question = await createQuestion(api.baseUrl, {
        topic: `${marker} question ${index}`,
      });
      if (publish) await publishQuestion(api.baseUrl, question.id);
      questions.push(question);
    }
    return questions;
  };
  const loadOrderedIds = async (marker, status) => {
    const result = await instructorRequest(
      api.baseUrl,
      `/instructor/questions?search=${encodeURIComponent(marker)}&status=${status}&limit=10&offset=0`,
    );
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.pagination, {
      offset: 0,
      limit: 10,
      total: 5,
      hasNext: false,
      nextOffset: null,
    });
    return result.body.items.map((question) => question.id);
  };
  const pickFromLaterPage = async (marker, status) => {
    const laterPage = await readPage(marker, status, 2);
    assert.equal(
      laterPage.response.status,
      200,
      JSON.stringify(laterPage.body),
    );
    assert.equal(laterPage.body.items.length, 2);
    assert.equal(laterPage.body.pagination.offset, 2);
    return laterPage.body.items[0].id;
  };

  const editMarker = `later-page-edit-${crypto.randomUUID()}`;
  await makeQuestions(editMarker);
  const orderedDraftIds = await loadOrderedIds(editMarker, "draft");
  const editedId = await pickFromLaterPage(editMarker, "draft");
  assert.equal(orderedDraftIds.slice(2, 4).includes(editedId), true);
  const movedMarker = `edited-out-of-filter-${crypto.randomUUID()}`;
  await updateQuestion(api.baseUrl, editedId, {
    topic: `${movedMarker} updated`,
  });
  const remainingDraftIds = orderedDraftIds.filter((id) => id !== editedId);
  assertInstructorQuestionPage(
    await readPage(editMarker, "draft", 0),
    remainingDraftIds,
    { limit, offset: 0 },
  );
  assertInstructorQuestionPage(
    await readPage(editMarker, "draft", 2),
    remainingDraftIds,
    { limit, offset: 2 },
  );
  const editedQuestionPage = await readPage(movedMarker, "draft", 0);
  assertInstructorQuestionPage(editedQuestionPage, [editedId], {
    limit,
    offset: 0,
  });

  const publishMarker = `later-page-publish-${crypto.randomUUID()}`;
  await makeQuestions(publishMarker);
  const orderedPublishDraftIds = await loadOrderedIds(publishMarker, "draft");
  const publishedId = await pickFromLaterPage(publishMarker, "draft");
  assert.equal(orderedPublishDraftIds.slice(2, 4).includes(publishedId), true);
  await publishQuestion(api.baseUrl, publishedId);
  const remainingPublishDraftIds = orderedPublishDraftIds.filter(
    (id) => id !== publishedId,
  );
  assertInstructorQuestionPage(
    await readPage(publishMarker, "draft", 0),
    remainingPublishDraftIds,
    { limit, offset: 0 },
  );
  assertInstructorQuestionPage(
    await readPage(publishMarker, "draft", 2),
    remainingPublishDraftIds,
    { limit, offset: 2 },
  );
  assertInstructorQuestionPage(
    await readPage(publishMarker, "published", 0),
    [publishedId],
    { limit, offset: 0 },
  );

  const archiveMarker = `later-page-archive-${crypto.randomUUID()}`;
  await makeQuestions(archiveMarker, true);
  const orderedPublishedIds = await loadOrderedIds(archiveMarker, "published");
  const archivedId = await pickFromLaterPage(archiveMarker, "published");
  assert.equal(orderedPublishedIds.slice(2, 4).includes(archivedId), true);
  await archiveQuestion(api.baseUrl, archivedId);
  const remainingPublishedIds = orderedPublishedIds.filter(
    (id) => id !== archivedId,
  );
  assertInstructorQuestionPage(
    await readPage(archiveMarker, "published", 0),
    remainingPublishedIds,
    { limit, offset: 0 },
  );
  assertInstructorQuestionPage(
    await readPage(archiveMarker, "published", 2),
    remainingPublishedIds,
    { limit, offset: 2 },
  );
  assertInstructorQuestionPage(
    await readPage(archiveMarker, "archived", 0),
    [archivedId],
    { limit, offset: 0 },
  );
});

test("instructor question library searches topic and question text and combines with filters", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const searchTerm = `search marker ${Date.now()}`;
  const topicMatch = await createQuestion(api.baseUrl, {
    topic: `${searchTerm} in the topic`,
  });
  const questionMatch = await createQuestion(api.baseUrl, {
    topic: "A different topic",
    question: `Which response addresses the ${searchTerm}?`,
  });
  const differentDomain = await createQuestion(api.baseUrl, {
    topic: `${searchTerm} in another domain`,
    domain: "Process",
  });

  const search = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?search=${encodeURIComponent(searchTerm.toUpperCase())}`,
  );
  assert.equal(search.response.status, 200);
  const searchIds = new Set(search.body.items.map((question) => question.id));
  assert.equal(searchIds.has(topicMatch.id), true);
  assert.equal(searchIds.has(questionMatch.id), true);
  assert.equal(searchIds.has(differentDomain.id), true);

  const noMatch = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?search=${encodeURIComponent(`no match ${Date.now()}`)}`,
  );
  assert.equal(noMatch.response.status, 200);
  assert.deepEqual(noMatch.body.items, []);

  const combined = await instructorRequest(
    api.baseUrl,
    `/instructor/questions?search=${encodeURIComponent(searchTerm)}&status=draft&domain=People&approach=agile&difficulty=easy`,
  );
  assert.equal(combined.response.status, 200);
  const combinedIds = new Set(
    combined.body.items.map((question) => question.id),
  );
  assert.equal(combinedIds.has(topicMatch.id), true);
  assert.equal(combinedIds.has(questionMatch.id), true);
  assert.equal(combinedIds.has(differentDomain.id), false);
});

test("invalid answer indexes return the documented error", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const invalidCreate = await instructorRequest(
    api.baseUrl,
    "/instructor/questions",
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ ...questionFields, correctAnswer: 2 }),
    },
  );
  assert.equal(invalidCreate.response.status, 400);
  assert.deepEqual(invalidCreate.body, {
    error: "correctAnswer must point to one of the provided options",
  });

  const question = await createQuestion(api.baseUrl);
  const invalidUpdate = await instructorRequest(
    api.baseUrl,
    `/instructor/questions/${question.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...questionFields, correctAnswer: 2 }),
    },
  );
  assert.equal(invalidUpdate.response.status, 400);
  assert.deepEqual(invalidUpdate.body, {
    error: "correctAnswer must point to one of the provided options",
  });
  await archiveQuestion(api.baseUrl, question.id);
});

test("missing questions return the documented not-found error", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());
  const missingId = `missing-${Date.now()}`;

  const update = await instructorRequest(
    api.baseUrl,
    `/instructor/questions/${missingId}`,
    {
      method: "PATCH",
      body: JSON.stringify(questionFields),
    },
  );
  const publish = await instructorRequest(
    api.baseUrl,
    `/instructor/questions/${missingId}/publish`,
    {
      method: "POST",
    },
  );
  const archive = await instructorRequest(
    api.baseUrl,
    `/instructor/questions/${missingId}/archive`,
    {
      method: "POST",
    },
  );
  const restore = await instructorRequest(
    api.baseUrl,
    `/instructor/questions/${missingId}/restore`,
    {
      method: "POST",
    },
  );

  for (const result of [update, publish, archive, restore]) {
    assert.equal(result.response.status, 404);
    assert.deepEqual(result.body, { error: "Question not found" });
  }
});

test("practice resume restores saved answers and excludes completed, abandoned, or foreign sessions", async (t) => {
  const api = await startApi();
  t.after(() => api.stop());

  const questions = [
    await createQuestion(api.baseUrl, {
      topic: `Resume question one ${Date.now()}`,
    }),
    await createQuestion(api.baseUrl, {
      topic: `Resume question two ${Date.now()}`,
    }),
  ];
  for (const question of questions)
    await publishQuestion(api.baseUrl, question.id);

  const learnerId = `learner-resume-${crypto.randomUUID()}`;
  const otherLearnerId = `learner-resume-other-${crypto.randomUUID()}`;
  const learnerHeaders = {
    "content-type": "application/json",
    "x-learner-id": learnerId,
  };
  const otherLearnerHeaders = {
    "content-type": "application/json",
    "x-learner-id": otherLearnerId,
  };
  const createSession = async () =>
    request(api.baseUrl, "/practice/sessions", {
      method: "POST",
      headers: learnerHeaders,
      body: JSON.stringify({
        mode: "quick",
        domain: null,
        approach: null,
        timed: false,
        questionIds: questions.map((question) => question.id),
      }),
    });
  const inProgress = () =>
    request(api.baseUrl, "/practice/sessions/in-progress", {
      headers: learnerHeaders,
    });

  const created = await createSession();
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "in_progress");

  const savedAnswer = await request(
    api.baseUrl,
    `/practice/sessions/${created.body.id}`,
    {
      method: "POST",
      headers: learnerHeaders,
      body: JSON.stringify({
        questionId: questions[0].id,
        selectedAnswer: 1,
      }),
    },
  );
  assert.equal(
    savedAnswer.response.status,
    200,
    JSON.stringify(savedAnswer.body),
  );

  const secondCreated = await createSession();
  assert.equal(
    secondCreated.response.status,
    201,
    JSON.stringify(secondCreated.body),
  );
  assert.notEqual(secondCreated.body.id, created.body.id);

  const resumed = await inProgress();
  assert.equal(resumed.response.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.length, 2);
  const resumedFirst = resumed.body.find(
    (session) => session.id === created.body.id,
  );
  const resumedSecond = resumed.body.find(
    (session) => session.id === secondCreated.body.id,
  );
  assert.ok(resumedFirst);
  assert.ok(resumedSecond);
  assert.deepEqual(
    resumedFirst.questionIds,
    questions.map((question) => question.id),
  );
  assert.deepEqual(
    resumedFirst.questions.map((question) => question.id),
    questions.map((question) => question.id),
  );
  assert.deepEqual(
    resumedFirst.answers.map(({ questionId, selectedAnswer }) => ({
      questionId,
      selectedAnswer,
    })),
    [{ questionId: questions[0].id, selectedAnswer: 1 }],
  );

  const foreignResume = await request(
    api.baseUrl,
    "/practice/sessions/in-progress",
    {
      headers: otherLearnerHeaders,
    },
  );
  assert.equal(foreignResume.response.status, 200);
  assert.deepEqual(foreignResume.body, []);
  const foreignDetail = await request(
    api.baseUrl,
    `/practice/sessions/${created.body.id}`,
    { headers: otherLearnerHeaders },
  );
  assert.equal(foreignDetail.response.status, 404);
  const foreignAnswer = await request(
    api.baseUrl,
    `/practice/sessions/${created.body.id}`,
    {
      method: "POST",
      headers: otherLearnerHeaders,
      body: JSON.stringify({ questionId: questions[1].id, selectedAnswer: 0 }),
    },
  );
  assert.equal(foreignAnswer.response.status, 404);

  const completed = await request(
    api.baseUrl,
    `/practice/sessions/${created.body.id}/complete`,
    { method: "POST", headers: learnerHeaders },
  );
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.status, "completed");
  const afterCompletion = await inProgress();
  assert.equal(afterCompletion.response.status, 200);
  assert.deepEqual(
    afterCompletion.body.map((session) => session.id),
    [secondCreated.body.id],
  );

  const abandoned = await request(
    api.baseUrl,
    `/practice/sessions/${secondCreated.body.id}/abandon`,
    { method: "POST", headers: learnerHeaders },
  );
  assert.equal(abandoned.response.status, 200, JSON.stringify(abandoned.body));
  assert.equal(abandoned.body.status, "abandoned");
  const afterAbandonment = await inProgress();
  assert.equal(afterAbandonment.response.status, 200);
  assert.deepEqual(afterAbandonment.body, []);

  await Promise.all(
    questions.map((question) => archiveQuestion(api.baseUrl, question.id)),
  );
});
