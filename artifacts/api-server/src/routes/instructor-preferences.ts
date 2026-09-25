import { eq } from "drizzle-orm";
import {
  GetInstructorPreferencesResponse,
  UpdateInstructorPreferencesBody,
  UpdateInstructorPreferencesResponse,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/instructor/preferences", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [user] = await db
    .select({ pageSize: usersTable.instructorPageSize })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id));

  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  res.json(GetInstructorPreferencesResponse.parse(user));
});

router.put("/instructor/preferences", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = UpdateInstructorPreferencesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ instructorPageSize: parsed.data.pageSize, updatedAt: new Date() })
    .where(eq(usersTable.id, req.user.id))
    .returning({ pageSize: usersTable.instructorPageSize });

  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  res.json(UpdateInstructorPreferencesResponse.parse(user));
});

export default router;