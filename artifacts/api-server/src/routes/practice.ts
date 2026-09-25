import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  practiceAnswersTable,
  practiceSessionsTable,
  questionsTable,
  type PracticeAnswer,
  type PracticeSession,
  type Question,
} from "@workspace/db";
import {
  CompletePracticeSessionResponse,
  CreatePracticeSessionBody,
  CreatePracticeSessionResponse,
  GetInProgressPracticeSessionResponse,
  GetLatestPracticeSessionResponse,
  GetPracticeSessionParams,
  GetPracticeSessionResponse,
  SavePracticeAnswerBody,
  SavePracticeAnswerResponse,
  CompletePracticeSessionParams,
  AbandonPracticeSessionParams,
  AbandonPracticeSessionResponse,
  SavePracticeAnswerParams,
  GetDashboardProgressResponse,
  ListPracticeSessionsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const PRACTICE_SECONDS_PER_QUESTION = 60;

function learnerIdFrom(req: Request): string | null {
  const learnerId = req.get("x-learner-id")?.trim();
  return learnerId && learnerId.length <= 128 ? learnerId : null;
}

function missingLearner(res: Response): void {
  res.status(400).json({ error: "Learner identity is required" });
}

async function sessionData(session: PracticeSession) {
  const [questions, answers] = await Promise.all([
    db
      .select()
      .from(questionsTable)
      .where(inArray(questionsTable.id, session.questionIds)),
    db
      .select()
      .from(practiceAnswersTable)
      .where(eq(practiceAnswersTable.sessionId, session.id))
      .orderBy(practiceAnswersTable.answeredAt),
  ]);
  const byId = new Map(questions.map((question) => [question.id, question]));
  return {
    ...session,
    questionIds: session.questionIds,
    questions: session.questionIds
      .map((id) => byId.get(id))
      .filter((question): question is Question => Boolean(question)),
    answers,
  };
}

async function findOwnedSession(learnerId: string, id: string) {
  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        eq(practiceSessionsTable.id, id),
        eq(practiceSessionsTable.learnerId, learnerId),
      ),
    );
  return session;
}

function answerResponse(answer: PracticeAnswer) {
  return {
    id: answer.id,
    sessionId: answer.sessionId,
    questionId: answer.questionId,
    selectedAnswer: answer.selectedAnswer,
    isCorrect: answer.isCorrect,
    answeredAt: answer.answeredAt,
  };
}

function completionReasonFor(session: PracticeSession, now = Date.now()) {
  if (
    session.timed &&
    now >=
      session.startedAt.getTime() +
        session.questionIds.length * PRACTICE_SECONDS_PER_QUESTION * 1000
  ) {
    return "time_expired" as const;
  }
  return "manual" as const;
}

async function finalizeExpiredTimedSessions(learnerId: string): Promise<void> {
  const sessions = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        eq(practiceSessionsTable.learnerId, learnerId),
        eq(practiceSessionsTable.status, "in_progress"),
      ),
    );
  const expiredSessions = sessions.filter(
    (session) => completionReasonFor(session) === "time_expired",
  );

  await Promise.all(
    expiredSessions.map(async (session) => {
      const answers = await db
        .select({ isCorrect: practiceAnswersTable.isCorrect })
        .from(practiceAnswersTable)
        .where(eq(practiceAnswersTable.sessionId, session.id));
      const score = session.questionIds.length
        ? Math.round(
            (answers.filter((answer) => answer.isCorrect).length /
              session.questionIds.length) *
              100,
          )
        : 0;
      const completedAt = new Date();

      await db
        .update(practiceSessionsTable)
        .set({
          status: "completed",
          completionReason: "time_expired",
          score,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(practiceSessionsTable.id, session.id),
            eq(practiceSessionsTable.learnerId, learnerId),
            eq(practiceSessionsTable.status, "in_progress"),
          ),
        );
    }),
  );
}

