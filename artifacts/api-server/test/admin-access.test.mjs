import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { Pool } from "pg";

async function unusedPort() {
  const server = (await import("node:http")).createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startApi(env = {}) {
  const port = await unusedPort();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const child = spawn("node", ["--enable-source-maps", "dist/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { logs += chunk; });
  }

  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/healthz`);
      if (response.ok) {
        return {
          origin,
          pool,
          child,
          async stop() {
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
  await pool.end();
  throw new Error(`API server did not start${logs ? `: ${logs}` : ""}`);
}

async function createUserAndSession(pool, role, sessionRole = role, emailOverride) {
  const id = randomUUID();
  const sid = randomUUID();
  const email = emailOverride ?? `${role}-${id}@example.test`;
  const name = role === "admin" ? "Access Admin" : "Test Learner";
  await pool.query(
    `insert into users (id, email, first_name, last_name, role)
     values ($1, $2, $3, $4, $5)`,
    [id, email, name.split(" ")[0], name.split(" ")[1], role],
  );
  const session = {
    user: {
      id,
      email,
      firstName: name.split(" ")[0],
      lastName: name.split(" ")[1],
      profileImageUrl: null,
      role: sessionRole,
    },
    access_token: "test-access-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  await pool.query(
    `insert into sessions (sid, sess, expire)
     values ($1, $2::jsonb, now() + interval '1 day')`,
    [sid, JSON.stringify(session)],
  );
  return { id, sid, email };
}

async function request(api, path, sid, options = {}) {
  return fetch(`${api.origin}/api${path}`, {
    ...options,
    headers: {
      "x-forwarded-proto": "http",
      ...(sid ? { cookie: `sid=${sid}` } : {}),
      ...options.headers,
    },
  });
}

test("administrators can safely grant and revoke instructor access with an audit trail", async (t) => {
  const api = await startApi();
  const admin = await createUserAndSession(api.pool, "admin", "learner");
  const learner = await createUserAndSession(api.pool, "learner");
  t.after(async () => {
    await api.pool.query(
      `delete from instructor_access_audit where actor_id = any($1::varchar[]) or target_id = any($1::varchar[])`,
      [[admin.id, learner.id]],
    );
    await api.pool.query("delete from sessions where sid = any($1::varchar[])", [[admin.sid, learner.sid]]);
    await api.pool.query("delete from users where id = any($1::varchar[])", [[admin.id, learner.id]]);
    await api.stop();
  });

  const learnerBlocked = await request(api, "/admin/users", learner.sid);
  assert.equal(learnerBlocked.status, 403);
  const anonymousBlocked = await request(api, "/admin/users");
  assert.equal(anonymousBlocked.status, 401);

  const adminState = await request(api, "/auth/user", admin.sid);
  assert.equal((await adminState.json()).user.role, "admin", "the database role overrides the stale session role");

  const missingOrigin = await request(api, `/admin/users/${learner.id}/role`, admin.sid, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "instructor" }),
  });
  assert.equal(missingOrigin.status, 403);

  const crossOrigin = await request(api, `/admin/users/${learner.id}/role`, admin.sid, {
    method: "PATCH",
    headers: {
      origin: "https://untrusted.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ role: "instructor" }),
  });
  assert.equal(crossOrigin.status, 403);

  const setRole = async (role) => request(api, `/admin/users/${learner.id}/role`, admin.sid, {
    method: "PATCH",
    headers: {
      origin: api.origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ role }),
  });

  const grant = await setRole("instructor");
  assert.equal(grant.status, 200, await grant.clone().text());
  assert.equal((await grant.json()).role, "instructor");
  const instructorState = await request(api, "/auth/user", learner.sid);
  assert.equal((await instructorState.json()).user.role, "instructor");
  const instructorEndpoint = await request(api, "/instructor/questions", learner.sid);
  assert.equal(instructorEndpoint.status, 200);

  const revoke = await setRole("learner");
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).role, "learner");
  const learnerState = await request(api, "/auth/user", learner.sid);
  assert.equal((await learnerState.json()).user.role, "learner");
  const instructorEndpointAfterRevoke = await request(api, "/instructor/questions", learner.sid);
  assert.equal(instructorEndpointAfterRevoke.status, 403);

  const protectedAdminRole = await request(api, `/admin/users/${admin.id}/role`, admin.sid, {
    method: "PATCH",
    headers: { origin: api.origin, "content-type": "application/json" },
    body: JSON.stringify({ role: "learner" }),
  });
  assert.equal(protectedAdminRole.status, 400);

  await api.pool.query(
    `insert into instructor_access_audit (
       actor_id, actor_email, actor_name, target_id, target_email, target_name,
       previous_role, new_role, changed_at
     )
     select $1,
       'other-actor-' || noise.number::text || '@example.test',
       'Other actor ' || noise.number::text,
       'other-target-' || $2 || '-' || noise.number::text,
       'other-target-' || noise.number::text || '@example.test',
       'Other target ' || noise.number::text,
       'learner', 'instructor', now() + noise.number * interval '1 second'
     from generate_series(1, 55) as noise(number)`,
    [admin.id, learner.id],
  );

  const auditResponse = await request(api, "/admin/access-audit", admin.sid);
  assert.equal(auditResponse.status, 200);
  const latestAudit = await auditResponse.json();
  assert.equal(latestAudit.length, 50);
  assert.equal(
    latestAudit.some((entry) => entry.targetId === learner.id),
    false,
    "the unfiltered history remains limited to its 50 newest entries",
  );

  const accountResponse = await request(
    api,
    `/admin/access-audit?account=${encodeURIComponent(learner.email)}`,
    admin.sid,
  );
  assert.equal(accountResponse.status, 200);
  const accountChanges = await accountResponse.json();
  assert.equal(accountChanges.length, 2, "account search should find matching entries older than the latest 50");

  const actorResponse = await request(
    api,
    `/admin/access-audit?actor=${encodeURIComponent("ACCESS ADMIN")}`,
    admin.sid,
  );
  assert.equal(actorResponse.status, 200);
  assert.equal((await actorResponse.json()).length, 2, "actor search should match names case-insensitively");

  const combinedResponse = await request(
    api,
    `/admin/access-audit?account=${encodeURIComponent("test learner")}&actor=${encodeURIComponent(admin.email)}`,
    admin.sid,
  );
  assert.equal(combinedResponse.status, 200);
  const combinedChanges = await combinedResponse.json();
  assert.equal(combinedChanges.length, 2);
  assert.ok(combinedChanges.some((entry) => entry.previousRole === "learner" && entry.newRole === "instructor"));
  assert.ok(combinedChanges.some((entry) => entry.previousRole === "instructor" && entry.newRole === "learner"));
  assert.ok(combinedChanges.every((entry) => Number.isFinite(Date.parse(entry.changedAt))));

  const noMatches = await request(api, "/admin/access-audit?account=no-such-account", admin.sid);
  assert.equal(noMatches.status, 200);
  assert.deepEqual(await noMatches.json(), []);
  const blankFilter = await request(api, "/admin/access-audit?account=%20%20", admin.sid);
  assert.equal(blankFilter.status, 400);
  const longFilter = await request(api, `/admin/access-audit?actor=${"a".repeat(201)}`, admin.sid);
  assert.equal(longFilter.status, 400);
});

test("administrators can promote an existing account only after confirmation and audit the grant", async (t) => {
  const api = await startApi({ ADMIN_EMAILS: "" });
  const admin = await createUserAndSession(api.pool, "admin", "learner");
  const instructor = await createUserAndSession(api.pool, "instructor");
  t.after(async () => {
    await api.pool.query(
      `delete from instructor_access_audit where actor_id = any($1::varchar[]) or target_id = any($1::varchar[])`,
      [[admin.id, instructor.id]],
    );
    await api.pool.query("delete from sessions where sid = any($1::varchar[])", [[admin.sid, instructor.sid]]);
    await api.pool.query("delete from users where id = any($1::varchar[])", [[admin.id, instructor.id]]);
    await api.stop();
  });

  const grantRequest = (id, body, origin = api.origin) => request(
    api,
    `/admin/users/${id}/admin-access`,
    admin.sid,
    {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );

  const missingOrigin = await grantRequest(instructor.id, { confirmed: true }, "");
  assert.equal(missingOrigin.status, 403);
  const missingConfirmation = await grantRequest(instructor.id);
  assert.equal(missingConfirmation.status, 400);
  const declinedConfirmation = await grantRequest(instructor.id, { confirmed: false });
  assert.equal(declinedConfirmation.status, 400);

  const grant = await grantRequest(instructor.id, { confirmed: true });
  assert.equal(grant.status, 200, await grant.clone().text());
  assert.equal((await grant.json()).role, "admin");
  const refreshedUser = await request(api, "/auth/user", instructor.sid);
  assert.equal((await refreshedUser.json()).user.role, "admin");

  const duplicateGrant = await grantRequest(instructor.id, { confirmed: true });
  assert.equal(duplicateGrant.status, 409);

  const selfGrant = await grantRequest(admin.id, { confirmed: true });
  assert.equal(selfGrant.status, 409, "an administrator cannot use the grant flow to alter their own role");

  const auditResponse = await request(api, "/admin/access-audit", admin.sid);
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  const grantEntry = audit.find((entry) => entry.actorId === admin.id && entry.targetId === instructor.id);
  assert.ok(grantEntry);
  assert.equal(grantEntry.previousRole, "instructor");
  assert.equal(grantEntry.newRole, "admin");
  assert.ok(Number.isFinite(Date.parse(grantEntry.changedAt)));
  assert.equal(
    audit.filter((entry) => entry.actorId === admin.id && entry.targetId === instructor.id).length,
    1,
    "rejected attempts must not create audit entries",
  );
});

test("administrator access can be revoked without locking out the final administrator", async (t) => {
  const api = await startApi({ ADMIN_EMAILS: "" });
  const firstAdmin = await createUserAndSession(api.pool, "admin", "learner");
  const secondAdmin = await createUserAndSession(api.pool, "admin", "learner");
  t.after(async () => {
    await api.pool.query(
      `delete from instructor_access_audit where actor_id = any($1::varchar[]) or target_id = any($1::varchar[])`,
      [[firstAdmin.id, secondAdmin.id]],
    );
    await api.pool.query("delete from sessions where sid = any($1::varchar[])", [[firstAdmin.sid, secondAdmin.sid]]);
    await api.pool.query("delete from users where id = any($1::varchar[])", [[firstAdmin.id, secondAdmin.id]]);
    await api.stop();
  });

  const selfRemoval = await request(api, `/admin/users/${firstAdmin.id}/admin-access`, firstAdmin.sid, {
    method: "DELETE",
    headers: { origin: api.origin },
  });
  assert.equal(selfRemoval.status, 400);

  const [removeSecond, removeFirst] = await Promise.all([
    request(api, `/admin/users/${secondAdmin.id}/admin-access`, firstAdmin.sid, {
      method: "DELETE",
      headers: { origin: api.origin },
    }),
    request(api, `/admin/users/${firstAdmin.id}/admin-access`, secondAdmin.sid, {
      method: "DELETE",
      headers: { origin: api.origin },
    }),
  ]);

  const responses = [removeSecond, removeFirst];
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 403).length, 1);

  const removedResponse = responses.find((response) => response.status === 200);
  const removed = await removedResponse.json();
  assert.equal(removed.role, "learner");

  const remainingAdmin = removed.id === firstAdmin.id ? secondAdmin : firstAdmin;
  const refreshedRole = await request(api, "/auth/user", removed.id === firstAdmin.id ? firstAdmin.sid : secondAdmin.sid);
  assert.equal((await refreshedRole.json()).user.role, "learner");

  const lockedOutAdmin = await request(api, "/admin/users", removed.id === firstAdmin.id ? firstAdmin.sid : secondAdmin.sid);
  assert.equal(lockedOutAdmin.status, 403);

  const auditResponse = await request(api, "/admin/access-audit", remainingAdmin.sid);
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  const revocation = audit.find((entry) => entry.targetId === removed.id);
  assert.ok(revocation);
  assert.equal(revocation.actorId, remainingAdmin.id);
  assert.equal(revocation.previousRole, "admin");
  assert.equal(revocation.newRole, "learner");
  assert.ok(Number.isFinite(Date.parse(revocation.changedAt)));

  const finalAdmin = await request(api, "/admin/users", remainingAdmin.sid);
  assert.equal(finalAdmin.status, 200);
});

test("administrator access cannot be revoked while its email remains bootstrapped", async (t) => {
  const api = await startApi({ ADMIN_EMAILS: "bootstrap-admin@example.test" });
  const actor = await createUserAndSession(api.pool, "admin");
  const target = await createUserAndSession(api.pool, "admin", "admin", "bootstrap-admin@example.test");
  t.after(async () => {
    await api.pool.query(
      `delete from instructor_access_audit where actor_id = any($1::varchar[]) or target_id = any($1::varchar[])`,
      [[actor.id, target.id]],
    );
    await api.pool.query("delete from sessions where sid = any($1::varchar[])", [[actor.sid, target.sid]]);
    await api.pool.query("delete from users where id = any($1::varchar[])", [[actor.id, target.id]]);
    await api.stop();
  });

  const revoke = await request(api, `/admin/users/${target.id}/admin-access`, actor.sid, {
    method: "DELETE",
    headers: { origin: api.origin },
  });
  assert.equal(revoke.status, 409);
  assert.match((await revoke.json()).error, /ADMIN_EMAILS/);

  const unchanged = await api.pool.query("select role from users where id = $1", [target.id]);
  assert.equal(unchanged.rows[0].role, "admin");
});