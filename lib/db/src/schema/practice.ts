import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const practiceModes = ["quick", "domain", "mock"] as const;
export const practiceSessionStatuses = ["in_progress", "completed", "abandoned"] as const;
export const practiceCompletionReasons = ["manual", "time_expired"] as const;

export const practiceSessionsTable = pgTable(
  "practice_sessions",
  {
    id: text("id").primaryKey(),
    learnerId: text("learner_id").notNull(),
    mode: text("mode", { enum: practiceModes }).notNull(),
    domain: text("domain"),
    approach: text("approach"),
    timed: boolean("timed").notNull().default(false),
    questionIds: jsonb("question_ids").$type<string[]>().notNull(),
    status: text("status", { enum: practiceSessionStatuses })
      .notNull()
      .default("in_progress"),
    completionReason: text("completion_reason", { enum: practiceCompletionReasons })
      .notNull()
      .default("manual"),
    score: integer("score"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("practice_sessions_learner_idx").on(table.learnerId)],
);

export const practiceAnswersTable = pgTable(
  "practice_answers",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    questionId: text("question_id").notNull(),
    selectedAnswer: integer("selected_answer").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("practice_answers_session_question_idx").on(
      table.sessionId,
      table.questionId,
    ),
    index("practice_answers_session_idx").on(table.sessionId),
  ],
);

export const bookmarksTable = pgTable(
  "bookmarks",
  {
    id: text("id").primaryKey(),
    learnerId: text("learner_id").notNull(),
    questionId: text("question_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bookmarks_learner_question_idx").on(
      table.learnerId,
      table.questionId,
    ),
    index("bookmarks_learner_idx").on(table.learnerId),
  ],
);

export const insertPracticeSessionSchema = createInsertSchema(
  practiceSessionsTable,
).omit({
  id: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
  score: true,
  status: true,
});

export const insertPracticeAnswerSchema = createInsertSchema(
  practiceAnswersTable,
).omit({
  id: true,
  answeredAt: true,
});

export const insertBookmarkSchema = createInsertSchema(bookmarksTable).omit({
  id: true,
  createdAt: true,
});

export type PracticeSession = typeof practiceSessionsTable.$inferSelect;
export type PracticeAnswer = typeof practiceAnswersTable.$inferSelect;
export type Bookmark = typeof bookmarksTable.$inferSelect;
export type InsertPracticeSession = z.infer<typeof insertPracticeSessionSchema>;
export type InsertPracticeAnswer = z.infer<typeof insertPracticeAnswerSchema>;
export type InsertBookmark = z.infer<typeof insertBookmarkSchema>;