router.post("/practice/sessions", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }

  const parsed = CreatePracticeSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const uniqueQuestionIds = [...new Set(parsed.data.questionIds)];
  const questions = await db
    .select({ id: questionsTable.id })
    .from(questionsTable)
    .where(
      and(
        inArray(questionsTable.id, uniqueQuestionIds),
        eq(questionsTable.status, "published"),
      ),
    );
  const publishedIds = new Set(questions.map((question) => question.id));
  if (
    uniqueQuestionIds.length !== parsed.data.questionIds.length ||
    parsed.data.questionIds.some((id) => !publishedIds.has(id))
  ) {
    res.status(400).json({ error: "Every question must be published and unique" });
    return;
  }

  const [session] = await db
    .insert(practiceSessionsTable)
    .values({
      id: `session-${randomUUID()}`,
      learnerId,
      mode: parsed.data.mode,
      domain: parsed.data.domain ?? null,
      approach: parsed.data.approach ?? null,
      timed: parsed.data.timed,
      questionIds: parsed.data.questionIds,
      status: "in_progress",
    })
    .returning();

  res.status(201).json(
    CreatePracticeSessionResponse.parse(await sessionData(session)),
  );
});

router.get("/practice/sessions", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }

  const sessions = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        eq(practiceSessionsTable.learnerId, learnerId),
        eq(practiceSessionsTable.status, "completed"),
      ),
    )
    .orderBy(desc(practiceSessionsTable.completedAt));

  res.json(
    ListPracticeSessionsResponse.parse(
      sessions.map((session) => ({
        id: session.id,
        mode: session.mode,
        score: session.score ?? 0,
        questionCount: session.questionIds.length,
        completedAt: session.completedAt ?? session.startedAt,
        completionReason: session.completionReason,
      })),
    ),
  );
});

router.get("/practice/sessions/latest", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }

  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        eq(practiceSessionsTable.learnerId, learnerId),
        eq(practiceSessionsTable.status, "completed"),
      ),
    )
    .orderBy(desc(practiceSessionsTable.completedAt))
    .limit(1);

  if (!session) {
    res.status(404).json({ error: "No completed practice session found" });
    return;
  }

  res.json(GetLatestPracticeSessionResponse.parse(await sessionData(session)));
});

router.get("/practice/sessions/in-progress", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }

  await finalizeExpiredTimedSessions(learnerId);

  const sessions = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        eq(practiceSessionsTable.learnerId, learnerId),
        eq(practiceSessionsTable.status, "in_progress"),
      ),
    )
    .orderBy(desc(practiceSessionsTable.startedAt));

  res.json(
    GetInProgressPracticeSessionResponse.parse(
      await Promise.all(sessions.map((session) => sessionData(session))),
    ),
  );
});

router.get("/practice/sessions/:id", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }
  const params = GetPracticeSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const session = await findOwnedSession(learnerId, params.data.id);
  if (!session) {
    res.status(404).json({ error: "Practice session not found" });
    return;
  }

  res.json(GetPracticeSessionResponse.parse(await sessionData(session)));
});

router.post("/practice/sessions/:id", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }
  const params = SavePracticeAnswerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SavePracticeAnswerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const session = await findOwnedSession(learnerId, params.data.id);
  if (!session) {
    res.status(404).json({ error: "Practice session not found" });
    return;
  }
  if (session.status !== "in_progress") {
    res.status(400).json({ error: "Only in-progress sessions can be changed" });
    return;
  }
  if (!session.questionIds.includes(parsed.data.questionId)) {
    res.status(400).json({ error: "Question is not part of this session" });
    return;
  }

  const [question] = await db
    .select({ correctAnswer: questionsTable.correctAnswer })
    .from(questionsTable)
    .where(eq(questionsTable.id, parsed.data.questionId));
  if (!question || parsed.data.selectedAnswer >= 6) {
    res.status(400).json({ error: "Selected answer is invalid" });
    return;
  }

  const [answer] = await db
    .insert(practiceAnswersTable)
    .values({
      id: `answer-${randomUUID()}`,
      sessionId: session.id,
      questionId: parsed.data.questionId,
      selectedAnswer: parsed.data.selectedAnswer,
      isCorrect: parsed.data.selectedAnswer === question.correctAnswer,
    })
    .onConflictDoUpdate({
      target: [practiceAnswersTable.sessionId, practiceAnswersTable.questionId],
      set: {
        selectedAnswer: parsed.data.selectedAnswer,
        isCorrect: parsed.data.selectedAnswer === question.correctAnswer,
        answeredAt: new Date(),
      },
    })
    .returning();

  await db
    .update(practiceSessionsTable)
    .set({ updatedAt: new Date() })
    .where(eq(practiceSessionsTable.id, session.id));

  res.json(SavePracticeAnswerResponse.parse(answerResponse(answer)));
});

