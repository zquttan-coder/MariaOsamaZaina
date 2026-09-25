import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  bookmarksTable,
  db,
  questionsTable,
} from "@workspace/db";
import {
  ListBookmarksResponse,
  ListBookmarkQuestionsResponse,
  UpdateBookmarkBody,
  UpdateBookmarkParams,
  UpdateBookmarkResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function learnerIdFrom(req: Request): string | null {
  const learnerId = req.get("x-learner-id")?.trim();
  return learnerId && learnerId.length <= 128 ? learnerId : null;
}

router.get("/bookmarks", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    res.status(400).json({ error: "Learner identity is required" });
    return;
  }
  const bookmarks = await db
    .select({ questionId: bookmarksTable.questionId })
    .from(bookmarksTable)
    .where(eq(bookmarksTable.learnerId, learnerId));
  res.json(ListBookmarksResponse.parse(bookmarks.map((bookmark) => bookmark.questionId)));
});

router.get("/bookmarks/questions", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    res.status(400).json({ error: "Learner identity is required" });
    return;
  }

  const savedQuestions = await db
    .select({ question: questionsTable })
    .from(bookmarksTable)
    .innerJoin(questionsTable, eq(bookmarksTable.questionId, questionsTable.id))
    .where(eq(bookmarksTable.learnerId, learnerId))
    .orderBy(bookmarksTable.createdAt);

  res.json(
    ListBookmarkQuestionsResponse.parse(
      savedQuestions.map(({ question }) => question),
    ),
  );
});

router.put("/bookmarks/:questionId", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    res.status(400).json({ error: "Learner identity is required" });
    return;
  }
  const params = UpdateBookmarkParams.safeParse(req.params);
  const parsed = UpdateBookmarkBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid bookmark request" });
    return;
  }

  const [question] = await db
    .select({ id: questionsTable.id })
    .from(questionsTable)
    .where(eq(questionsTable.id, params.data.questionId));
  if (!question) {
    res.status(400).json({ error: "Question not found" });
    return;
  }

  if (parsed.data.saved) {
    await db
      .insert(bookmarksTable)
      .values({
        id: `bookmark-${randomUUID()}`,
        learnerId,
        questionId: params.data.questionId,
      })
      .onConflictDoNothing({
        target: [bookmarksTable.learnerId, bookmarksTable.questionId],
      });
  } else {
    await db
      .delete(bookmarksTable)
      .where(
        and(
          eq(bookmarksTable.learnerId, learnerId),
          eq(bookmarksTable.questionId, params.data.questionId),
        ),
      );
  }

  res.json(
    UpdateBookmarkResponse.parse({
      questionId: params.data.questionId,
      saved: parsed.data.saved,
    }),
  );
});

export default router;