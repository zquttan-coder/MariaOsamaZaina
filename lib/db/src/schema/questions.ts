import { createInsertSchema } from "drizzle-zod";
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const questionDomains = [
  "People",
  "Process",
  "Business environment",
] as const;
export const questionApproaches = ["agile", "predictive", "hybrid"] as const;
export const questionDifficulties = ["easy", "medium", "hard"] as const;
export const questionStatuses = ["draft", "published", "archived"] as const;

export const questionsTable = pgTable("questions", {
  id: text("id").primaryKey(),
  domain: text("domain", { enum: questionDomains }).notNull(),
  topic: text("topic").notNull(),
  approach: text("approach", { enum: questionApproaches }).notNull(),
  difficulty: text("difficulty", { enum: questionDifficulties }).notNull(),
  question: text("question").notNull(),
  translation: text("translation").notNull().default(""),
  options: jsonb("options").$type<string[]>().notNull(),
  correctAnswer: integer("correct_answer").notNull(),
  explanation: text("explanation").notNull(),
  status: text("status", { enum: questionStatuses }).notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertQuestionSchema = createInsertSchema(questionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
});

export type InsertQuestion = z.infer<typeof insertQuestionSchema>;
export type Question = typeof questionsTable.$inferSelect;