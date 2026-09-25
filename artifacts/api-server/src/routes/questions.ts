import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  questionsTable,
  questionApproaches,
  questionDifficulties,
  questionDomains,
  questionStatuses,
  type Question,
} from "@workspace/db";
import {
  ArchiveQuestionParams,
  ArchiveQuestionResponse,
  CreateQuestionBody,
  CreateQuestionHeader,
  CreateQuestionResponse,
  ListInstructorQuestionsQueryParams,
  ListInstructorQuestionsResponse,
  ListPublishedQuestionsQueryParams,
  ListPublishedQuestionsResponse,
  PublishQuestionParams,
  PublishQuestionResponse,
  RestoreQuestionParams,
  RestoreQuestionResponse,
  UpdateQuestionBody,
  UpdateQuestionParams,
  UpdateQuestionResponse,
} from "@workspace/api-zod";
import { starterQuestions } from "../lib/question-seed";

const router: IRouter = Router();

function questionResponse(question: Question) {
  return {
    ...question,
    options: question.options,
  };
}

function matchesQuestionInput(
  question: Question,
  input: ReturnType<typeof CreateQuestionBody.parse>,
): boolean {
  return (
    question.domain === input.domain &&
    question.topic === input.topic &&
    question.approach === input.approach &&
    question.difficulty === input.difficulty &&
    question.question === input.question &&
    question.translation === input.translation &&
    JSON.stringify(question.options) === JSON.stringify(input.options) &&
    question.correctAnswer === input.correctAnswer &&
    question.explanation === input.explanation
  );
}

function validateAnswerIndex(
  correctAnswer: number,
  options: string[],
): string | null {
  if (correctAnswer >= options.length) {
    return "correctAnswer must point to one of the provided options";
  }
  return null;
}

async function seedQuestionsIfEmpty(): Promise<void> {
  const existing = await db
    .select({ id: questionsTable.id })
    .from(questionsTable)
    .limit(1);
  if (existing.length === 0) {
    await db.insert(questionsTable).values(
      starterQuestions.map((question) => ({
        ...question,
        status: "published" as const,
      })),
    );
  }
}

function filtersFor(params: {
  search?: string;
  domain?: (typeof questionDomains)[number];
  approach?: (typeof questionApproaches)[number];
  difficulty?: (typeof questionDifficulties)[number];
  status?: (typeof questionStatuses)[number];
}): SQL[] {
  const filters: SQL[] = [];
  const search = params.search?.trim();
  if (search) {
    const searchPattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    filters.push(
      or(
        ilike(questionsTable.topic, searchPattern),
        ilike(questionsTable.question, searchPattern),
      )!,
    );
  }
  if (params.domain) filters.push(eq(questionsTable.domain, params.domain));
  if (params.approach) filters.push(eq(questionsTable.approach, params.approach));
  if (params.difficulty) filters.push(eq(questionsTable.difficulty, params.difficulty));
  if (params.status) filters.push(eq(questionsTable.status, params.status));
  return filters;
}

router.get("/questions", async (req, res): Promise<void> => {
  const parsed = ListPublishedQuestionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await seedQuestionsIfEmpty();
  const filters = filtersFor({ ...parsed.data, status: "published" });
  const questions = await db
    .select()
    .from(questionsTable)
    .where(and(...filters))
    .orderBy(desc(questionsTable.createdAt));

  res.json(ListPublishedQuestionsResponse.parse(questions.map(questionResponse)));
});

router.get("/instructor/questions", async (req, res): Promise<void> => {
  const parsed = ListInstructorQuestionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await seedQuestionsIfEmpty();
  const limit = parsed.data.limit ?? 25;
  const offset = parsed.data.offset ?? 0;
  const filters = filtersFor(parsed.data);
  const [totalResult, questions] = await Promise.all([
    db
      .select({ count: count() })
      .from(questionsTable)
      .where(and(...filters)),
    db
      .select()
      .from(questionsTable)
      .where(and(...filters))
      .orderBy(desc(questionsTable.updatedAt), desc(questionsTable.id))
      .limit(limit)
      .offset(offset),
  ]);
  const total = Number(totalResult[0]?.count ?? 0);
  const hasNext = offset + questions.length < total;

  res.json(ListInstructorQuestionsResponse.parse({
    items: questions.map(questionResponse),
    pagination: {
      offset,
      limit,
      total,
      hasNext,
      nextOffset: hasNext ? offset + limit : null,
    },
  }));
});

router.post("/instructor/questions", async (req, res): Promise<void> => {
  const parsedHeader = CreateQuestionHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  });
  if (!parsedHeader.success) {
    res.status(400).json({ error: "A valid Idempotency-Key UUID is required" });
    return;
  }

  const parsed = CreateQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const answerError = validateAnswerIndex(parsed.data.correctAnswer, parsed.data.options);
  if (answerError) {
    res.status(400).json({ error: answerError });
    return;
  }

  const id = `question-${parsedHeader.data["Idempotency-Key"].toLowerCase()}`;
  const [question] = await db
    .insert(questionsTable)
    .values({ ...parsed.data, id })
    .onConflictDoNothing({ target: questionsTable.id })
    .returning();

  if (question) {
    res.status(201).json(CreateQuestionResponse.parse(questionResponse(question)));
    return;
  }

  const [existing] = await db
    .select()
    .from(questionsTable)
    .where(eq(questionsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  if (!matchesQuestionInput(existing, parsed.data)) {
    res.status(409).json({
      error: "Idempotency-Key was already used for different question content",
    });
    return;
  }

  res.status(200).json(CreateQuestionResponse.parse(questionResponse(existing)));
});

router.patch("/instructor/questions/:id", async (req, res): Promise<void> => {
  const params = UpdateQuestionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const answerError = validateAnswerIndex(parsed.data.correctAnswer, parsed.data.options);
  if (answerError) {
    res.status(400).json({ error: answerError });
    return;
  }

  const [question] = await db
    .update(questionsTable)
    .set(parsed.data)
    .where(eq(questionsTable.id, params.data.id))
    .returning();
  if (!question) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  res.json(UpdateQuestionResponse.parse(questionResponse(question)));
});

router.post("/instructor/questions/:id/publish", async (req, res): Promise<void> => {
  const params = PublishQuestionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [question] = await db
    .update(questionsTable)
    .set({ status: "published" })
    .where(eq(questionsTable.id, params.data.id))
    .returning();
  if (!question) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  res.json(PublishQuestionResponse.parse(questionResponse(question)));
});

router.post("/instructor/questions/:id/archive", async (req, res): Promise<void> => {
  const params = ArchiveQuestionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [question] = await db
    .update(questionsTable)
    .set({ status: "archived" })
    .where(eq(questionsTable.id, params.data.id))
    .returning();
  if (!question) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  res.json(ArchiveQuestionResponse.parse(questionResponse(question)));
});

router.post("/instructor/questions/:id/restore", async (req, res): Promise<void> => {
  const params = RestoreQuestionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [question] = await db
    .update(questionsTable)
    .set({ status: "draft" })
    .where(and(
      eq(questionsTable.id, params.data.id),
      eq(questionsTable.status, "archived"),
    ))
    .returning();
  if (question) {
    res.json(RestoreQuestionResponse.parse(questionResponse(question)));
    return;
  }

  const [existing] = await db
    .select({ id: questionsTable.id })
    .from(questionsTable)
    .where(eq(questionsTable.id, params.data.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  res.status(409).json({ error: "Only archived questions can be restored" });
});

export default router;