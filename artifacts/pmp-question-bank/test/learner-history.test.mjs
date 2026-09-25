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
    for (const request of this.pending.values()) {
      request.reject(new Error("CDP connection closed"));
    }
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
  "learners can load saved questions and reports, remove bookmarks, and reopen an older result",
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
      `--user-data-dir=/tmp/pmp-question-bank-history-${process.pid}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let webStderr = "";
    let browserStderr = "";
    web.stderr.setEncoding("utf8");
    browser.stderr.setEncoding("utf8");
    web.stderr.on("data", (chunk) => { webStderr += chunk; });
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

    const savedQuestion = {
      id: "history-saved-question",
      domain: "People",
      topic: "Stakeholder communication",
      approach: "agile",
      difficulty: "medium",
      question: "How should the project manager respond to a stakeholder concern?",
      translation: "ترجمة سؤال محفوظ للاختبار",
      options: ["Review the concern", "Ignore it", "Escalate immediately", "Change the plan"],
      correctAnswer: 0,
      explanation: "Review the concern with the stakeholder.",
      status: "published",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const otherSavedQuestion = {
      ...savedQuestion,
      id: "history-other-saved-question",
      domain: "Process",
      difficulty: "hard",
      topic: "Risk response",
      question: "What should the team document before taking action?",
      translation: "وثّق قرارات الفريق قبل التنفيذ",
    };
    const olderQuestion = {
      id: "history-older-question",
      domain: "Process",
      topic: "Older session risk response",
      approach: "predictive",
      difficulty: "hard",
      question: "What should the project manager do after identifying this risk?",
      translation: "سؤال من جلسة أقدم",
      options: ["Review response options", "Accept without analysis", "Close the issue", "Transfer the project"],
      correctAnswer: 2,
      explanation: "Compare response options with the team before selecting a risk response.",
      status: "published",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const strongerDomainQuestion = {
      ...olderQuestion,
      id: "history-stronger-domain-question",
      domain: "People",
      topic: "Stakeholder engagement",
      question: "How should the project manager respond to a stakeholder concern?",
      options: ["Review the concern", "Ignore it", "Escalate immediately", "Change the plan"],
      correctAnswer: 0,
      explanation: "Review the concern with the stakeholder.",
    };
    const unansweredQuestion = {
      ...olderQuestion,
      id: "history-unanswered-question",
      topic: "Unanswered session question",
      question: "What should the project manager review before acting?",
      options: ["The impact and available responses", "Nothing further", "Only the schedule", "The project charter"],
      correctAnswer: 0,
      explanation: "Review the impact and response options before acting.",
    };
    const olderSession = {
      id: "history-older-session",
      mode: "quick",
      domain: null,
      approach: null,
      timed: false,
      questionIds: [olderQuestion.id, strongerDomainQuestion.id],
      status: "completed",
      completionReason: "manual",
      score: 37,
      startedAt: "2026-02-10T10:00:00.000Z",
      completedAt: "2026-02-10T10:05:00.000Z",
      questions: [olderQuestion, strongerDomainQuestion],
      answers: [{
        id: "history-older-answer",
        sessionId: "history-older-session",
        questionId: olderQuestion.id,
        selectedAnswer: 0,
        isCorrect: false,
        answeredAt: "2026-02-10T10:04:00.000Z",
      }, {
        id: "history-stronger-domain-answer",
        sessionId: "history-older-session",
        questionId: strongerDomainQuestion.id,
        selectedAnswer: 0,
        isCorrect: true,
        answeredAt: "2026-02-10T10:04:30.000Z",
      }],
    };
    const expiredSession = {
      ...olderSession,
      id: "history-expired-session",
      timed: true,
      questionIds: [olderQuestion.id, unansweredQuestion.id],
      completionReason: "time_expired",
      score: 0,
      completedAt: "2026-03-05T10:05:00.000Z",
      questions: [olderQuestion, unansweredQuestion],
      answers: [{
        id: "history-expired-answer",
        sessionId: "history-expired-session",
        questionId: olderQuestion.id,
        selectedAnswer: 0,
        isCorrect: false,
        answeredAt: "2026-03-05T10:04:00.000Z",
      }],
    };
    const unansweredOnlySession = {
      ...olderSession,
      id: "history-unanswered-only-session",
      questionIds: [unansweredQuestion.id],
      status: "completed",
      completionReason: "manual",
      score: 0,
      completedAt: "2026-03-06T10:05:00.000Z",
      questions: [unansweredQuestion],
      answers: [],
    };
    const newerSession = {
      id: "history-newer-session",
      mode: "mock",
      score: 83,
      questionCount: 5,
      completedAt: "2026-03-10T10:05:00.000Z",
      completionReason: "manual",
    };
    const olderSummary = {
      id: olderSession.id,
      mode: olderSession.mode,
      score: olderSession.score,
      questionCount: olderSession.questionIds.length,
      completedAt: olderSession.completedAt,
      completionReason: olderSession.completionReason,
    };
    const expiredSummary = {
      id: expiredSession.id,
      mode: expiredSession.mode,
      score: expiredSession.score,
      questionCount: expiredSession.questionIds.length,
      completedAt: expiredSession.completedAt,
      completionReason: expiredSession.completionReason,
    };
    const unansweredOnlySummary = {
      id: unansweredOnlySession.id,
      mode: unansweredOnlySession.mode,
      score: unansweredOnlySession.score,
      questionCount: unansweredOnlySession.questionIds.length,
      completedAt: unansweredOnlySession.completedAt,
      completionReason: unansweredOnlySession.completionReason,
    };

    let savedQuestions = [savedQuestion, otherSavedQuestion];
    let failNextSavedQuestionRemoval = false;
    let reportSessions = [];
    let holdLibraryResponse = true;
    let holdReportsResponse = true;
    let holdOlderSessionResponse = true;
    let holdExpiredSessionResponse = true;
    const heldLibraryRequests = [];
    const heldReportsRequests = [];
    const heldOlderSessionRequests = [];
    const heldExpiredSessionRequests = [];
    const requests = [];
    const runtimeExceptions = [];
    const browserErrors = [];
    let learnerId = null;
    const observedLearnerIds = new Set();
    let page;
    let closing = false;
    let loadEvents = 0;

    try {
      await waitForHttp(`http://127.0.0.1:${webPort}/`, web, () => webStderr);
      page = await connectToPage(debugPort, browser, () => browserStderr);
      page.on("Page.loadEventFired", () => { loadEvents += 1; });
      page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
        runtimeExceptions.push({
          text: exceptionDetails.text,
          description: exceptionDetails.exception?.description,
        });
      });
      page.on("Runtime.consoleAPICalled", ({ type, args }) => {
        if (type === "error") {
          browserErrors.push(args.map((argument) => argument.value ?? argument.description));
        }
      });
      page.on("Fetch.requestPaused", async (request) => {
        try {
          if (closing) return;
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
          const requestLearnerId = headers["x-learner-id"] ?? null;
          learnerId ??= requestLearnerId;
          if (requestLearnerId) observedLearnerIds.add(requestLearnerId);
          requests.push({ method, path });
          let response = jsonResponse(200, []);

          if (path === "/api/auth/user") {
            await new Promise((resolve) => setTimeout(resolve, 150));
            response = jsonResponse(200, { user: null });
          } else if (path === "/api/questions") {
            response = jsonResponse(200, []);
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
          } else if (path === "/api/practice/sessions/latest" || path === "/api/practice/sessions/in-progress") {
            response = jsonResponse(404, { error: "No practice session found" });
          } else if (path === "/api/bookmarks" && method === "GET") {
            response = jsonResponse(200, savedQuestions.map((question) => question.id));
          } else if (path === "/api/bookmarks/questions" && method === "GET") {
            if (holdLibraryResponse) {
              heldLibraryRequests.push(request.requestId);
              return;
            }
            response = jsonResponse(200, savedQuestions);
          } else if (path.startsWith("/api/bookmarks/") && method === "PUT") {
            const questionId = decodeURIComponent(path.slice("/api/bookmarks/".length));
            const input = request.request.postData ? JSON.parse(request.request.postData) : {};
            if (!input.saved && questionId === savedQuestion.id && failNextSavedQuestionRemoval) {
              failNextSavedQuestionRemoval = false;
              response = jsonResponse(503, { error: "Service temporarily unavailable" });
            } else {
              savedQuestions = input.saved
                ? [savedQuestion]
                : savedQuestions.filter((question) => question.id !== questionId);
              response = jsonResponse(200, { questionId, saved: input.saved });
            }
          } else if (path === "/api/practice/sessions" && method === "GET") {
            if (holdReportsResponse) {
              heldReportsRequests.push(request.requestId);
              return;
            }
            response = jsonResponse(200, reportSessions);
          } else if (path === `/api/practice/sessions/${olderSession.id}` && method === "GET") {
            if (holdOlderSessionResponse) {
              heldOlderSessionRequests.push(request.requestId);
              return;
            }
            response = jsonResponse(200, olderSession);
          } else if (path === `/api/practice/sessions/${expiredSession.id}` && method === "GET") {
            if (holdExpiredSessionResponse) {
              heldExpiredSessionRequests.push(request.requestId);
              return;
            }
            response = jsonResponse(200, expiredSession);
          } else if (path === `/api/practice/sessions/${unansweredOnlySession.id}` && method === "GET") {
            response = jsonResponse(200, unansweredOnlySession);
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
          `Page text: ${await evaluate("document.body?.innerText?.slice(0, 1600)")}`,
        );
      };
      const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);

      await waitFor("Boolean(document.querySelector('.app-frame'))");
      await waitFor("Boolean(document.querySelector('.auth-action')) && document.querySelector('.auth-action')?.textContent !== 'جارٍ التحقق…'");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await click('[data-testid="button-nav-library"]');
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-loading"]\'))');
      await waitFor("Boolean(document.querySelector('[data-testid=\"status-library-loading\"]'))");
      for (let attempt = 0; attempt < 80 && heldLibraryRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldLibraryRequests.length > 0, true, "library request should remain pending for its loading state");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldLibraryRequests.shift(),
        ...jsonResponse(503, { error: "Service temporarily unavailable" }),
      });

      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-error"]\'))');
      assert.equal(
        await evaluate('Boolean(document.querySelector(\'[data-testid="status-library-empty"]\'))'),
        false,
        "a failed saved-question request should not be presented as an empty library",
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-count\"] strong')?.textContent"),
        "—",
        "the library count should not imply there are no saved questions after a request failure",
      );
      await click('[data-testid="button-retry-library"]');
      for (let attempt = 0; attempt < 80 && heldLibraryRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldLibraryRequests.length > 0, true, "retry should make another saved-question request");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldLibraryRequests.shift(),
        ...jsonResponse(200, savedQuestions),
      });
      holdLibraryResponse = false;
      await waitFor(`Boolean(document.querySelector('[data-testid="card-saved-question-${savedQuestion.id}"]'))`);
      assert.equal(
        await evaluate(`document.querySelector('[data-testid="text-saved-question-${savedQuestion.id}"]')?.textContent`),
        savedQuestion.question,
      );
      assert.equal(await evaluate("document.querySelector('[data-testid=\"text-library-count\"] strong')?.textContent"), "2");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent"),
        "2 من 2 سؤال",
      );
      const setLibraryFilter = (selector, value) => evaluate(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setValue.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return select.value;
      })()`);
      await setLibraryFilter('[data-testid="select-library-domain"]', "People");
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${savedQuestion.id}"]'))`),
        true,
        "filtering to the People domain should keep its saved question visible",
      );
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 1);
      await setLibraryFilter('[data-testid="select-library-difficulty"]', "hard");
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-no-results"]\'))');
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent"),
        "0 من 2 سؤال",
        "domain and difficulty filters should combine",
      );
      await setLibraryFilter('[data-testid="select-library-domain"]', "all");
      await waitFor(`Boolean(document.querySelector('[data-testid="card-saved-question-${otherSavedQuestion.id}"]'))`);
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 1);
      const librarySearch = '[data-testid="input-library-search"]';
      const reloadAsLearner = async (nextLearnerId) => {
        const previousTimeOrigin = await evaluate("performance.timeOrigin");
        await evaluate(`(() => {
          localStorage.setItem("pmp-sprint-learner-id", ${JSON.stringify(nextLearnerId)});
          localStorage.setItem("pmp-sprint-page", "library");
        })()`);
        await page.send("Page.reload", { ignoreCache: true });
        await waitFor(
          `performance.timeOrigin !== ${JSON.stringify(previousTimeOrigin)} && document.readyState === "complete"`,
        );
        await waitFor("Boolean(document.querySelector('.app-frame'))");
        await waitFor(
          "Boolean(document.querySelector('.auth-action')) && document.querySelector('.auth-action')?.textContent !== 'جارٍ التحقق…'",
        );
        await waitFor(`Boolean(document.querySelector(${JSON.stringify(librarySearch)}))`);
        await waitFor("Boolean(document.querySelector('[data-testid=\"text-library-search-results\"]'))");
      };
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "risk" });
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${otherSavedQuestion.id}"]'))`),
        true,
        "text search should combine with the active difficulty filter",
      );
      await click('[data-testid="button-clear-library-search"]');
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "stakeholder" });
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-no-results"]\'))');
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent"),
        "0 من 2 سؤال",
        "the result count should include both search and difficulty filters",
      );
      await click('[data-testid="button-reset-library-filters"]');
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '2 من 2 سؤال'");
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 2);

      await setLibraryFilter('[data-testid="select-library-domain"]', "People");
      await setLibraryFilter('[data-testid="select-library-difficulty"]', "medium");
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "stakeholder" });
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      const savedFiltersKey = `pmp-question-bank:library-filters:${encodeURIComponent(learnerId)}`;
      await waitFor(`(() => {
        const saved = JSON.parse(localStorage.getItem(${JSON.stringify(savedFiltersKey)}));
        return saved?.searchTerm === "stakeholder"
          && saved?.domainFilter === "People"
          && saved?.difficultyFilter === "medium";
      })()`);
      await click('.main-nav button.nav-item:first-of-type');
      await waitFor('Boolean(document.querySelector(".dashboard-grid"))');
      await click('[data-testid="button-nav-library"]');
      await waitFor(`document.querySelector(${JSON.stringify(librarySearch)})?.value === "stakeholder"`);
      assert.equal(
        await evaluate('document.querySelector(\'[data-testid="select-library-domain"]\')?.value'),
        "People",
        "the saved domain filter should be restored when reopening the library",
      );
      assert.equal(
        await evaluate('document.querySelector(\'[data-testid="select-library-difficulty"]\')?.value'),
        "medium",
        "the saved difficulty filter should be restored when reopening the library",
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent"),
        "1 من 2 سؤال",
        "the saved search should be restored when reopening the library",
      );

      const secondLearnerId = "shared-device-learner-two";
      assert.notEqual(secondLearnerId, learnerId, "the shared browser profile should use two distinct learner identities");
      const secondSavedFiltersKey = `pmp-question-bank:library-filters:${encodeURIComponent(secondLearnerId)}`;
      await reloadAsLearner(secondLearnerId);
      await waitFor(`document.querySelector(${JSON.stringify(librarySearch)})?.value === "" &&
        document.querySelector('[data-testid="select-library-domain"]')?.value === "all" &&
        document.querySelector('[data-testid="select-library-difficulty"]')?.value === "all" &&
        document.querySelector('[data-testid="text-library-search-results"]')?.textContent === "2 من 2 سؤال"`);
      await setLibraryFilter('[data-testid="select-library-domain"]', "Process");
      await setLibraryFilter('[data-testid="select-library-difficulty"]', "hard");
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "risk" });
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      await waitFor(`(() => {
        const saved = JSON.parse(localStorage.getItem(${JSON.stringify(secondSavedFiltersKey)}));
        return saved?.searchTerm === "risk"
          && saved?.domainFilter === "Process"
          && saved?.difficultyFilter === "hard";
      })()`);
      await click('.main-nav button.nav-item:first-of-type');
      await waitFor('Boolean(document.querySelector(".dashboard-grid"))');
      await click('[data-testid="button-nav-library"]');
      await waitFor(`document.querySelector(${JSON.stringify(librarySearch)})?.value === "risk"`);
      assert.equal(
        await evaluate('document.querySelector(\'[data-testid="select-library-domain"]\')?.value'),
        "Process",
        "the second learner should restore its own domain filter",
      );
      assert.equal(
        await evaluate('document.querySelector(\'[data-testid="select-library-difficulty"]\')?.value'),
        "hard",
        "the second learner should restore its own difficulty filter",
      );

      await reloadAsLearner(learnerId);
      await waitFor(`document.querySelector(${JSON.stringify(librarySearch)})?.value === "stakeholder" &&
        document.querySelector('[data-testid="select-library-domain"]')?.value === "People" &&
        document.querySelector('[data-testid="select-library-difficulty"]')?.value === "medium" &&
        document.querySelector('[data-testid="text-library-search-results"]')?.textContent === "1 من 2 سؤال"`);
      assert.equal(
        await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(savedFiltersKey)}))?.searchTerm`),
        "stakeholder",
        "switching back should restore the first learner's saved search",
      );
      await click('[data-testid="button-reset-library-filters"]');
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '2 من 2 سؤال'");
      await waitFor(`localStorage.getItem(${JSON.stringify(savedFiltersKey)}) === null`);
      await waitFor(`document.querySelector(${JSON.stringify(librarySearch)})?.value === "" &&
        document.querySelector('[data-testid="select-library-domain"]')?.value === "all" &&
        document.querySelector('[data-testid="select-library-difficulty"]')?.value === "all"`);
      assert.equal(
        await evaluate(`localStorage.getItem(${JSON.stringify(savedFiltersKey)})`),
        null,
        "resetting the first learner's filters should clear only their saved state",
      );

      await reloadAsLearner(secondLearnerId);
      await waitFor(`document.querySelector(${JSON.stringify(librarySearch)})?.value === "risk" &&
        document.querySelector('[data-testid="select-library-domain"]')?.value === "Process" &&
        document.querySelector('[data-testid="select-library-difficulty"]')?.value === "hard" &&
        document.querySelector('[data-testid="text-library-search-results"]')?.textContent === "1 من 2 سؤال"`);
      assert.deepEqual(
        await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(secondSavedFiltersKey)}))`),
        { searchTerm: "risk", domainFilter: "Process", difficultyFilter: "hard" },
        "resetting the first learner should leave the second learner's saved view unchanged",
      );
      assert.equal(observedLearnerIds.has(learnerId), true);
      assert.equal(observedLearnerIds.has(secondLearnerId), true);
      await click('[data-testid="button-reset-library-filters"]');
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '2 من 2 سؤال'");
      await waitFor(`localStorage.getItem(${JSON.stringify(secondSavedFiltersKey)}) === null`);
      const libraryRequestsBeforeLocalFilters = requests.filter(
        ({ method, path }) => method === "GET" && path === "/api/bookmarks/questions",
      ).length;

      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "STAKEHOLDER" });
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent"),
        "1 من 2 سؤال",
        "searching by topic should keep the matching question visible",
      );
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 1);
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${otherSavedQuestion.id}"]'))`),
        false,
      );
      await click('[data-testid="button-clear-library-search"]');
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "respond" });
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 1);
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${savedQuestion.id}"]'))`),
        true,
        "searching question text should keep its matching question visible",
      );
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${otherSavedQuestion.id}"]'))`),
        false,
      );
      await click('[data-testid="button-clear-library-search"]');
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "سؤال محفوظ" });
      await waitFor("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent === '1 من 2 سؤال'");
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 1);
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${savedQuestion.id}"]'))`),
        true,
        "searching the Arabic question text should find its saved question",
      );
      await click('[data-testid="button-clear-library-search"]');
      await evaluate(`document.querySelector(${JSON.stringify(librarySearch)})?.focus()`);
      await page.send("Input.insertText", { text: "no matching question" });
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-no-results"]\'))');
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-search-results\"]')?.textContent"),
        "0 من 2 سؤال",
      );
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 0);
      await click('[data-testid="button-clear-library-search"]');
      await waitFor("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length === 2");
      assert.equal(
        requests.filter(({ method, path }) => method === "GET" && path === "/api/bookmarks/questions").length,
        libraryRequestsBeforeLocalFilters,
        "search and filter changes should not refetch saved questions",
      );
      const loadEventsBeforeRemoval = loadEvents;
      failNextSavedQuestionRemoval = true;
      await click(`[data-testid="button-remove-saved-question-${savedQuestion.id}"]`);
      await waitFor(`Boolean(document.querySelector('[data-testid="status-bookmark-removal-error-${savedQuestion.id}"]'))`);
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${savedQuestion.id}"]'))`),
        true,
        "a failed removal should keep the saved question visible",
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-library-count\"] strong')?.textContent"),
        "2",
        "a failed removal should preserve the saved-question count",
      );
      assert.equal(
        await evaluate(`document.querySelector('[data-testid="button-remove-saved-question-${savedQuestion.id}"]')?.textContent.includes('إعادة المحاولة')`),
        true,
        "the failed removal should offer a clear retry action",
      );
      await click(`[data-testid="button-remove-saved-question-${savedQuestion.id}"]`);
      await waitFor("document.querySelector('[data-testid=\"text-library-count\"] strong')?.textContent === '1'");
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="card-saved-question-${savedQuestion.id}"]'))`), false);
      assert.equal(
        await evaluate(`Boolean(document.querySelector('[data-testid="status-bookmark-removal-error-${savedQuestion.id}"]'))`),
        false,
        "a successful retry should clear the removal error",
      );
      assert.equal(
        requests.filter(({ method, path }) => method === "GET" && path === "/api/bookmarks/questions").length >= 2,
        true,
        "removing a saved question should refresh the saved-question API query",
      );
      assert.equal(loadEvents, loadEventsBeforeRemoval, "bookmark removal should not reload the page");
      await click(`[data-testid="button-remove-saved-question-${otherSavedQuestion.id}"]`);
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-empty"]\'))');
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"card-saved-question-\"]').length"), 0);
      assert.equal(
        requests.some(({ method, path }) => method === "PUT" && path === `/api/bookmarks/${savedQuestion.id}`),
        true,
      );

      await click('[data-testid="button-nav-reports"]');
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-reports-loading"]\'))');
      for (let attempt = 0; attempt < 80 && heldReportsRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldReportsRequests.length > 0, true, "reports request should remain pending for its loading state");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldReportsRequests.shift(),
        ...jsonResponse(200, []),
      });
      holdReportsResponse = false;
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-reports-empty"]\'))');
      assert.equal(await evaluate("document.querySelector('[data-testid=\"text-report-session-count\"]')?.textContent"), "0");
      assert.equal(await evaluate("document.querySelector('[data-testid=\"text-report-average-score\"]')?.textContent"), "—");

      reportSessions = [newerSession, olderSummary];
      holdReportsResponse = true;
      await click('[data-testid="button-nav-library"]');
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-library-empty"]\'))');
      await click('[data-testid="button-nav-reports"]');
      for (let attempt = 0; attempt < 80 && heldReportsRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldReportsRequests.length > 0, true, "reports should refresh when the history page is opened again");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldReportsRequests.shift(),
        ...jsonResponse(503, { error: "Service temporarily unavailable" }),
      });
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-reports-error"]\'))');
      assert.equal(
        await evaluate('Boolean(document.querySelector(\'[data-testid="status-reports-empty"]\'))'),
        false,
        "a failed reports request should not be presented as empty history",
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-report-session-count\"]')?.textContent"),
        "—",
        "the reports count should not imply there are no completed sessions after a request failure",
      );
      await click('[data-testid="button-retry-reports"]');
      for (let attempt = 0; attempt < 80 && heldReportsRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldReportsRequests.length > 0, true, "retry should make another reports request");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldReportsRequests.shift(),
        ...jsonResponse(200, reportSessions),
      });
      holdReportsResponse = false;

      await waitFor(`document.querySelectorAll('.session-history-row').length === 2 &&
        document.querySelector('[data-testid="text-report-session-count"]')?.textContent === '2'`);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"text-report-average-score\"]')?.textContent"), "60%");
      assert.deepEqual(
        await evaluate(`Array.from(document.querySelectorAll('.session-history-row'), (row) => row.dataset.testid)`),
        [`button-open-session-${newerSession.id}`, `button-open-session-${olderSession.id}`],
      );

      await click(`[data-testid="button-open-session-${olderSession.id}"]`);
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-session-detail-loading"]\'))');
      for (let attempt = 0; attempt < 80 && heldOlderSessionRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldOlderSessionRequests.length > 0, true, "selected session detail should load from the API");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldOlderSessionRequests.shift(),
        ...jsonResponse(200, olderSession),
      });
      holdOlderSessionResponse = false;

      await waitFor("Boolean(document.querySelector('.results-page .score-number'))");
      assert.equal(await evaluate("document.querySelector('.results-page .score-number')?.textContent"), "37%");
      assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"text-unanswered-count\"]'))"), false);
      assert.deepEqual(
        await evaluate(`Array.from(document.querySelectorAll('.domain-row'), (row) => ({
          score: row.querySelector('strong')?.textContent,
          scored: Boolean(row.querySelector('.domain-bar')),
        }))`),
        [
          { score: "100%", scored: true },
          { score: "0%", scored: true },
          { score: "Not scored", scored: false },
        ],
        "manually completed session results should only score domains with answers",
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-recommended-domain\"]')?.textContent"),
        "راجع Process قبل جلستك القادمة",
        "the recommendation should use the answered domain with the weakest result",
      );
      assert.equal(
        await evaluate("document.querySelector('.recommendation-card p')?.textContent"),
        "أجبت بشكل صحيح عن 0 من 1 أسئلة في هذا المجال.",
        "the recommendation should describe the actual answered-question result",
      );
      await click(".recommendation-card .text-button");
      await waitFor("Boolean(document.querySelector('.review-page .review-item'))");
      assert.equal(await evaluate("document.querySelectorAll('.review-page .review-item').length"), 2);
      assert.equal(await evaluate("Boolean(document.querySelector('.unanswered-review-item'))"), false);
      assert.equal(await evaluate("document.querySelector('.review-page .review-item h3')?.textContent"), olderQuestion.question);
      assert.equal(await evaluate("document.querySelector('.review-page .review-item p')?.textContent"), olderQuestion.explanation);
      assert.equal(await evaluate("Boolean(document.querySelector('.review-page .review-status.wrong'))"), true);

      reportSessions = [newerSession, expiredSummary, olderSummary];
      holdReportsResponse = true;
      await click('[data-testid="button-nav-reports"]');
      for (let attempt = 0; attempt < 80 && heldReportsRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldReportsRequests.length > 0, true, "reports should refresh before opening an expired session");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldReportsRequests.shift(),
        ...jsonResponse(200, reportSessions),
      });
      holdReportsResponse = false;
      await waitFor(`Boolean(document.querySelector('[data-testid="button-open-session-${expiredSession.id}"]'))`);
      await click(`[data-testid="button-open-session-${expiredSession.id}"]`);
      await waitFor('Boolean(document.querySelector(\'[data-testid="status-session-detail-loading"]\'))');
      for (let attempt = 0; attempt < 80 && heldExpiredSessionRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldExpiredSessionRequests.length > 0, true, "expired session detail should load from the API");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldExpiredSessionRequests.shift(),
        ...jsonResponse(200, expiredSession),
      });
      holdExpiredSessionResponse = false;

      await waitFor("Boolean(document.querySelector('[data-testid=\"text-unanswered-count\"]'))");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-unanswered-count\"]')?.textContent.trim()"),
        "1 من 2 أسئلة بلا إجابة",
      );
      assert.deepEqual(
        await evaluate(`Array.from(document.querySelectorAll('.domain-row'), (row) => ({
          score: row.querySelector('strong')?.textContent,
          scored: Boolean(row.querySelector('.domain-bar')),
        }))`),
        [
          { score: "Not scored", scored: false },
          { score: "0%", scored: true },
          { score: "Not scored", scored: false },
        ],
        "timed session results should use the same answer-based domain breakdown",
      );
      await click(".recommendation-card .text-button");
      await waitFor("Boolean(document.querySelector('[data-testid=\"review-unanswered-history-unanswered-question\"]'))");
      assert.equal(await evaluate("document.querySelectorAll('.review-page .review-item').length"), 2);
      assert.equal(await evaluate("document.querySelector('.review-page .review-item h3')?.textContent"), olderQuestion.question);
      assert.equal(
        await evaluate("document.querySelector('.unanswered-review-item h3')?.textContent"),
        unansweredQuestion.question,
      );
      assert.equal(
        await evaluate("document.querySelector('.unanswered-correct-answer')?.textContent.trim()"),
        `الإجابة الصحيحة: ${unansweredQuestion.options[unansweredQuestion.correctAnswer]}`,
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-review-unanswered-summary\"]')?.textContent.trim()"),
        "1 من 2 أسئلة لم تتم الإجابة عنها قبل انتهاء الوقت.",
      );

      reportSessions = [unansweredOnlySummary];
      holdReportsResponse = true;
      await click('[data-testid="button-nav-reports"]');
      for (let attempt = 0; attempt < 80 && heldReportsRequests.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(heldReportsRequests.length > 0, true, "reports should refresh before opening a session without answers");
      await page.send("Fetch.fulfillRequest", {
        requestId: heldReportsRequests.shift(),
        ...jsonResponse(200, reportSessions),
      });
      holdReportsResponse = false;
      await waitFor(`Boolean(document.querySelector('[data-testid="button-open-session-${unansweredOnlySession.id}"]'))`);
      await click(`[data-testid="button-open-session-${unansweredOnlySession.id}"]`);
      await waitFor("Boolean(document.querySelector('[data-testid=\"text-neutral-recommendation\"]'))");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"text-neutral-recommendation\"]')?.textContent"),
        "واصل التدرّب لتحديد مجال للمراجعة",
        "sessions without answered questions should show a neutral next step",
      );
      assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"text-recommended-domain\"]'))"), false);
      await click('[data-testid="button-start-session-from-recommendation"]');
      await waitFor("Boolean(document.querySelector('.setup-page'))");

      assert.equal(
        requests.some(({ method, path }) => method === "GET" && path === `/api/practice/sessions/${olderSession.id}`),
        true,
      );
      assert.equal(
        requests.some(({ method, path }) => method === "GET" && path === `/api/practice/sessions/${expiredSession.id}`),
        true,
      );
      assert.equal(
        requests.some(({ method, path }) => method === "GET" && path === `/api/practice/sessions/${unansweredOnlySession.id}`),
        true,
      );
      assert.equal(learnerId?.length > 0, true);
      assert.deepEqual(
        [...observedLearnerIds].sort(),
        [learnerId, secondLearnerId].sort(),
        "the browser profile should send saved-question requests for both learner identities",
      );
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