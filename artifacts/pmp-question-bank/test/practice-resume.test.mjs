import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const chromiumPath = process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium";

async function unusedPort() {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHttp(url, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before starting${stderr() ? `: ${stderr()}` : ""}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start${stderr() ? `: ${stderr()}` : ""}`);
}

async function waitForJson(url, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited before starting${stderr() ? `: ${stderr()}` : ""}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chromium may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chromium did not start${stderr() ? `: ${stderr()}` : ""}`);
}

class CdpPage {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  async send(method, params = {}) {
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.webSocket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    for (const request of this.pending.values()) request.reject(new Error("CDP connection closed"));
    this.pending.clear();
    this.webSocket.close();
  }
}

async function connectToPage(debugPort, child, stderr) {
  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, child, stderr);
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chromium did not expose a page target");
  const webSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    webSocket.addEventListener("open", resolve, { once: true });
    webSocket.addEventListener("error", reject, { once: true });
  });
  return new CdpPage(webSocket);
}

function jsonResponse(status, body) {
  return {
    responseCode: status,
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "Cache-Control", value: "no-store" },
    ],
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
  };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

test(
  "learners can reload, resume at the next unanswered question, and see saved answers",
  { timeout: 60_000 },
  async () => {
    const webPort = await unusedPort();
    const debugPort = await unusedPort();
    const web = spawn("pnpm", ["run", "dev"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, BASE_PATH: "/", NODE_ENV: "test", PORT: String(webPort) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const browser = spawn(chromiumPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/pmp-question-bank-resume-${process.pid}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let webStderr = "";
    let browserStderr = "";
    web.stderr.setEncoding("utf8");
    browser.stderr.setEncoding("utf8");
    web.stderr.on("data", (chunk) => { webStderr += chunk; });
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

    const questions = Array.from({ length: 10 }, (_, index) => ({
      id: `resume-question-${index + 1}`,
      domain: "People",
      topic: `Resume test ${index + 1}`,
      approach: "agile",
      difficulty: "easy",
      question: `Resume flow question ${index + 1}?`,
      translation: "",
      options: ["First choice", "Second choice", "Third choice", "Fourth choice"],
      correctAnswer: 0,
      explanation: "Choose the response that best supports the project team.",
      status: "published",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const requests = [];
    const runtimeExceptions = [];
    const browserErrors = [];
    const sessions = [];
    const bookmarkedQuestionIds = new Set();
    const bookmarkFailuresRemaining = { save: 1, remove: 1 };
    const failedAbandonSessionIds = new Set(["resume-session-1"]);
    const confirmationMessages = [];
    let nextDialogAction = true;
    let learnerId = null;
    let page;
    let closing = false;

    const sessionResponse = (session) => ({
      ...session,
      questions: session.questionIds.map((id) => questions.find((question) => question.id === id)),
      answers: session.answers,
    });

    try {
      await waitForHttp(`http://127.0.0.1:${webPort}/`, web, () => webStderr);
      page = await connectToPage(debugPort, browser, () => browserStderr);
      page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
        runtimeExceptions.push({
          text: exceptionDetails.text,
          description: exceptionDetails.exception?.description,
        });
      });
      page.on("Runtime.consoleAPICalled", ({ type, args }) => {
        if (type === "error") browserErrors.push(args.map((argument) => argument.value ?? argument.description));
      });
      page.on("Page.javascriptDialogOpening", async ({ message }) => {
        confirmationMessages.push(message);
        const accept = nextDialogAction;
        nextDialogAction = true;
        await page.send("Page.handleJavaScriptDialog", { accept });
      });
      page.on("Fetch.requestPaused", async (request) => {
        try {
          const url = new URL(request.request.url);
          if (!url.pathname.startsWith("/api/")) {
            await page.send("Fetch.continueRequest", { requestId: request.requestId });
            return;
          }

          const method = request.request.method;
          const path = url.pathname;
          const headers = Object.fromEntries(
            Object.entries(request.request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
          );
          learnerId ??= headers["x-learner-id"] ?? null;
          requests.push({ method, path });
          const input = request.request.postData ? JSON.parse(request.request.postData) : {};
          let response = jsonResponse(200, []);

          if (path === "/api/auth/user") {
            response = jsonResponse(200, { user: null });
          } else if (path === "/api/questions") {
            response = jsonResponse(200, questions);
          } else if (path === "/api/progress/dashboard") {
            response = jsonResponse(200, {
              readinessScore: 0,
              questionCount: 0,
              completedSessions: 0,
              averageScore: 0,
              studyMinutes: 0,
              lastScore: null,
              recentActivity: [],
            });
          } else if (path === "/api/practice/sessions/latest") {
            response = jsonResponse(404, { error: "No completed practice session found" });
          } else if (path === "/api/practice/sessions/in-progress") {
            response = jsonResponse(
              200,
              headers["x-learner-id"] === learnerId
                ? sessions.filter((session) => session.status === "in_progress").map(sessionResponse)
                : [],
            );
          } else if (path === "/api/practice/sessions" && method === "POST") {
            const session = {
              id: `resume-session-${sessions.length + 1}`,
              mode: input.mode,
              domain: input.domain,
              approach: input.approach,
              timed: input.timed,
              questionIds: input.questionIds,
              status: "in_progress",
              completionReason: "manual",
              score: null,
              startedAt: new Date().toISOString(),
              completedAt: null,
              answers: [],
            };
            sessions.push(session);
            response = jsonResponse(201, sessionResponse(session));
          } else if (path.match(/^\/api\/practice\/sessions\/[^/]+$/) && method === "POST") {
            const sessionId = path.split("/").at(-1);
            const session = sessions.find((item) => item.id === sessionId);
            if (!session) throw new Error(`Unknown session: ${sessionId}`);
            const question = questions.find((item) => item.id === input.questionId);
            const answer = {
              id: `${session.id}-answer-${session.answers.length + 1}`,
              sessionId: session.id,
              questionId: input.questionId,
              selectedAnswer: input.selectedAnswer,
              isCorrect: input.selectedAnswer === question?.correctAnswer,
              answeredAt: new Date().toISOString(),
            };
            session.answers = [
              ...session.answers.filter((item) => item.questionId !== input.questionId),
              answer,
            ];
            response = jsonResponse(200, answer);
          } else if (path.match(/^\/api\/practice\/sessions\/[^/]+\/abandon$/) && method === "POST") {
            const sessionId = path.split("/").at(-2);
            const session = sessions.find((item) => item.id === sessionId);
            if (!session) throw new Error(`Unknown session: ${sessionId}`);
            if (failedAbandonSessionIds.delete(sessionId)) {
              response = jsonResponse(503, { error: "Temporary abandon failure" });
            } else {
              session.status = "abandoned";
              response = jsonResponse(200, sessionResponse(session));
            }
          } else if (path === "/api/bookmarks") {
            response = jsonResponse(200, [...bookmarkedQuestionIds]);
          } else if (path.startsWith("/api/bookmarks/") && method === "PUT") {
            const questionId = decodeURIComponent(path.slice("/api/bookmarks/".length));
            const action = input.saved ? "save" : "remove";
            if (bookmarkFailuresRemaining[action] > 0) {
              bookmarkFailuresRemaining[action] -= 1;
              response = jsonResponse(503, { error: "Temporary bookmark failure" });
            } else {
              if (input.saved) bookmarkedQuestionIds.add(questionId);
              else bookmarkedQuestionIds.delete(questionId);
              response = jsonResponse(200, { questionId, saved: input.saved });
            }
          }

          await page.send("Fetch.fulfillRequest", { requestId: request.requestId, ...response });
        } catch (error) {
          if (!closing) browserErrors.push([`interception error: ${String(error)}`]);
        }
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Fetch.enable", {
        patterns: [{ urlPattern: "*://*/*", requestStage: "Request" }],
      });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/` });

      const evaluate = async (expression) => {
        const result = await page.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        return result.result.value;
      };
      const waitFor = async (expression) => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (await evaluate(expression)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          `Timed out waiting for ${expression}\n` +
          `Requests: ${JSON.stringify(requests)}\n` +
          `Exceptions: ${JSON.stringify(runtimeExceptions)}\n` +
          `Browser errors: ${JSON.stringify(browserErrors)}\n` +
          `Page text: ${await evaluate("document.body?.innerText?.slice(0, 1200)")}`,
        );
      };
      const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);

      await waitFor("Boolean(document.querySelector('.app-frame'))");
      await click(".dashboard-heading button");
      await waitFor("Boolean(document.querySelector('.setup-page'))");
      await waitFor(
        "document.querySelector('.start-button') && !document.querySelector('.start-button').disabled",
      );
      await click(".toggle[aria-pressed='true']");
      await waitFor("document.querySelector('.toggle')?.getAttribute('aria-pressed') === 'false'");
      await click(".start-button");
      await waitFor(`document.querySelector('.question-main h1')?.textContent === ${JSON.stringify(questions[0].question)}`);
      await click('button[aria-label="حفظ السؤال"]');
      await waitFor("Boolean(document.querySelector('[data-testid=\"status-practice-bookmark-error\"]'))");
      assert.equal(
        await evaluate("document.querySelector('.session-tools button[aria-label=\"حفظ السؤال\"]')?.classList.contains('active')"),
        false,
      );
      assert.equal(bookmarkedQuestionIds.has(questions[0].id), false);
      await click('[data-testid="button-retry-practice-bookmark"]');
      await waitFor("document.querySelector('.session-tools button')?.getAttribute('aria-label') === 'إزالة الحفظ'");
      assert.equal(bookmarkedQuestionIds.has(questions[0].id), true);
      assert.equal(
        await evaluate("Boolean(document.querySelector('[data-testid=\"status-practice-bookmark-error\"]'))"),
        false,
      );
      await click('button[aria-label="إزالة الحفظ"]');
      await waitFor("Boolean(document.querySelector('[data-testid=\"status-practice-bookmark-error\"]'))");
      assert.equal(
        await evaluate("document.querySelector('.session-tools button[aria-label=\"إزالة الحفظ\"]')?.classList.contains('active')"),
        true,
      );
      assert.equal(bookmarkedQuestionIds.has(questions[0].id), true);
      await click('[data-testid="button-retry-practice-bookmark"]');
      await waitFor("document.querySelector('.session-tools button')?.getAttribute('aria-label') === 'حفظ السؤال'");
      assert.equal(bookmarkedQuestionIds.has(questions[0].id), false);
      assert.equal(
        await evaluate("Boolean(document.querySelector('[data-testid=\"status-practice-bookmark-error\"]'))"),
        false,
      );
      await evaluate(`document.querySelectorAll('.choices .choice')[1]?.click()`);
      await waitFor("document.querySelectorAll('.choices .choice')[1]?.getAttribute('aria-pressed') === 'true'");
      await click(".session-footer-actions button.primary-button");
      await waitFor(`document.querySelector('.question-main h1')?.textContent === ${JSON.stringify(questions[1].question)}`);
      assert.equal(sessions[0].status, "in_progress");
      assert.deepEqual(
        sessions[0].answers.map(({ questionId, selectedAnswer }) => ({ questionId, selectedAnswer })),
        [{ questionId: questions[0].id, selectedAnswer: 1 }],
      );

      const reloadComplete = new Promise((resolve) => {
        page.on("Page.loadEventFired", resolve);
      });
      await page.send("Page.reload", { ignoreCache: true });
      await reloadComplete;
      await waitFor(`document.querySelector('.question-main h1')?.textContent === ${JSON.stringify(questions[1].question)}`);
      await evaluate("document.querySelector('.main-nav button.nav-item')?.click()");
      await waitFor("Boolean(document.querySelector('.dashboard-heading'))");
      await waitFor("Boolean(document.querySelector('[data-testid=\"button-continue-session\"]'))");
      const dashboardProgress = await evaluate(
        "document.querySelector('.next-session-panel')?.innerText",
      );
      assert.match(dashboardProgress, /1\s*\/\s*10/);
      await click(".dashboard-heading button");
      await waitFor("Boolean(document.querySelector('.setup-page'))");
      await evaluate(`(() => {
        const [domain, approach] = document.querySelectorAll(".setup-page select");
        domain.value = "Process";
        domain.dispatchEvent(new Event("change", { bubbles: true }));
        approach.value = "predictive";
        approach.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor(
        "document.querySelector('.start-button') && !document.querySelector('.start-button').disabled",
      );
      await click(".start-button");
      await waitFor(`document.querySelector('.question-main h1')?.textContent === ${JSON.stringify(questions[0].question)}`);
      assert.equal(sessions.length, 2);
      assert.equal(sessions[1].domain, "Process");
      assert.equal(sessions[1].approach, "predictive");

      await evaluate("document.querySelector('.main-nav button.nav-item')?.click()");
      await waitFor("document.querySelectorAll('[data-testid=\"button-continue-session\"]').length === 2");
      const unfinishedSessions = await evaluate(
        "Array.from(document.querySelectorAll('[data-testid=\"button-continue-session\"]'), (button) => button.getAttribute('data-session-id'))",
      );
      assert.deepEqual(
        unfinishedSessions.slice().sort(),
        ["resume-session-1", "resume-session-2"],
      );
      const sessionContexts = await evaluate(
        "Array.from(document.querySelectorAll('.unfinished-session-item'), (item) => ({ id: item.querySelector('[data-testid=\"button-continue-session\"]')?.getAttribute('data-session-id'), context: item.querySelector('[data-testid=\"unfinished-session-context\"]')?.innerText }))",
      );
      const firstSessionContext = sessionContexts.find(({ id }) => id === "resume-session-1")?.context ?? "";
      const secondSessionContext = sessionContexts.find(({ id }) => id === "resume-session-2")?.context ?? "";
      assert.match(firstSessionContext, /المجال.*كل المجالات/);
      assert.match(firstSessionContext, /الأسلوب.*كل الأساليب/);
      assert.match(firstSessionContext, /بدأت/);
      assert.match(secondSessionContext, /المجال.*Process/);
      assert.match(secondSessionContext, /الأسلوب.*Predictive/);
      assert.notEqual(firstSessionContext, secondSessionContext);

      const dashboardAbandonActions = await evaluate(
        "Array.from(document.querySelectorAll('[data-testid=\"button-abandon-session\"]'), (button) => ({ id: button.getAttribute('data-session-id'), label: button.getAttribute('aria-label') }))",
      );
      assert.deepEqual(
        dashboardAbandonActions.map(({ id }) => id).sort(),
        ["resume-session-1", "resume-session-2"],
      );
      assert.equal(dashboardAbandonActions.every(({ label }) => /التخلي عن/.test(label)), true);

      const abandonRequestCountBeforeCancel = requests.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/abandon"),
      ).length;
      nextDialogAction = false;
      await click('[data-testid="button-abandon-session"][data-session-id="resume-session-1"]');
      assert.match(confirmationMessages.at(-1) ?? "", /هل تريد التخلي عن هذه الجلسة/);
      assert.equal(
        requests.filter(({ method, path }) => method === "POST" && path.endsWith("/abandon")).length,
        abandonRequestCountBeforeCancel,
      );
      assert.equal(sessions[0].status, "in_progress");

      await click('[data-testid="button-abandon-session"][data-session-id="resume-session-2"]');
      await waitFor("document.querySelectorAll('[data-testid=\"button-continue-session\"]').length === 1");
      assert.equal(sessions[1].status, "abandoned");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"button-continue-session\"]')?.getAttribute('data-session-id')"),
        "resume-session-1",
      );

      await click('[data-testid="button-abandon-session"][data-session-id="resume-session-1"]');
      await waitFor("Boolean(document.querySelector('[data-testid=\"status-dashboard-abandon-error\"]'))");
      assert.equal(sessions[0].status, "in_progress");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"button-continue-session\"]')?.getAttribute('data-session-id')"),
        "resume-session-1",
      );

      await click('[data-session-id="resume-session-1"]');
      await waitFor(`document.querySelector('.question-main h1')?.textContent === ${JSON.stringify(questions[1].question)}`);
      assert.deepEqual(
        await evaluate("Array.from(document.querySelectorAll('.choices .choice'), (choice) => choice.getAttribute('aria-pressed'))"),
        Array(4).fill("false"),
      );
      await click('button[aria-label="Abandon session"]');
      await waitFor("Boolean(document.querySelector('.dashboard-heading'))");
      await waitFor("document.querySelectorAll('[data-testid=\"button-continue-session\"]').length === 0");
      assert.equal(sessions[0].status, "abandoned");
      assert.equal(
        await evaluate("Boolean(document.querySelector('[data-testid=\"status-dashboard-abandon-error\"]'))"),
        false,
      );
      assert.equal(
        requests.some(({ method, path }) => method === "POST" && path.endsWith("/abandon")),
        true,
      );
      assert.equal(learnerId?.length > 0, true);
      assert.deepEqual(runtimeExceptions, []);
      assert.deepEqual(browserErrors, []);
    } finally {
      closing = true;
      await page?.close();
      await stopProcess(browser);
      await stopProcess(web);
    }
  },
);