router.post("/practice/sessions/:id/complete", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }
  const params = CompletePracticeSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const session = await findOwnedSession(learnerId, params.data.id);
  if (!session) {
    res.status(404).json({ error: "Practice session not found" });
    return;
  }
  if (session.status === "completed") {
    res.json(CompletePracticeSessionResponse.parse(await sessionData(session)));
    return;
  }
  if (session.status === "abandoned") {
    res.status(400).json({ error: "Abandoned sessions cannot be completed" });
    return;
  }

  const answers = await db
    .select()
    .from(practiceAnswersTable)
    .where(eq(practiceAnswersTable.sessionId, session.id));
  const score = session.questionIds.length
    ? Math.round(
        (answers.filter((answer) => answer.isCorrect).length /
          session.questionIds.length) *
          100,
      )
    : 0;
  const [completed] = await db
    .update(practiceSessionsTable)
    .set({
      status: "completed",
      completionReason: completionReasonFor(session),
      score,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(practiceSessionsTable.id, session.id),
        eq(practiceSessionsTable.status, "in_progress"),
      ),
    )
    .returning();

  if (!completed) {
    const current = await findOwnedSession(learnerId, session.id);
    if (current?.status === "completed") {
      res.json(
        CompletePracticeSessionResponse.parse(await sessionData(current)),
      );
      return;
    }
    res.status(400).json({ error: "Practice session is no longer in progress" });
    return;
  }

  res.json(
    CompletePracticeSessionResponse.parse(await sessionData(completed)),
  );
});

router.post("/practice/sessions/:id/abandon", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }
  const params = AbandonPracticeSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const session = await findOwnedSession(learnerId, params.data.id);
  if (!session) {
    res.status(404).json({ error: "Practice session not found" });
    return;
  }
  if (session.status === "completed") {
    res.status(400).json({ error: "Completed sessions cannot be abandoned" });
    return;
  }
  if (session.status === "abandoned") {
    res.json(AbandonPracticeSessionResponse.parse(await sessionData(session)));
    return;
  }

  const [abandoned] = await db
    .update(practiceSessionsTable)
    .set({ status: "abandoned" })
    .where(
      and(
        eq(practiceSessionsTable.id, session.id),
        eq(practiceSessionsTable.learnerId, learnerId),
        eq(practiceSessionsTable.status, "in_progress"),
      ),
    )
    .returning();

  if (!abandoned) {
    const current = await findOwnedSession(learnerId, session.id);
    if (current?.status === "abandoned") {
      res.json(
        AbandonPracticeSessionResponse.parse(await sessionData(current)),
      );
      return;
    }
    res.status(400).json({ error: "Practice session is no longer in progress" });
    return;
  }

  res.json(AbandonPracticeSessionResponse.parse(await sessionData(abandoned)));
});

router.get("/progress/dashboard", async (req, res): Promise<void> => {
  const learnerId = learnerIdFrom(req);
  if (!learnerId) {
    missingLearner(res);
    return;
  }

  await finalizeExpiredTimedSessions(learnerId);

  const sessions = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        eq(practiceSessionsTable.learnerId, learnerId),
        eq(practiceSessionsTable.status, "completed"),
      ),
    )
    .orderBy(desc(practiceSessionsTable.completedAt));
  const questionCount = sessions.reduce(
    (total, session) => total + session.questionIds.length,
    0,
  );
  const scores = sessions
    .map((session) => session.score)
    .filter((score): score is number => score !== null);
  const studyMinutes = sessions.reduce((total, session) => {
    if (!session.completedAt) return total;
    return total + Math.max(1, Math.round((session.completedAt.getTime() - session.startedAt.getTime()) / 60000));
  }, 0);
  const recentActivity = sessions.slice(0, 5).map((session) => ({
    sessionId: session.id,
    score: session.score ?? 0,
    questionCount: session.questionIds.length,
    mode: session.mode,
    completedAt: session.completedAt ?? session.startedAt,
    completionReason: session.completionReason,
  }));

  res.json(
    GetDashboardProgressResponse.parse({
      readinessScore: Math.min(100, Math.round((questionCount / 300) * 100)),
      questionCount,
      completedSessions: sessions.length,
      averageScore: scores.length
        ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
        : 0,
      studyMinutes,
      lastScore: sessions[0]?.score ?? null,
      recentActivity,
    }),
  );
});

export default router;