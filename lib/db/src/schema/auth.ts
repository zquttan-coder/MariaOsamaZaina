import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const userRoles = ["learner", "instructor", "admin"] as const;

export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

export const usersTable = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: text("role", { enum: userRoles }).notNull().default("learner"),
  instructorPageSize: integer("instructor_page_size").notNull().default(25),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const instructorAccessAuditTable = pgTable(
  "instructor_access_audit",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actorId: varchar("actor_id").notNull(),
    actorEmail: varchar("actor_email"),
    actorName: varchar("actor_name"),
    targetId: varchar("target_id").notNull(),
    targetEmail: varchar("target_email"),
    targetName: varchar("target_name"),
    previousRole: text("previous_role", { enum: userRoles }).notNull(),
    newRole: text("new_role", { enum: userRoles }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("instructor_access_audit_changed_at_idx").on(table.changedAt)],
);

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;
export type InstructorAccessAudit = typeof instructorAccessAuditTable.$inferSelect;