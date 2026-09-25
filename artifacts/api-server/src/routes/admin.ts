import { and, asc, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  instructorAccessAuditTable,
  usersTable,
  type User,
} from "@workspace/db";
import {
  ListAdminUsersResponse,
  ListInstructorAccessAuditQueryParams,
  ListInstructorAccessAuditResponse,
  UpdateInstructorAccessBody,
  UpdateInstructorAccessParams,
  UpdateInstructorAccessResponse,
  GrantAdministratorAccessBody,
  GrantAdministratorAccessParams,
  GrantAdministratorAccessResponse,
  RevokeAdministratorAccessParams,
  RevokeAdministratorAccessResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/authorization";

const router: IRouter = Router();
router.use(requireAdmin);

function userName(user: Pick<User, "firstName" | "lastName">): string | null {
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || null;
}

function bootstrapAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

router.get("/users", async (_req, res): Promise<void> => {
  const users = await db
    .select()
    .from(usersTable)
    .orderBy(asc(usersTable.email), asc(usersTable.id));

  res.json(ListAdminUsersResponse.parse(users));
});

function auditSearchPattern(value: string | undefined): string | undefined {
  const query = value?.trim();
  return query
    ? `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    : undefined;
}

router.get("/access-audit", async (req, res): Promise<void> => {
  const parsed = ListInstructorAccessAuditQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (
    (parsed.data.account !== undefined && !parsed.data.account.trim()) ||
    (parsed.data.actor !== undefined && !parsed.data.actor.trim())
  ) {
    res.status(400).json({ error: "Account and actor filters must not be blank" });
    return;
  }

  const filters: SQL[] = [];
  const accountPattern = auditSearchPattern(parsed.data.account);
  if (accountPattern) {
    filters.push(
      or(
        ilike(instructorAccessAuditTable.targetId, accountPattern),
        ilike(instructorAccessAuditTable.targetEmail, accountPattern),
        ilike(instructorAccessAuditTable.targetName, accountPattern),
      )!,
    );
  }

  const actorPattern = auditSearchPattern(parsed.data.actor);
  if (actorPattern) {
    filters.push(
      or(
        ilike(instructorAccessAuditTable.actorId, actorPattern),
        ilike(instructorAccessAuditTable.actorEmail, actorPattern),
        ilike(instructorAccessAuditTable.actorName, actorPattern),
      )!,
    );
  }

  const entries = await db
    .select()
    .from(instructorAccessAuditTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(instructorAccessAuditTable.changedAt))
    .limit(50);

  res.json(ListInstructorAccessAuditResponse.parse(entries));
});

router.patch("/users/:id/role", async (req, res): Promise<void> => {
  const params = UpdateInstructorAccessParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateInstructorAccessBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const actor = req.user;
  if (!actor) {
    res.status(403).json({ error: "Administrator role required" });
    return;
  }

  const updatedUser = await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.data.id))
      .for("update");

    if (!target || target.role === "admin") return null;
    if (target.role === body.data.role) return target;

    const [updated] = await tx
      .update(usersTable)
      .set({ role: body.data.role, updatedAt: new Date() })
      .where(and(eq(usersTable.id, target.id), ne(usersTable.role, "admin")))
      .returning();

    if (!updated) return null;

    await tx.insert(instructorAccessAuditTable).values({
      actorId: actor.id,
      actorEmail: actor.email,
      actorName: userName(actor),
      targetId: target.id,
      targetEmail: target.email,
      targetName: userName(target),
      previousRole: target.role,
      newRole: updated.role,
    });

    return updated;
  });

  if (!updatedUser) {
    const [target] = await db
      .select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, params.data.id));

    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(400).json({ error: "Administrator access cannot be changed here" });
    return;
  }

  res.json(UpdateInstructorAccessResponse.parse(updatedUser));
});

router.post("/users/:id/admin-access", async (req, res): Promise<void> => {
  const params = GrantAdministratorAccessParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = GrantAdministratorAccessBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Explicit confirmation is required" });
    return;
  }

  const actor = req.user;
  if (!actor) {
    res.status(403).json({ error: "Administrator role required" });
    return;
  }

  type GrantResult =
    | { kind: "updated"; user: User }
    | { kind: "not-found" }
    | { kind: "actor-not-admin" }
    | { kind: "already-admin" };

  const result: GrantResult = await db.transaction(async (tx) => {
    // Share the revocation lock so an administrator cannot be removed while
    // granting a replacement from a stale authenticated request.
    await tx.execute(sql`select pg_advisory_xact_lock(741928051)`);

    const administrators = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.role, "admin"))
      .orderBy(asc(usersTable.id))
      .for("update");

    if (!administrators.some((user) => user.id === actor.id)) {
      return { kind: "actor-not-admin" };
    }

    const [target] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.data.id))
      .for("update");

    if (!target) return { kind: "not-found" };
    if (target.role === "admin") return { kind: "already-admin" };

    const [updated] = await tx
      .update(usersTable)
      .set({ role: "admin", updatedAt: new Date() })
      .where(and(eq(usersTable.id, target.id), eq(usersTable.role, target.role)))
      .returning();

    if (!updated) return { kind: "already-admin" };

    await tx.insert(instructorAccessAuditTable).values({
      actorId: actor.id,
      actorEmail: actor.email,
      actorName: userName(actor),
      targetId: target.id,
      targetEmail: target.email,
      targetName: userName(target),
      previousRole: target.role,
      newRole: updated.role,
    });

    return { kind: "updated", user: updated };
  });

  if (result.kind === "not-found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (result.kind === "actor-not-admin") {
    res.status(403).json({ error: "Administrator role required" });
    return;
  }
  if (result.kind === "already-admin") {
    res.status(409).json({ error: "This account already has administrator access" });
    return;
  }

  res.json(GrantAdministratorAccessResponse.parse(result.user));
});

router.delete("/users/:id/admin-access", async (req, res): Promise<void> => {
  const params = RevokeAdministratorAccessParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const actor = req.user;
  if (!actor) {
    res.status(403).json({ error: "Administrator role required" });
    return;
  }

  type RevocationResult =
    | { kind: "updated"; user: User }
    | { kind: "not-found" }
    | { kind: "not-admin" }
    | { kind: "actor-not-admin" }
    | { kind: "self" }
    | { kind: "last-admin" }
    | { kind: "bootstrap-admin" };

  const result: RevocationResult = await db.transaction(async (tx) => {
    // Serialize administrator revocations so simultaneous requests cannot each
    // observe themselves as the last remaining administrator.
    await tx.execute(sql`select pg_advisory_xact_lock(741928051)`);

    const administrators = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.role, "admin"))
      .orderBy(asc(usersTable.id))
      .for("update");

    if (!administrators.some((user) => user.id === actor.id)) {
      return { kind: "actor-not-admin" };
    }

    const target = administrators.find((user) => user.id === params.data.id);
    if (!target) {
      const [existingUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, params.data.id))
        .for("update");

      return existingUser ? { kind: "not-admin" } : { kind: "not-found" };
    }

    if (target.id === actor.id) return { kind: "self" };
    if (administrators.length <= 1) return { kind: "last-admin" };
    if (target.email && bootstrapAdminEmails().has(target.email.toLowerCase())) {
      return { kind: "bootstrap-admin" };
    }

    const [updated] = await tx
      .update(usersTable)
      .set({ role: "learner", updatedAt: new Date() })
      .where(and(eq(usersTable.id, target.id), eq(usersTable.role, "admin")))
      .returning();

    if (!updated) return { kind: "not-admin" };

    await tx.insert(instructorAccessAuditTable).values({
      actorId: actor.id,
      actorEmail: actor.email,
      actorName: userName(actor),
      targetId: target.id,
      targetEmail: target.email,
      targetName: userName(target),
      previousRole: target.role,
      newRole: updated.role,
    });

    return { kind: "updated", user: updated };
  });

  if (result.kind === "not-found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (result.kind === "actor-not-admin") {
    res.status(403).json({ error: "Administrator role required" });
    return;
  }
  if (result.kind === "self") {
    res.status(400).json({ error: "You cannot remove your own administrator access" });
    return;
  }
  if (result.kind === "last-admin") {
    res.status(409).json({ error: "The last administrator cannot be removed" });
    return;
  }
  if (result.kind === "bootstrap-admin") {
    res.status(409).json({
      error: "Remove this email from ADMIN_EMAILS before revoking administrator access",
    });
    return;
  }
  if (result.kind === "not-admin") {
    res.status(409).json({ error: "This account is not an administrator" });
    return;
  }

  res.json(RevokeAdministratorAccessResponse.parse(result.user));
});

export default router;