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

  async close() {
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
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Chromium did not expose a page target");
  }

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
  "learners and unauthenticated visitors see no instructor authoring controls after access is denied",
  { timeout: 60_000 },
  async () => {
    const webPort = await unusedPort();
    const debugPort = await unusedPort();
    const web = spawn("pnpm", ["run", "dev"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        BASE_PATH: "/",
        NODE_ENV: "test",
        PORT: String(webPort),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const browser = spawn(chromiumPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/pmp-question-bank-access-${process.pid}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let webStderr = "";
    let browserStderr = "";
    web.stderr.setEncoding("utf8");
    browser.stderr.setEncoding("utf8");
    web.stderr.on("data", (chunk) => { webStderr += chunk; });
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

    let page;
    let closing = false;
    const instructorResponses = [];
    const interceptionErrors = [];
    let pendingApiRequests = 0;
    let observedApiRequests = 0;
    let lastApiActivity = Date.now();
    let authScenario = "learner";
    try {
      await waitForHttp(`http://127.0.0.1:${webPort}/`, web, () => webStderr);
      page = await connectToPage(debugPort, browser, () => browserStderr);

      page.on("Fetch.requestPaused", async (request) => {
        let isApiRequest = false;
        try {
          if (closing) return;
          const url = new URL(request.request.url);
          if (!url.pathname.startsWith("/api/")) {
            await page.send("Fetch.continueRequest", { requestId: request.requestId });
            return;
          }
          isApiRequest = true;
          pendingApiRequests += 1;
          observedApiRequests += 1;
          lastApiActivity = Date.now();

          let response = jsonResponse(200, []);
          if (url.pathname === "/api/auth/user") {
            response = jsonResponse(200, {
              user: authScenario === "learner"
                ? {
                    id: "learner-access-test",
                    email: "learner@example.com",
                    firstName: "Test",
                    lastName: "Learner",
                    profileImageUrl: null,
                    role: "learner",
                  }
                : null,
            });
          } else if (url.pathname === "/api/instructor/questions") {
            const status = authScenario === "learner" ? 403 : 401;
            instructorResponses.push({
              authScenario,
              method: request.request.method,
              status,
            });
            response = status === 403
              ? jsonResponse(status, { error: "Instructor role required" })
              : jsonResponse(status, { error: "Authentication required" });
          } else if (url.pathname === "/api/progress/dashboard") {
            response = jsonResponse(200, {
              readinessScore: 0,
              questionCount: 0,
              completedSessions: 0,
              averageScore: 0,
              studyMinutes: 0,
              lastScore: null,
              recentActivity: [],
            });
          } else if (url.pathname === "/api/practice/sessions/latest") {
            response = jsonResponse(404, { error: "No completed practice session found" });
          } else if (url.pathname === "/api/practice/sessions/in-progress") {
            response = jsonResponse(404, { error: "No unfinished practice session found" });
          }

          await page.send("Fetch.fulfillRequest", {
            requestId: request.requestId,
            ...response,
          });
        } catch (error) {
          if (!closing) interceptionErrors.push(String(error));
        } finally {
          if (isApiRequest) {
            pendingApiRequests -= 1;
            lastApiActivity = Date.now();
          }
        }
      });

      await page.send("Fetch.enable", {
        patterns: [{ urlPattern: `http://127.0.0.1:${webPort}/api/*`, requestStage: "Request" }],
      });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/` });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const evaluation = await page.send("Runtime.evaluate", {
          expression: "Boolean(document.querySelector('.app-frame'))",
          returnByValue: true,
        });
        if (evaluation.result.value) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const waitForApiQuiet = async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            observedApiRequests > 0 &&
            pendingApiRequests === 0 &&
            Date.now() - lastApiActivity >= 700
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(
          `API requests did not settle: pending=${pendingApiRequests}, ` +
          `observed=${observedApiRequests}, errors=${JSON.stringify(interceptionErrors)}`,
        );
      };
      await waitForApiQuiet();
      await page.send("Runtime.evaluate", {
        expression: "localStorage.setItem('pmp-sprint-page', 'instructor')",
      });
      await page.send("Page.reload", { ignoreCache: true });

      const readAccessState = async () => {
        const evaluation = await page.send("Runtime.evaluate", {
          expression: `JSON.stringify({
            denied: Boolean(document.querySelector('[data-testid="status-instructor-unauthorized"]')),
            controls: {
              create: document.querySelectorAll('[data-testid="button-new-question"]').length,
              edit: document.querySelectorAll('[data-testid^="button-edit-question-"]').length,
              publish: document.querySelectorAll('[data-testid^="button-publish-question-"]').length,
              archive: document.querySelectorAll('[data-testid^="button-archive-question-"]').length,
              questionForm: document.querySelectorAll('[role="dialog"], [data-testid^="input-question-"], [data-testid^="select-question-"], [data-testid^="textarea-question-"], [data-testid="button-save-question"]').length
            }
          })`,
          returnByValue: true,
        });
        return JSON.parse(evaluation.result.value);
      };
      const waitForDeniedState = async (scenario) => {
        let state;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          state = await readAccessState();
          if (
            state.denied &&
            instructorResponses.some((request) => request.authScenario === scenario)
          ) {
            return state;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return state;
      };
      const assertNoAuthoringControls = (state) => {
        assert.equal(state?.denied, true);
        assert.deepEqual(state.controls, {
          create: 0,
          edit: 0,
          publish: 0,
          archive: 0,
          questionForm: 0,
        });
      };

      const learnerState = await waitForDeniedState("learner");
      assert.equal(
        instructorResponses.some(
          (request) => request.authScenario === "learner" && request.status === 403,
        ),
        true,
      );
      assertNoAuthoringControls(learnerState);

      authScenario = "unauthenticated";
      await waitForApiQuiet();
      await page.send("Page.reload", { ignoreCache: true });
      const unauthenticatedState = await waitForDeniedState("unauthenticated");
      assert.equal(
        instructorResponses.some(
          (request) => request.authScenario === "unauthenticated" && request.status === 401,
        ),
        true,
      );
      assertNoAuthoringControls(unauthenticatedState);
      assert.deepEqual(interceptionErrors, []);
    } finally {
      closing = true;
      await page?.close();
      await stopProcess(browser);
      await stopProcess(web);
    }
  },
);

test(
  "instructors can search the question library with dropdown filters and see a search empty state",
  { timeout: 60_000 },
  async () => {
    const webPort = await unusedPort();
    const debugPort = await unusedPort();
    const web = spawn("pnpm", ["run", "dev"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        BASE_PATH: "/",
        NODE_ENV: "test",
        PORT: String(webPort),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const browser = spawn(chromiumPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/pmp-question-bank-search-${process.pid}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let webStderr = "";
    let browserStderr = "";
    web.stderr.setEncoding("utf8");
    browser.stderr.setEncoding("utf8");
    web.stderr.on("data", (chunk) => { webStderr += chunk; });
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

    const questions = [
      {
        id: "question-agile-stakeholders",
        domain: "People",
        topic: "Agile stakeholder alignment",
        approach: "agile",
        difficulty: "easy",
        status: "draft",
        question: "How should a project manager align AGILE stakeholders when the delivery roadmap changes repeatedly, the release window is fixed, and several teams depend on a coordinated plan? Review the latest risk signals, agree on a practical sequence for the remaining work, and confirm the final dependency handoff and architectural runway.",
      },
      {
        id: "question-risk-response",
        domain: "Process",
        topic: "Risk response planning [QA]",
        approach: "predictive",
        difficulty: "medium",
        status: "published",
        question: "What should the project manager do about a risk?",
      },
      {
        id: "question-agile-metrics",
        domain: "People",
        topic: "Agile delivery metrics",
        approach: "agile",
        difficulty: "easy",
        status: "draft",
        question: "Which metric helps the QA team inspect delivery?",
      },
    ];
    const responseForQuestions = (url) => {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const status = url.searchParams.get("status");
      const domain = url.searchParams.get("domain");
      const approach = url.searchParams.get("approach");
      const difficulty = url.searchParams.get("difficulty");
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const filtered = questions.filter((question) => (
        (!search || `${question.topic} ${question.question}`.toLowerCase().includes(search)) &&
        (!status || question.status === status) &&
        (!domain || question.domain === domain) &&
        (!approach || question.approach === approach) &&
        (!difficulty || question.difficulty === difficulty)
      ));
      const items = filtered.slice(offset, offset + limit);
      return jsonResponse(200, {
        items,
        pagination: {
          offset,
          limit,
          total: filtered.length,
          hasNext: offset + items.length < filtered.length,
          nextOffset: offset + items.length < filtered.length ? offset + limit : null,
        },
      });
    };

    let page;
    let closing = false;
    const instructorRequests = [];
    const preferenceRequests = [];
    let savedPageSize = 25;
    const runtimeExceptions = [];
    const browserErrors = [];
    try {
      await waitForHttp(`http://127.0.0.1:${webPort}/`, web, () => webStderr);
      page = await connectToPage(debugPort, browser, () => browserStderr);

      page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
        runtimeExceptions.push({
          text: exceptionDetails.text,
          description: exceptionDetails.exception?.description,
        });
      });
      page.on("Runtime.consoleAPICalled", ({ type, args, stackTrace }) => {
        if (type === "error") {
          browserErrors.push({
            messages: args.map((argument) => argument.value ?? argument.description),
            stackTrace,
          });
        }
      });
      page.on("Fetch.requestPaused", async (request) => {
        try {
          const url = new URL(request.request.url);
          if (!url.pathname.startsWith("/api/")) {
            await page.send("Fetch.continueRequest", { requestId: request.requestId });
            return;
          }

          let response = jsonResponse(200, []);
          if (url.pathname === "/api/auth/user") {
            response = jsonResponse(200, {
              user: {
                id: "instructor-search-test",
                email: "instructor@example.com",
                firstName: "Test",
                lastName: "Instructor",
                profileImageUrl: null,
                role: "instructor",
              },
            });
          } else if (url.pathname === "/api/instructor/preferences") {
            if (request.request.method === "PUT") {
              const payload = JSON.parse(request.request.postData ?? "{}");
              preferenceRequests.push(payload);
              savedPageSize = payload.pageSize;
            }
            response = jsonResponse(200, { pageSize: savedPageSize });
          } else if (url.pathname === "/api/instructor/questions" && request.request.method === "GET") {
            instructorRequests.push(url);
            response = responseForQuestions(url);
          } else if (
            request.request.method === "POST" &&
            /^\/api\/instructor\/questions\/[^/]+\/archive$/.test(url.pathname)
          ) {
            const questionId = url.pathname.split("/").at(-2);
            const question = questions.find((candidate) => candidate.id === questionId);
            if (question) {
              question.status = "archived";
              response = jsonResponse(200, question);
            } else {
              response = jsonResponse(404, { error: "Question not found" });
            }
          } else if (url.pathname === "/api/progress/dashboard") {
            response = jsonResponse(200, {
              readinessScore: 0,
              questionCount: 0,
              completedSessions: 0,
              averageScore: 0,
              studyMinutes: 0,
              lastScore: null,
              recentActivity: [],
            });
          } else if (url.pathname === "/api/practice/sessions/latest") {
            response = jsonResponse(404, { error: "No completed practice session found" });
          } else if (url.pathname === "/api/practice/sessions/in-progress") {
            response = jsonResponse(404, { error: "No unfinished practice session found" });
          }

          await page.send("Fetch.fulfillRequest", {
            requestId: request.requestId,
            ...response,
          });
        } catch (error) {
          if (!closing) browserErrors.push({ interceptionError: String(error) });
        }
      });

      await page.send("Runtime.enable");
      await page.send("Fetch.enable", {
        patterns: [{ urlPattern: `http://127.0.0.1:${webPort}/api/*`, requestStage: "Request" }],
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
        const pageText = await evaluate("document.body?.innerText?.slice(0, 1200)");
        throw new Error(
          `Timed out waiting for: ${expression}\n` +
          `Instructor requests: ${instructorRequests.map((url) => url.href).join(", ")}\n` +
          `Browser exceptions: ${JSON.stringify(runtimeExceptions)}\n` +
          `Browser errors: ${JSON.stringify(browserErrors)}\n` +
          `Page text: ${pageText}`,
        );
      };
      const setInputValue = async (selector, value) => {
        await evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(selector)});
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
      };
      const setSelectValue = async (selector, value) => {
        await evaluate(`(() => {
          const select = document.querySelector(${JSON.stringify(selector)});
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(select, ${JSON.stringify(value)});
          select.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
      };
      const waitForInstructorRequest = async (expectedParams) => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (instructorRequests.some((url) => Object.entries(expectedParams).every(
            ([key, value]) => url.searchParams.get(key) === value,
          ))) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          `Timed out waiting for instructor request ${JSON.stringify(expectedParams)}. ` +
          `Observed: ${instructorRequests.map((url) => url.searchParams.toString()).join(", ")}`,
        );
      };

      await waitFor("Boolean(document.querySelector('.app-frame'))");
      await waitFor("document.querySelector('.profile-copy strong')?.textContent === 'Test Instructor'");
      await evaluate("localStorage.setItem('pmp-sprint-page', 'instructor')");
      await page.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/` });
      await waitFor("document.querySelectorAll('[data-testid^=\"row-instructor-question-\"]').length === 3");
      assert.deepEqual(runtimeExceptions, []);
      assert.deepEqual(
        await evaluate(`Array.from(document.querySelectorAll('[data-testid^="row-instructor-question-"]')).map((row) => row.dataset.testid).sort()`),
        [
          "row-instructor-question-question-agile-metrics",
          "row-instructor-question-question-agile-stakeholders",
          "row-instructor-question-question-risk-response",
        ],
      );

      await setInputValue('[data-testid="input-filter-search"]', "aGiLe");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 2 &&
        !document.querySelector('[data-testid="row-instructor-question-question-risk-response"]')`);
      assert.deepEqual(
        await evaluate(`Array.from(document.querySelectorAll('[data-testid^="row-instructor-question-"]')).map((row) => row.dataset.testid).sort()`),
        [
          "row-instructor-question-question-agile-metrics",
          "row-instructor-question-question-agile-stakeholders",
        ],
      );
      assert.deepEqual(
        await evaluate(`(() => {
          const row = document.querySelector('[data-testid="row-instructor-question-question-agile-stakeholders"]');
          return {
            questionMatches: Array.from(row.querySelectorAll("h3 mark.search-highlight"), (mark) => mark.textContent),
            topicMatches: Array.from(row.querySelectorAll("p mark.search-highlight"), (mark) => mark.textContent),
            allTopicMatches: Array.from(document.querySelectorAll('[data-testid^="row-instructor-question-"] p mark.search-highlight'), (mark) => mark.textContent)
          };
        })()`),
        {
          questionMatches: ["AGILE"],
          topicMatches: ["Agile"],
          allTopicMatches: ["Agile", "Agile"],
        },
      );
      assert.equal(instructorRequests.some((url) => url.searchParams.get("search") === "aGiLe"), true);

      await setInputValue('[data-testid="input-filter-search"]', "architectural runway");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 1 &&
        document.querySelector('[data-testid="button-expand-question-question-agile-stakeholders"]') !== null`);
      await evaluate(`document.querySelector('[data-testid="button-expand-question-question-agile-stakeholders"]').click()`);
      await waitFor(`document.querySelector('[data-testid="button-expand-question-question-agile-stakeholders"]')?.getAttribute("aria-expanded") === "true"`);
      assert.deepEqual(
        await evaluate(`(() => {
          const row = document.querySelector('[data-testid="row-instructor-question-question-agile-stakeholders"]');
          const question = row.querySelector("h3");
          const match = question.querySelector("mark.search-highlight");
          return {
            expanded: question.classList.contains("expanded"),
            hasFullEnding: question.textContent.endsWith("architectural runway."),
            highlightedMatch: match?.textContent,
            accessibleExpandedState: row.querySelector("button[aria-controls]")?.getAttribute("aria-expanded"),
          };
        })()`),
        {
          expanded: true,
          hasFullEnding: true,
          highlightedMatch: "architectural runway",
          accessibleExpandedState: "true",
        },
      );
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      assert.deepEqual(
        await evaluate(`(() => {
          const row = document.querySelector('[data-testid="row-instructor-question-question-agile-stakeholders"]');
          const main = row.querySelector(".question-row-main");
          const toggle = row.querySelector("button[aria-controls]");
          return {
            viewportWidth: window.innerWidth,
            rowFits: row.scrollWidth <= row.clientWidth,
            mainFits: main.scrollWidth <= main.clientWidth,
            toggleVisible: toggle.getBoundingClientRect().width > 0,
          };
        })()`),
        {
          viewportWidth: 390,
          rowFits: true,
          mainFits: true,
          toggleVisible: true,
        },
      );
      await page.send("Emulation.clearDeviceMetricsOverride");
      await evaluate(`document.querySelector('[data-testid="button-expand-question-question-agile-stakeholders"]').click()`);
      await waitFor(`document.querySelector('[data-testid="button-expand-question-question-agile-stakeholders"]')?.getAttribute("aria-expanded") === "false"`);
      await setInputValue('[data-testid="input-filter-search"]', "aGiLe");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 2`);

      await setSelectValue('[data-testid="select-filter-domain"]', "People");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 2 &&
        document.querySelector('[data-testid="select-filter-domain"]').value === "People"`);
      assert.equal(instructorRequests.some((url) => (
        url.searchParams.get("search") === "aGiLe" &&
        url.searchParams.get("domain") === "People"
      )), true);
      await setSelectValue('[data-testid="select-filter-domain"]', "all");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 2 &&
        document.querySelector('[data-testid="select-filter-domain"]').value === "all"`);

      await setInputValue('[data-testid="input-filter-search"]', "[QA]");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 1 &&
        document.querySelector('[data-testid="row-instructor-question-question-risk-response"] .search-highlight')?.textContent === '[QA]'`);
      assert.equal(
        await evaluate("document.querySelectorAll('[data-testid^=\"row-instructor-question-\"]').length"),
        1,
      );
      assert.deepEqual(
        await evaluate(`Array.from(document.querySelectorAll('[data-testid="row-instructor-question-question-risk-response"] mark.search-highlight'), (mark) => mark.textContent)`),
        ["[QA]"],
      );
      assert.deepEqual(runtimeExceptions, []);
      assert.deepEqual(browserErrors, []);

      await setInputValue('[data-testid="input-filter-search"]', "");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 3 &&
        document.querySelectorAll("mark.search-highlight").length === 0 &&
        document.querySelector('[data-testid="input-filter-search"]').value === ''`);
      assert.equal(
        await evaluate(`document.querySelector('[data-testid="row-instructor-question-question-risk-response"] p')?.textContent`),
        "Risk response planning [QA]",
      );
      assert.equal(
        await evaluate(`document.querySelector('[data-testid="row-instructor-question-question-risk-response"] h3')?.textContent`),
        "What should the project manager do about a risk?",
      );

      await setSelectValue('[data-testid="select-filter-domain"]', "People");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 2 &&
        document.querySelector('[data-testid="select-filter-domain"]').value === "People"`);

      await setInputValue('[data-testid="input-filter-search"]', "no matching question");
      await waitFor(`document.querySelector('[data-testid="status-instructor-empty"] strong')?.textContent ===
        'لا توجد أسئلة تطابق البحث'`);
      assert.equal(
        await evaluate("document.querySelectorAll('[data-testid^=\"row-instructor-question-\"]').length"),
        0,
      );
      assert.equal(
        await evaluate(`document.querySelector('[data-testid="status-instructor-empty"] span')?.textContent`),
        "جرّب عبارة أخرى أو غيّر خيارات التصفية.",
      );
      assert.equal(instructorRequests.some((url) => (
        url.searchParams.get("search") === "no matching question" &&
        url.searchParams.get("domain") === "People"
      )), true);

      questions.push(...Array.from({ length: 26 }, (_, index) => ({
        id: `question-page-size-${index}`,
        domain: "People",
        topic: "Page size coverage",
        approach: "agile",
        difficulty: "easy",
        status: "draft",
        question: `Page size coverage question ${index}`,
      })));
      await setInputValue('[data-testid="input-filter-search"]', "page size coverage");
      await waitForInstructorRequest({ search: "page size coverage", domain: "People" });
      await setSelectValue('[data-testid="select-filter-approach"]', "agile");
      await waitForInstructorRequest({ search: "page size coverage", domain: "People", approach: "agile" });
      await setSelectValue('[data-testid="select-filter-difficulty"]', "easy");
      await waitForInstructorRequest({ search: "page size coverage", domain: "People", approach: "agile", difficulty: "easy" });
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 25 &&
        document.querySelector('[data-testid="select-page-size"]').value === '25'`);
      await evaluate(`document.querySelector('.instructor-pagination button:last-child').click()`);
      await waitFor(`document.querySelector('.instructor-pagination > span')?.textContent === '26–26 من 26'`);

      await setSelectValue('[data-testid="select-page-size"]', "10");
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 10 &&
        document.querySelector('.instructor-pagination > span')?.textContent === '1–10 من 26'`);
      await waitForInstructorRequest({
        limit: "10",
        offset: "0",
        search: "page size coverage",
        domain: "People",
        approach: "agile",
        difficulty: "easy",
      });
      assert.equal(
        instructorRequests.some((url) => (
          url.searchParams.get("limit") === "10" &&
          url.searchParams.get("offset") === "0" &&
          url.searchParams.get("search") === "page size coverage" &&
          url.searchParams.get("domain") === "People" &&
          url.searchParams.get("approach") === "agile" &&
          url.searchParams.get("difficulty") === "easy"
        )),
        true,
      );
      assert.equal(await evaluate(`document.querySelector('[data-testid="select-page-size"]').value`), "10");
      for (let attempt = 0; attempt < 50 && !preferenceRequests.some((item) => item.pageSize === 10); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(preferenceRequests.some((item) => item.pageSize === 10), true);

      const readsBeforeReload = instructorRequests.length;
      await evaluate(`window.localStorage.setItem('pmp-sprint-page', 'instructor')`);
      await page.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/` });
      await waitFor(`document.querySelector('[data-testid="select-page-size"]')?.value === '10' &&
        document.querySelector('[data-testid="input-filter-search"]')?.value === '' &&
        document.querySelector('[data-testid="select-filter-domain"]')?.value === 'all' &&
        document.querySelector('[data-testid="select-filter-approach"]')?.value === 'all' &&
        document.querySelector('[data-testid="select-filter-difficulty"]')?.value === 'all' &&
        document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 10`);
      assert.equal(
        instructorRequests.slice(readsBeforeReload).some((url) => (
          url.searchParams.get("limit") === "10" &&
          url.searchParams.get("offset") === "0" &&
          !url.searchParams.has("search") &&
          !url.searchParams.has("domain") &&
          !url.searchParams.has("approach") &&
          !url.searchParams.has("difficulty")
        )),
        true,
        "reopening the workspace restores only the page size, not the previous search or filters",
      );

      questions.push(...Array.from({ length: 11 }, (_, index) => ({
        id: `question-archive-later-page-${index}`,
        domain: "People",
        topic: "Archive later-page coverage",
        approach: "agile",
        difficulty: "easy",
        status: "published",
        question: `Archive later-page question ${index}`,
      })));
      await setInputValue('[data-testid="input-filter-search"]', "archive later-page coverage");
      await waitForInstructorRequest({ limit: "10", offset: "0", search: "archive later-page coverage" });
      await setSelectValue('[data-testid="select-filter-status"]', "published");
      await waitForInstructorRequest({
        limit: "10",
        offset: "0",
        search: "archive later-page coverage",
        status: "published",
      });
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 10 &&
        document.querySelector('.instructor-pagination > span')?.textContent === '1–10 من 11'`);
      await evaluate(`document.querySelector('.instructor-pagination button:last-child').click()`);
      await waitFor(`document.querySelector('[data-testid="row-instructor-question-question-archive-later-page-10"]') &&
        document.querySelector('.instructor-pagination > span')?.textContent === '11–11 من 11'`);
      await evaluate(`document.querySelector('[data-testid="button-archive-question-question-archive-later-page-10"]').click()`);
      await waitFor(`document.querySelector('[data-testid="status-instructor-empty-page"] strong')?.textContent ===
        'لا توجد أسئلة في هذه الصفحة'`);
      await waitForInstructorRequest({
        limit: "10",
        offset: "10",
        search: "archive later-page coverage",
        status: "published",
      });
      assert.equal(
        await evaluate(`document.querySelector('[data-testid="button-instructor-return-to-previous-page"]') !== null`),
        true,
      );
      await evaluate(`document.querySelector('[data-testid="button-instructor-return-to-previous-page"]').click()`);
      await waitFor(`document.querySelectorAll('[data-testid^="row-instructor-question-"]').length === 10 &&
        document.querySelector('.instructor-pagination > span')?.textContent === '1–10 من 10'`);
      await waitForInstructorRequest({
        limit: "10",
        offset: "0",
        search: "archive later-page coverage",
        status: "published",
      });
      assert.equal(await evaluate(`document.querySelector('.instructor-pagination button:first-child').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('.instructor-pagination button:last-child').disabled`), true);
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

test(
  "administrators can grant and revoke instructor access and review the audit log",
  { timeout: 60_000 },
  async () => {
    const webPort = await unusedPort();
    const debugPort = await unusedPort();
    const web = spawn("pnpm", ["run", "dev"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        BASE_PATH: "/",
        NODE_ENV: "test",
        PORT: String(webPort),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const browser = spawn(chromiumPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/pmp-question-bank-admin-${process.pid}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let webStderr = "";
    let browserStderr = "";
    web.stderr.setEncoding("utf8");
    browser.stderr.setEncoding("utf8");
    web.stderr.on("data", (chunk) => { webStderr += chunk; });
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

    const admin = {
      id: "admin-test-user",
      email: "admin@example.test",
      firstName: "Test",
      lastName: "Admin",
      profileImageUrl: null,
      role: "admin",
    };
    const peerAdmin = {
      id: "admin-peer-user",
      email: "manager@example.test",
      firstName: "Test",
      lastName: "Manager",
      profileImageUrl: null,
      role: "admin",
    };
    const learner = {
      id: "learner-test-user",
      email: "learner@example.test",
      firstName: "Test",
      lastName: "Learner",
      profileImageUrl: null,
      role: "learner",
    };
    const users = [admin, peerAdmin, learner];
    const audit = [];
    const auditRequests = [];
    const roleChanges = [];
    let authRole = "admin";
    let adminApiFailureStatus = null;
    let roleChangeFailureStatus = null;
    let grantFailureStatus = null;
    let revokeFailureStatus = null;
    let loginRequests = 0;
    let page;
    let closing = false;
    const runtimeExceptions = [];
    const browserErrors = [];
    const interceptionErrors = [];
    let pendingApiRequests = 0;
    let observedApiRequests = 0;
    let lastApiActivity = Date.now();
    let acceptConfirmation = true;
    const confirmationMessages = [];

    try {
      await waitForHttp(`http://127.0.0.1:${webPort}/`, web, () => webStderr);
      page = await connectToPage(debugPort, browser, () => browserStderr);

      page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
        runtimeExceptions.push({
          text: exceptionDetails.text,
          description: exceptionDetails.exception?.description,
        });
      });
      page.on("Runtime.consoleAPICalled", ({ type, args, stackTrace }) => {
        if (type === "error") {
          browserErrors.push({
            messages: args.map((argument) => argument.value ?? argument.description),
            stackTrace,
          });
        }
      });
      page.on("Page.javascriptDialogOpening", ({ message }) => {
        confirmationMessages.push(message);
        void page.send("Page.handleJavaScriptDialog", { accept: acceptConfirmation });
      });
      page.on("Fetch.requestPaused", async (request) => {
        let isApiRequest = false;
        try {
          if (closing) return;
          const url = new URL(request.request.url);
          if (!url.pathname.startsWith("/api/")) {
            await page.send("Fetch.continueRequest", { requestId: request.requestId });
            return;
          }
          isApiRequest = true;
          pendingApiRequests += 1;
          observedApiRequests += 1;
          lastApiActivity = Date.now();

          let response = jsonResponse(200, []);
          if (url.pathname === "/api/auth/user") {
            response = jsonResponse(200, {
              user: { ...admin, role: authRole },
            });
          } else if (url.pathname === "/api/login") {
            loginRequests += 1;
            adminApiFailureStatus = null;
            roleChangeFailureStatus = null;
            grantFailureStatus = null;
            revokeFailureStatus = null;
            response = {
              responseCode: 302,
              responseHeaders: [
                { name: "Location", value: `http://127.0.0.1:${webPort}/` },
                { name: "Cache-Control", value: "no-store" },
              ],
              body: "",
            };
          } else if (url.pathname === "/api/admin/users" && request.request.method === "GET") {
            response = adminApiFailureStatus
              ? jsonResponse(adminApiFailureStatus, {
                  error: adminApiFailureStatus === 401 ? "Authentication required" : "Administrator role required",
                })
              : jsonResponse(200, users);
          } else if (url.pathname === "/api/admin/access-audit") {
            auditRequests.push({
              account: url.searchParams.get("account"),
              actor: url.searchParams.get("actor"),
            });
            response = adminApiFailureStatus
              ? jsonResponse(adminApiFailureStatus, {
                  error: adminApiFailureStatus === 401 ? "Authentication required" : "Administrator role required",
                })
              : jsonResponse(200, audit.filter((entry) => {
                  const accountFilter = (url.searchParams.get("account") ?? "").toLowerCase();
                  const actorFilter = (url.searchParams.get("actor") ?? "").toLowerCase();
                  const accountText = `${entry.targetId} ${entry.targetEmail ?? ""} ${entry.targetName ?? ""}`.toLowerCase();
                  const actorText = `${entry.actorId} ${entry.actorEmail ?? ""} ${entry.actorName ?? ""}`.toLowerCase();
                  return accountText.includes(accountFilter) && actorText.includes(actorFilter);
                }));
          } else if (url.pathname.startsWith("/api/admin/users/") && request.request.method === "PATCH") {
            const target = users.find((user) => url.pathname === `/api/admin/users/${user.id}/role`);
            const requestedRole = JSON.parse(request.request.postData ?? "{}").role;
            if (!target || !["learner", "instructor"].includes(requestedRole)) {
              response = jsonResponse(400, { error: "Invalid role change" });
            } else if (roleChangeFailureStatus) {
              response = jsonResponse(roleChangeFailureStatus, {
                error: roleChangeFailureStatus === 401
                  ? "Authentication required"
                  : "Administrator role required",
              });
            } else {
              const previousRole = target.role;
              target.role = requestedRole;
              roleChanges.push({ targetId: target.id, role: requestedRole });
              audit.unshift({
                id: `audit-${audit.length + 1}`,
                actorId: admin.id,
                actorName: "Test Admin",
                actorEmail: admin.email,
                targetId: target.id,
                targetName: "Test Learner",
                targetEmail: learner.email,
                previousRole,
                newRole: requestedRole,
                changedAt: "2026-09-24T12:00:00.000Z",
              });
              response = jsonResponse(200, target);
            }
          } else if (url.pathname.startsWith("/api/admin/users/") && request.request.method === "POST") {
            const target = users.find((user) => url.pathname === `/api/admin/users/${user.id}/admin-access`);
            const confirmed = JSON.parse(request.request.postData ?? "{}").confirmed === true;
            if (!target) {
              response = jsonResponse(404, { error: "User not found" });
            } else if (!confirmed) {
              response = jsonResponse(400, { error: "Explicit confirmation is required" });
            } else if (grantFailureStatus) {
              response = jsonResponse(grantFailureStatus, {
                error: grantFailureStatus === 401 ? "Authentication required" : "Administrator role required",
              });
            } else if (target.role === "admin") {
              response = jsonResponse(409, { error: "This account already has administrator access" });
            } else {
              const previousRole = target.role;
              target.role = "admin";
              roleChanges.push({ targetId: target.id, role: target.role });
              audit.unshift({
                id: `audit-${audit.length + 1}`,
                actorId: admin.id,
                actorName: "Test Admin",
                actorEmail: admin.email,
                targetId: target.id,
                targetName: "Test Learner",
                targetEmail: learner.email,
                previousRole,
                newRole: "admin",
                changedAt: "2026-09-24T12:00:00.000Z",
              });
              response = jsonResponse(200, target);
            }
          } else if (url.pathname.startsWith("/api/admin/users/") && request.request.method === "DELETE") {
            const target = users.find((user) => url.pathname === `/api/admin/users/${user.id}/admin-access`);
            if (revokeFailureStatus) {
              response = jsonResponse(revokeFailureStatus, {
                error: revokeFailureStatus === 401 ? "Authentication required" : "Administrator role required",
              });
            } else if (!target || target.role !== "admin" || target.id === admin.id) {
              response = jsonResponse(409, { error: "Administrator access cannot be revoked" });
            } else {
              target.role = "learner";
              roleChanges.push({ targetId: target.id, role: target.role });
              audit.unshift({
                id: `audit-${audit.length + 1}`,
                actorId: admin.id,
                actorName: "Test Admin",
                actorEmail: admin.email,
                targetId: target.id,
                targetName: "Test Manager",
                targetEmail: peerAdmin.email,
                previousRole: "admin",
                newRole: "learner",
                changedAt: "2026-09-24T12:00:00.000Z",
              });
              response = jsonResponse(200, target);
            }
          } else if (url.pathname === "/api/progress/dashboard") {
            response = jsonResponse(200, {
              readinessScore: 0,
              questionCount: 0,
              completedSessions: 0,
              averageScore: 0,
              studyMinutes: 0,
              lastScore: null,
              recentActivity: [],
            });
          } else if (url.pathname === "/api/practice/sessions/latest" ||
                     url.pathname === "/api/practice/sessions/in-progress") {
            response = jsonResponse(404, { error: "No practice session found" });
          }

          await page.send("Fetch.fulfillRequest", {
            requestId: request.requestId,
            ...response,
          });
        } catch (error) {
          if (!closing) {
            interceptionErrors.push({
              error: String(error),
              url: request.request.url,
              method: request.request.method,
            });
          }
        } finally {
          if (isApiRequest) {
            pendingApiRequests -= 1;
            lastApiActivity = Date.now();
          }
        }
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Fetch.enable", {
        patterns: [{ urlPattern: `http://127.0.0.1:${webPort}/api/*`, requestStage: "Request" }],
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
        const pageText = await evaluate("document.body?.innerText?.slice(0, 1200)");
        throw new Error(
          `Timed out waiting for: ${expression}\n` +
          `Browser exceptions: ${JSON.stringify(runtimeExceptions)}\n` +
          `Browser errors: ${JSON.stringify(browserErrors)}\n` +
          `Page text: ${pageText}`,
        );
      };
      const waitForApiQuiet = async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            observedApiRequests > 0 &&
            pendingApiRequests === 0 &&
            Date.now() - lastApiActivity >= 700
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(
          `API requests did not settle: pending=${pendingApiRequests}, ` +
          `observed=${observedApiRequests}, errors=${JSON.stringify(interceptionErrors)}`,
        );
      };
      const unexpectedInterceptionErrors = () => interceptionErrors.filter(({ error, url }) => {
        const path = new URL(url).pathname;
        const expectedLoginNavigationCancellation =
          loginRequests > 0 &&
          error === "Error: Invalid InterceptionId." &&
          (path === "/api/admin/users" || path === "/api/admin/access-audit");
        return !expectedLoginNavigationCancellation;
      });

      await waitFor("Boolean(document.querySelector('.app-frame'))");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          observedApiRequests > 0 &&
          pendingApiRequests === 0 &&
          Date.now() - lastApiActivity >= 700
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(observedApiRequests > 0, "the initial app route should request authenticated data");
      assert.equal(pendingApiRequests, 0, "finish initial API requests before changing pages");
      await evaluate("localStorage.setItem('pmp-sprint-page', 'admin')");
      await page.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/` });
      await waitFor(`document.querySelector('[data-testid="row-admin-user-learner-test-user"]') !== null`);
      assert.equal(await evaluate("document.body.innerText.includes('إدارة صلاحيات الحسابات')"), true);
      assert.equal(await evaluate("document.querySelector('.profile-copy span')?.textContent"), "Administrator · Access manager");
      assert.equal(await evaluate("document.querySelector('[data-testid=\"button-revoke-admin-admin-test-user\"]') === null"), true);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"button-revoke-admin-admin-peer-user\"]') !== null"), true);

      const roleButton = '[data-testid="button-admin-role-learner-test-user"]';
      roleChangeFailureStatus = 401;
      await evaluate(`document.querySelector(${JSON.stringify(roleButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-role-error"]') !== null &&
        document.querySelector('[data-testid="status-admin-session-expired"]') !== null &&
        document.querySelector('[data-testid="button-admin-session-login"]') !== null`);
      assert.match(
        await evaluate(`document.querySelector('[data-testid="status-admin-role-error"]')?.textContent ?? ""`),
        /انتهت صلاحية جلسة الدخول/,
      );
      assert.equal(users.find((user) => user.id === learner.id)?.role, "learner");
      await waitForApiQuiet();
      await evaluate(`document.querySelector('[data-testid="button-admin-session-login"]').click()`);
      await waitFor(`document.querySelector('[data-testid="row-admin-user-learner-test-user"]') !== null &&
        (document.querySelector('[data-testid="list-admin-access-audit"]') !== null ||
          document.querySelector('[data-testid="status-admin-audit-empty"]') !== null) &&
        document.querySelector('[data-testid="status-admin-session-expired"]') === null &&
        document.querySelector('[data-testid="status-admin-role-error"]') === null`);
      assert.equal(loginRequests, 1, "a role-change 401 should offer sign-in recovery");
      assert.equal(roleChangeFailureStatus, null, "signing in again should clear the expired role-change failure");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(roleButton)})?.disabled`), false);
      assert.deepEqual(
        unexpectedInterceptionErrors(),
        [],
        "role-change sign-in recovery should not leave unexpected API interception errors",
      );

      // Retrying the role control after sign-in should apply the change normally.
      await evaluate(`document.querySelector(${JSON.stringify(roleButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-role-updated"]') !== null &&
        document.querySelector('[data-testid="row-admin-user-learner-test-user"] .pill')?.textContent === 'مدرّس' &&
        document.querySelector('[data-testid="row-admin-audit-audit-1"]') !== null`);
      assert.equal(await evaluate(`document.querySelector('[data-testid="row-admin-audit-audit-1"]')?.innerText.includes('Test Admin')`), true);

      roleChangeFailureStatus = 403;
      await evaluate(`document.querySelector(${JSON.stringify(roleButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-role-error"]')?.textContent.includes('لا تملك صلاحية تنفيذ هذا التغيير')`);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"status-admin-session-expired\"]') === null"), true);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"button-admin-session-login\"]') === null"), true);
      assert.equal(users.find((user) => user.id === learner.id)?.role, "instructor");
      assert.equal(roleChanges.length, 1, "a denied role change must not update the account");
      roleChangeFailureStatus = null;

      await evaluate(`document.querySelector(${JSON.stringify(roleButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="row-admin-user-learner-test-user"] .pill')?.textContent === 'متعلّم' &&
        document.querySelector('[data-testid="row-admin-audit-audit-2"]') !== null`);

      const grantButton = '[data-testid="button-grant-admin-learner-test-user"]';
      acceptConfirmation = false;
      await evaluate(`document.querySelector(${JSON.stringify(grantButton)}).click()`);
      assert.match(confirmationMessages.at(-1) ?? "", /Test Learner/);
      assert.match(confirmationMessages.at(-1) ?? "", /إدارة الحسابات والصلاحيات/);
      assert.equal(users.find((user) => user.id === learner.id)?.role, "learner");
      assert.equal(roleChanges.length, 2, "declining confirmation must leave the account unchanged");

      acceptConfirmation = true;
      grantFailureStatus = 403;
      await evaluate(`document.querySelector(${JSON.stringify(grantButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-grant-error"]')?.textContent.includes('لا تملك صلاحية تنفيذ هذا التغيير')`);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"status-admin-session-expired\"]') === null"), true);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"button-admin-session-login\"]') === null"), true);
      assert.equal(users.find((user) => user.id === learner.id)?.role, "learner");
      assert.equal(roleChanges.length, 2, "a denied administrator grant must not update the account");

      grantFailureStatus = 401;
      await evaluate(`document.querySelector(${JSON.stringify(grantButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-grant-error"]') !== null &&
        document.querySelector('[data-testid="status-admin-session-expired"]') !== null &&
        document.querySelector('[data-testid="button-admin-session-login"]') !== null`);
      assert.match(
        await evaluate(`document.querySelector('[data-testid="status-admin-grant-error"]')?.textContent ?? ""`),
        /انتهت صلاحية جلسة الدخول/,
      );
      assert.equal(users.find((user) => user.id === learner.id)?.role, "learner");
      assert.equal(roleChanges.length, 2, "an expired administrator grant must not update the account");
      await waitForApiQuiet();
      await evaluate(`document.querySelector('[data-testid="button-admin-session-login"]').click()`);
      await waitFor(`document.querySelector('[data-testid="row-admin-user-learner-test-user"]') !== null &&
        (document.querySelector('[data-testid="list-admin-access-audit"]') !== null ||
          document.querySelector('[data-testid="status-admin-audit-empty"]') !== null) &&
        document.querySelector('[data-testid="status-admin-session-expired"]') === null &&
        document.querySelector('[data-testid="status-admin-grant-error"]') === null`);
      assert.equal(loginRequests, 2, "an administrator-grant 401 should offer sign-in recovery");
      assert.equal(grantFailureStatus, null, "signing in again should clear the expired grant failure");
      assert.equal(await evaluate("localStorage.getItem('pmp-sprint-page')"), "admin");

      await evaluate(`document.querySelector(${JSON.stringify(grantButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-grant-success"]') !== null &&
        document.querySelector('[data-testid="row-admin-user-learner-test-user"] .pill')?.textContent === 'مسؤول' &&
        document.querySelector('[data-testid="row-admin-audit-audit-3"]') !== null`);
      assert.equal(await evaluate("document.querySelector('.admin-access-banner .pill')?.textContent.includes('3 مسؤول')"), true);
      assert.equal(await evaluate(`document.querySelector('[data-testid="row-admin-audit-audit-3"]')?.innerText.includes('Test Admin')`), true);
      assert.equal(await evaluate(`document.querySelector('[data-testid="row-admin-audit-audit-3"]')?.innerText.includes('رقّى Test Learner إلى مسؤول من متعلّم')`), true);

      const revokeButton = '[data-testid="button-revoke-admin-admin-peer-user"]';
      revokeFailureStatus = 403;
      await evaluate(`document.querySelector(${JSON.stringify(revokeButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-revoke-error"]')?.textContent.includes('لا تملك صلاحية تنفيذ هذا التغيير')`);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"status-admin-session-expired\"]') === null"), true);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"button-admin-session-login\"]') === null"), true);
      assert.equal(users.find((user) => user.id === peerAdmin.id)?.role, "admin");
      assert.equal(roleChanges.length, 3, "a denied administrator revocation must not update the account");

      revokeFailureStatus = 401;
      await evaluate(`document.querySelector(${JSON.stringify(revokeButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-revoke-error"]') !== null &&
        document.querySelector('[data-testid="status-admin-session-expired"]') !== null &&
        document.querySelector('[data-testid="button-admin-session-login"]') !== null`);
      assert.match(
        await evaluate(`document.querySelector('[data-testid="status-admin-revoke-error"]')?.textContent ?? ""`),
        /انتهت صلاحية جلسة الدخول/,
      );
      assert.equal(users.find((user) => user.id === peerAdmin.id)?.role, "admin");
      assert.equal(roleChanges.length, 3, "an expired administrator revocation must not update the account");
      await waitForApiQuiet();
      await evaluate(`document.querySelector('[data-testid="button-admin-session-login"]').click()`);
      await waitFor(`document.querySelector('[data-testid="row-admin-user-admin-peer-user"]') !== null &&
        (document.querySelector('[data-testid="list-admin-access-audit"]') !== null ||
          document.querySelector('[data-testid="status-admin-audit-empty"]') !== null) &&
        document.querySelector('[data-testid="status-admin-session-expired"]') === null &&
        document.querySelector('[data-testid="status-admin-revoke-error"]') === null`);
      assert.equal(loginRequests, 3, "an administrator-revocation 401 should offer sign-in recovery");
      assert.equal(revokeFailureStatus, null, "signing in again should clear the expired revocation failure");
      assert.equal(await evaluate("localStorage.getItem('pmp-sprint-page')"), "admin");

      await evaluate(`document.querySelector(${JSON.stringify(revokeButton)}).click()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-revoke-success"]') !== null &&
        document.querySelector('[data-testid="row-admin-user-admin-peer-user"] .pill')?.textContent === 'متعلّم' &&
        document.querySelector('[data-testid="row-admin-audit-audit-4"]') !== null`);
      assert.equal(await evaluate(`document.querySelector('[data-testid="row-admin-audit-audit-4"]')?.innerText.includes('أزال صلاحية المسؤول')`), true);
      assert.deepEqual(roleChanges.map((change) => change.role), ["instructor", "learner", "admin", "learner"]);

      await evaluate(`(() => {
        const setInput = (selector, value) => {
          const input = document.querySelector(selector);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        setInput('[data-testid="input-admin-audit-account"]', "Test Learner");
        setInput('[data-testid="input-admin-audit-actor"]', "Test Admin");
        document.querySelector('[data-testid="form-admin-audit-search"]').requestSubmit();
      })()`);
      await waitFor(`document.querySelectorAll('[data-testid^="row-admin-audit-"]').length === 3 &&
        document.querySelector('[data-testid="row-admin-audit-audit-3"] .admin-audit-copy strong')?.textContent.includes('رقّى Test Learner إلى مسؤول من متعلّم')`);
      assert.deepEqual(auditRequests.at(-1), { account: "Test Learner", actor: "Test Admin" });
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="row-admin-audit-audit-3"] time[datetime="2026-09-24T12:00:00.000Z"]'))`), true);

      await evaluate(`(() => {
        const input = document.querySelector('[data-testid="input-admin-audit-account"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "No matching account");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('[data-testid="form-admin-audit-search"]').requestSubmit();
      })()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-audit-empty"]')?.innerText.includes('لا توجد تغييرات تطابق البحث')`);
      assert.equal(await evaluate("document.querySelectorAll('[data-testid^=\"row-admin-audit-\"]').length"), 0);

      await evaluate(`document.querySelector('[data-testid="button-admin-audit-clear"]').click()`);
      await waitFor(`document.querySelectorAll('[data-testid^="row-admin-audit-"]').length === 4 &&
        document.querySelector('[data-testid="button-admin-audit-clear"]') === null`);
      assert.deepEqual(auditRequests.at(-1), { account: null, actor: null });

      adminApiFailureStatus = 500;
      await evaluate(`(() => {
        const input = document.querySelector('[data-testid="input-admin-audit-account"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Test Learner");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('[data-testid="form-admin-audit-search"]').requestSubmit();
      })()`);
      await waitFor(`document.querySelector('[data-testid="status-admin-audit-error"]')?.innerText.includes('تعذر تحميل سجل التغييرات')`);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="status-admin-audit-error"] button'))`), true);
      adminApiFailureStatus = null;
      await evaluate(`document.querySelector('[data-testid="status-admin-audit-error"] button').click()`);
      await waitFor(`document.querySelectorAll('[data-testid^="row-admin-audit-"]').length === 3 &&
        document.querySelector('[data-testid="status-admin-audit-error"]') === null`);

      adminApiFailureStatus = 403;
      await waitForApiQuiet();
      await page.send("Page.reload", { ignoreCache: true });
      await waitFor(`document.querySelector('[data-testid="status-admin-users-error"]')?.innerText.includes('لا تملك صلاحية عرض الحسابات') &&
        document.querySelector('[data-testid="status-admin-audit-error"]')?.innerText.includes('لا تملك صلاحية عرض سجل التغييرات')`);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"status-admin-session-expired\"]') === null"), true);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"button-admin-session-login\"]') === null"), true);

      adminApiFailureStatus = 401;
      await waitForApiQuiet();
      await page.send("Page.reload", { ignoreCache: true });
      await waitFor(`document.querySelector('[data-testid="status-admin-users-error"]') !== null &&
        document.querySelector('[data-testid="status-admin-audit-error"]') !== null &&
        document.querySelector('[data-testid="status-admin-session-expired"]') !== null &&
        document.querySelector('[data-testid="button-admin-session-login"]') !== null`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          observedApiRequests > 0 &&
          pendingApiRequests === 0 &&
          Date.now() - lastApiActivity >= 700
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(pendingApiRequests, 0, "finish both failed admin queries before navigating to sign-in");
      assert.ok(Date.now() - lastApiActivity >= 700, "admin query failures should settle before sign-in");
      await evaluate("document.querySelector('[data-testid=\"button-admin-session-login\"]').click()");
      await waitFor(`document.querySelector('[data-testid="row-admin-user-learner-test-user"]') !== null &&
        document.querySelector('[data-testid="list-admin-access-audit"]') !== null &&
        document.querySelector('[data-testid="status-admin-session-expired"]') === null`);
      assert.equal(loginRequests, 4, "each sign-in recovery action should open the login route");
      assert.equal(await evaluate("localStorage.getItem('pmp-sprint-page')"), "admin");
      assert.equal(adminApiFailureStatus, null, "signing in again should let the admin queries recover");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          observedApiRequests > 0 &&
          pendingApiRequests === 0 &&
          Date.now() - lastApiActivity >= 700
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(pendingApiRequests, 0, "finish admin API requests before reloading the page");
      assert.ok(Date.now() - lastApiActivity >= 700, "admin API activity should settle before reloading");

      assert.deepEqual(runtimeExceptions, []);
      assert.deepEqual(browserErrors, []);
      assert.deepEqual(unexpectedInterceptionErrors(), []);

      authRole = "learner";
      await evaluate("localStorage.setItem('pmp-sprint-page', 'admin')");
      await waitForApiQuiet();
      await page.send("Page.reload", { ignoreCache: true });
       await waitFor(`!document.body.innerText.includes('إدارة صلاحيات الحسابات') &&
        document.querySelector('.profile-copy span')?.textContent === 'Learner · PMP candidate'`);
      assert.equal(await evaluate("document.body.innerText.includes('إدارة الوصول')"), false);
      assert.deepEqual(runtimeExceptions, []);
      assert.deepEqual(browserErrors, []);
      assert.deepEqual(unexpectedInterceptionErrors(), []);
    } finally {
      closing = true;
      await page?.close();
      await stopProcess(browser);
      await stopProcess(web);
    }
  },
);

test(
  "instructors can create, edit, publish, and archive questions with visible status feedback",
  { timeout: 60_000 },
  async () => {
    const webPort = await unusedPort();
    const debugPort = await unusedPort();
    const web = spawn("pnpm", ["run", "dev"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        BASE_PATH: "/",
        NODE_ENV: "test",
        PORT: String(webPort),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const browser = spawn(chromiumPath, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/pmp-question-bank-authoring-${process.pid}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let webStderr = "";
    let browserStderr = "";
    web.stderr.setEncoding("utf8");
    browser.stderr.setEncoding("utf8");
    web.stderr.on("data", (chunk) => { webStderr += chunk; });
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });

    const existingQuestion = {
      id: "question-authoring-existing",
      domain: "Process",
      topic: "Risk response planning",
      approach: "predictive",
      difficulty: "medium",
      status: "draft",
      question: "A key supplier may miss a milestone. What should the project manager do first?",
      translation: "قد يتأخر المورد عن إنجاز مرحلة مهمة. ما أول ما ينبغي لمدير المشروع فعله؟",
      options: [
        "Replace the supplier immediately",
        "Assess the risk and plan a response",
        "Ignore the risk until it happens",
        "Ask the sponsor to take over",
      ],
      correctAnswer: 1,
      explanation: "Assess the risk and plan an appropriate response.",
    };
    const questions = [{ ...existingQuestion }];
    const createdQuestionsByIdempotencyKey = new Map();
    const instructorRequests = [];
    const mutationRequests = [];
    const statusRequests = [];
    const runtimeExceptions = [];
    const browserErrors = [];
    const interceptionErrors = [];
    const discardDialogs = [];
    const beforeUnloadDialogs = [];
    let page;
    let closing = false;
    let pendingApiRequests = 0;
    let observedApiRequests = 0;
    let lastApiActivity = Date.now();
    let activeInstructorId = "instructor-authoring-test";
    let acceptNextBeforeUnload = false;
    let acceptNextDiscardDialog = false;
    let holdNextStatusResponse = false;
    let releaseStatusResponse = null;
    let failNextStatusAction = null;
    let failNextSaveMethod = null;
    let loseNextCreateResponseAfterCommit = false;

    const responseForQuestions = (url) => {
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = questions.slice(offset, offset + limit);
      return jsonResponse(200, {
        items,
        pagination: {
          offset,
          limit,
          total: questions.length,
          hasNext: offset + items.length < questions.length,
          nextOffset: offset + items.length < questions.length ? offset + limit : null,
        },
      });
    };
    const waitFor = async (expression, evaluate) => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Timed out waiting for: ${expression}\n` +
        `Instructor requests: ${instructorRequests.map((url) => url.href).join(", ")}\n` +
        `Mutations: ${JSON.stringify(mutationRequests)}\n` +
        `Browser exceptions: ${JSON.stringify(runtimeExceptions)}\n` +
        `Browser errors: ${JSON.stringify(browserErrors)}`,
      );
    };
    const waitForApiQuiet = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          observedApiRequests > 0 &&
          pendingApiRequests === 0 &&
          Date.now() - lastApiActivity >= 200
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `API requests did not settle: pending=${pendingApiRequests}, ` +
        `observed=${observedApiRequests}, errors=${JSON.stringify(interceptionErrors)}`,
      );
    };

    try {
      await waitForHttp(`http://127.0.0.1:${webPort}/`, web, () => webStderr);
      page = await connectToPage(debugPort, browser, () => browserStderr);
      page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
        runtimeExceptions.push({
          text: exceptionDetails.text,
          description: exceptionDetails.exception?.description,
        });
      });
      page.on("Runtime.consoleAPICalled", ({ type, args, stackTrace }) => {
        if (type === "error") {
          browserErrors.push({
            messages: args.map((argument) => argument.value ?? argument.description),
            stackTrace,
          });
        }
      });
      page.on("Page.javascriptDialogOpening", async ({ message, type }) => {
        if (type === "beforeunload") {
          beforeUnloadDialogs.push({ message, type });
          const accept = acceptNextBeforeUnload;
          acceptNextBeforeUnload = false;
          await page.send("Page.handleJavaScriptDialog", { accept });
          return;
        }
        discardDialogs.push({ message, type });
        const accept = acceptNextDiscardDialog;
        acceptNextDiscardDialog = false;
        await page.send("Page.handleJavaScriptDialog", { accept });
      });
      page.on("Fetch.requestPaused", async (request) => {
        let isApiRequest = false;
        try {
          if (closing) return;
          const url = new URL(request.request.url);
          if (!url.pathname.startsWith("/api/")) {
            await page.send("Fetch.continueRequest", { requestId: request.requestId });
            return;
          }
          isApiRequest = true;
          pendingApiRequests += 1;
          observedApiRequests += 1;
          lastApiActivity = Date.now();

          let response = jsonResponse(200, []);
          if (url.pathname === "/api/auth/user") {
            response = jsonResponse(200, {
              user: {
                id: activeInstructorId,
                email: "instructor@example.com",
                firstName: "Test",
                lastName: "Instructor",
                profileImageUrl: null,
                role: "instructor",
              },
            });
          } else if (url.pathname === "/api/instructor/preferences") {
            response = jsonResponse(200, { pageSize: 25 });
          } else if (
            url.pathname === "/api/instructor/questions" &&
            request.request.method === "GET"
          ) {
            instructorRequests.push(url);
            response = responseForQuestions(url);
          } else if (
            url.pathname === "/api/instructor/questions" &&
            request.request.method === "POST"
          ) {
            const payload = JSON.parse(request.request.postData ?? "{}");
            const idempotencyKey = Object.entries(request.request.headers ?? {})
              .find(([name]) => name.toLowerCase() === "idempotency-key")?.[1];
            assert.ok(idempotencyKey, "create requests must carry an idempotency key");
            mutationRequests.push({
              method: "POST",
              id: null,
              payload,
              idempotencyKey,
            });
            if (failNextSaveMethod === "POST") {
              failNextSaveMethod = null;
              response = jsonResponse(503, { error: "Temporary save failure" });
            } else {
              let created = createdQuestionsByIdempotencyKey.get(idempotencyKey);
              const isFirstCreate = !created;
              if (isFirstCreate) {
                created = {
                  ...payload,
                  id: "question-authoring-created",
                  status: "draft",
                };
                createdQuestionsByIdempotencyKey.set(idempotencyKey, created);
                questions.unshift(created);
              }
              if (loseNextCreateResponseAfterCommit) {
                loseNextCreateResponseAfterCommit = false;
                await page.send("Fetch.failRequest", {
                  requestId: request.requestId,
                  errorReason: "Failed",
                });
                return;
              }
              response = jsonResponse(isFirstCreate ? 201 : 200, created);
            }
          } else if (
            /^\/api\/instructor\/questions\/[^/]+$/.test(url.pathname) &&
            request.request.method === "PATCH"
          ) {
            const id = url.pathname.split("/").at(-1);
            const payload = JSON.parse(request.request.postData ?? "{}");
            mutationRequests.push({ method: "PATCH", id, payload });
            if (failNextSaveMethod === "PATCH") {
              failNextSaveMethod = null;
              response = jsonResponse(503, { error: "Temporary save failure" });
            } else {
              const question = questions.find((item) => item.id === id);
              if (question) {
                Object.assign(question, payload);
                response = jsonResponse(200, question);
              } else {
                response = jsonResponse(404, { error: "Question not found" });
              }
            }
          } else if (
            /^\/api\/instructor\/questions\/[^/]+\/(publish|archive|restore)$/.test(url.pathname) &&
            request.request.method === "POST"
          ) {
            const [, id, action] = url.pathname.match(
              /^\/api\/instructor\/questions\/([^/]+)\/(publish|archive|restore)$/,
            );
            statusRequests.push({ method: request.request.method, id, action });
            const question = questions.find((item) => item.id === id);
            if (question) {
              if (failNextStatusAction === action) {
                failNextStatusAction = null;
                response = jsonResponse(503, { error: `Temporary ${action} failure` });
              } else {
                question.status =
                  action === "publish"
                    ? "published"
                    : action === "archive"
                      ? "archived"
                      : "draft";
                response = jsonResponse(200, question);
              }
            } else {
              response = jsonResponse(404, { error: "Question not found" });
            }
            if (holdNextStatusResponse) {
              holdNextStatusResponse = false;
              await new Promise((resolve) => {
                releaseStatusResponse = resolve;
              });
            }
          } else if (url.pathname === "/api/progress/dashboard") {
            response = jsonResponse(200, {
              readinessScore: 0,
              questionCount: 0,
              completedSessions: 0,
              averageScore: 0,
              studyMinutes: 0,
              lastScore: null,
              recentActivity: [],
            });
          } else if (
            url.pathname === "/api/practice/sessions/latest" ||
            url.pathname === "/api/practice/sessions/in-progress"
          ) {
            response = jsonResponse(404, { error: "No practice session found" });
          }

          await page.send("Fetch.fulfillRequest", {
            requestId: request.requestId,
            ...response,
          });
        } catch (error) {
          if (!closing) {
            interceptionErrors.push({
              error: String(error),
              url: request.request.url,
              method: request.request.method,
            });
          }
        } finally {
          if (isApiRequest) {
            pendingApiRequests -= 1;
            lastApiActivity = Date.now();
          }
        }
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Fetch.enable", {
        patterns: [{ urlPattern: `http://127.0.0.1:${webPort}/api/*`, requestStage: "Request" }],
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
      const reloadPage = async () => {
        await waitForApiQuiet();
        const previousTimeOrigin = await evaluate("performance.timeOrigin");
        await page.send("Page.reload", { ignoreCache: true });
        await waitFor(
          `performance.timeOrigin !== ${previousTimeOrigin} && document.readyState === "complete"`,
          evaluate,
        );
        await waitFor(
          "Boolean(document.querySelector('[data-testid=\"row-instructor-question-question-authoring-existing\"]'))",
          evaluate,
        );
        await waitForApiQuiet();
      };
      const setInputValue = async (selector, value) => {
        await evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(selector)});
          const prototype = input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
      };
      const clickElement = async (selector) => {
        const { x, y } = await evaluate(`(() => {
          const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        await page.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await page.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      };
      const setSelectValue = async (selector, value) => {
        await evaluate(`(() => {
          const select = document.querySelector(${JSON.stringify(selector)});
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
            .set.call(select, ${JSON.stringify(value)});
          select.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
      };

      await waitFor("Boolean(document.querySelector('.app-frame'))", evaluate);
      await waitFor("document.querySelector('.profile-copy strong')?.textContent === 'Test Instructor'", evaluate);
      await waitForApiQuiet();
      await evaluate("localStorage.setItem('pmp-sprint-page', 'instructor')");
      await page.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/` });
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"row-instructor-question-question-authoring-existing\"]'))",
        evaluate,
      );
      await waitForApiQuiet();

      await evaluate("document.querySelector('[data-testid=\"button-new-question\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      assert.equal(await evaluate("document.querySelector('[data-testid=\"input-question-topic\"]').value"), "");
      const cleanFormBeforeUnloadCount = beforeUnloadDialogs.length;
      await reloadPage();
      await waitFor("Boolean(document.querySelector('[data-testid=\"button-new-question\"]'))", evaluate);
      assert.equal(
        beforeUnloadDialogs.length,
        cleanFormBeforeUnloadCount,
        "refreshing with a clean question form should not show a browser warning",
      );
      await evaluate("document.querySelector('[data-testid=\"button-new-question\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      await evaluate("document.querySelector('[aria-label=\"إغلاق النموذج\"]').click()");
      await waitFor("!document.querySelector('[data-testid=\"dialog-question-form\"]')", evaluate);
      assert.equal(discardDialogs.length, 0, "closing an unchanged form should not prompt");

      await evaluate("document.querySelector('[data-testid=\"button-new-question\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      await clickElement('[data-testid="input-question-topic"]');
      await page.send("Input.insertText", { text: "Unsaved changes" });
      await waitFor(
        "document.querySelector('[data-testid=\"input-question-topic\"]')?.value === 'Unsaved changes'",
        evaluate,
      );
      const firstInstructorDraftKey =
        `pmp-sprint-instructor-draft:v1:${encodeURIComponent(activeInstructorId)}`;
      await waitFor(
        `JSON.parse(localStorage.getItem(${JSON.stringify(firstInstructorDraftKey)}))?.form.topic === 'Unsaved changes'`,
        evaluate,
      );
      const dirtyFormBeforeUnloadCount = beforeUnloadDialogs.length;
      acceptNextBeforeUnload = true;
      await reloadPage();
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"dialog-recovered-question-draft\"]'))",
        evaluate,
      );
      assert.equal(
        beforeUnloadDialogs.length,
        dirtyFormBeforeUnloadCount + 1,
        "a dirty editor should warn before an intentional reload",
      );
      assert.equal(beforeUnloadDialogs.at(-1).type, "beforeunload");

      activeInstructorId = "instructor-other-account";
      await reloadPage();
      await waitFor(
        "!document.querySelector('[data-testid=\"dialog-recovered-question-draft\"]')",
        evaluate,
      );
      const secondInstructorDraftKey =
        `pmp-sprint-instructor-draft:v1:${encodeURIComponent(activeInstructorId)}`;
      assert.equal(
        await evaluate(`localStorage.getItem(${JSON.stringify(secondInstructorDraftKey)})`),
        null,
        "another signed-in account must not have access to the first instructor's recovery draft",
      );
      assert.notEqual(
        await evaluate(`localStorage.getItem(${JSON.stringify(firstInstructorDraftKey)})`),
        null,
        "switching accounts should leave the original instructor's draft intact",
      );

      await evaluate("document.querySelector('[data-testid=\"button-new-question\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      await setInputValue('[data-testid="input-question-topic"]', "Second account draft");
      await waitFor(
        `JSON.parse(localStorage.getItem(${JSON.stringify(secondInstructorDraftKey)}))?.form.topic === 'Second account draft'`,
        evaluate,
      );
      acceptNextBeforeUnload = true;
      await reloadPage();
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"dialog-recovered-question-draft\"]'))",
        evaluate,
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"status-recovered-question-draft-preview\"]').textContent.includes('Second account draft')"),
        true,
        "the second instructor should only see their own recovered work",
      );
      await evaluate("document.querySelector('[data-testid=\"button-discard-question-draft\"]').click()");
      await waitFor(
        "!document.querySelector('[data-testid=\"dialog-recovered-question-draft\"]')",
        evaluate,
      );
      assert.equal(
        await evaluate(`localStorage.getItem(${JSON.stringify(secondInstructorDraftKey)})`),
        null,
        "discarding recovered work should remove its saved copy",
      );

      activeInstructorId = "instructor-authoring-test";
      await reloadPage();
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"dialog-recovered-question-draft\"]'))",
        evaluate,
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"status-recovered-question-draft-preview\"]').textContent.includes('Unsaved changes')"),
        true,
        "the original instructor should still be offered their own recovered work",
      );
      await evaluate("document.querySelector('[data-testid=\"button-restore-question-draft\"]').click()");
      await waitFor(
        "document.querySelector('[data-testid=\"input-question-topic\"]')?.value === 'Unsaved changes'",
        evaluate,
      );
      await evaluate("document.querySelector('.form-modal-footer .secondary-button').click()");
      await waitFor("document.querySelector('[data-testid=\"dialog-question-form\"]') !== null", evaluate);
      assert.deepEqual(discardDialogs[0], {
        message: "لديك تغييرات غير محفوظة. هل تريد تجاهلها وإغلاق النموذج؟",
        type: "confirm",
      });
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"input-question-topic\"]').value"),
        "Unsaved changes",
        "declining the discard prompt should keep edits in the open form",
      );
      acceptNextDiscardDialog = true;
      await evaluate("document.querySelector('[aria-label=\"إغلاق النموذج\"]').click()");
      await waitFor("!document.querySelector('[data-testid=\"dialog-question-form\"]')", evaluate);
      assert.equal(discardDialogs.length, 2, "confirming discard should close the edited form");

      await evaluate("document.querySelector('[data-testid=\"button-new-question\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      await evaluate("document.querySelector('[data-testid=\"button-save-question\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"status-question-validation\"]'))", evaluate);
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"status-question-validation\"]').textContent.includes('أكمل كل الحقول واختر الإجابة الصحيحة قبل الحفظ.')"),
        true,
      );
      assert.equal(mutationRequests.length, 0);
      assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))"), true);

      await setSelectValue('[data-testid="select-question-domain"]', "People");
      await setInputValue('[data-testid="input-question-topic"]', "Stakeholder alignment");
      await setSelectValue('[data-testid="select-question-approach"]', "hybrid");
      await setSelectValue('[data-testid="select-question-difficulty"]', "hard");
      await setInputValue('[data-testid="input-question-text"]', "A stakeholder rejects a proposed change. What should the project manager do?");
      await setInputValue('[data-testid="textarea-question-translation"]', "يرفض أحد أصحاب المصلحة تغييرًا مقترحًا. ماذا ينبغي لمدير المشروع أن يفعل؟");
      await setInputValue('[data-testid="input-question-option-0"]', "Implement the change without discussion");
      await setInputValue('[data-testid="input-question-option-1"]', "Review the impact and engage the stakeholder");
      await setInputValue('[data-testid="input-question-option-2"]', "Escalate immediately to the sponsor");
      await setInputValue('[data-testid="input-question-option-3"]', "Remove the stakeholder from the project");
      await evaluate('document.querySelector(\'input[name="correctAnswer"][aria-label="تحديد الخيار 2 كإجابة صحيحة"]\').click()');
      await setInputValue('[data-testid="textarea-question-explanation"]', "Understand the concern and assess the change before deciding.");

      const createPayload = {
        domain: "People",
        topic: "Stakeholder alignment",
        approach: "hybrid",
        difficulty: "hard",
        question: "A stakeholder rejects a proposed change. What should the project manager do?",
        translation: "يرفض أحد أصحاب المصلحة تغييرًا مقترحًا. ماذا ينبغي لمدير المشروع أن يفعل؟",
        options: [
          "Implement the change without discussion",
          "Review the impact and engage the stakeholder",
          "Escalate immediately to the sponsor",
          "Remove the stakeholder from the project",
        ],
        correctAnswer: 1,
        explanation: "Understand the concern and assess the change before deciding.",
      };
      const readsBeforeCreate = instructorRequests.length;
      failNextSaveMethod = "POST";
      await evaluate("document.querySelector('[data-testid=\"button-save-question\"]').click()");
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"status-question-save-error\"]'))",
        evaluate,
      );
      assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))"), true);
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"status-question-save-error\"]').textContent.includes('Temporary save failure')"),
        true,
        "a failed create should show the API error in the form",
      );
      assert.deepEqual(
        await evaluate(`({
          domain: document.querySelector('[data-testid="select-question-domain"]').value,
          topic: document.querySelector('[data-testid="input-question-topic"]').value,
          approach: document.querySelector('[data-testid="select-question-approach"]').value,
          difficulty: document.querySelector('[data-testid="select-question-difficulty"]').value,
          question: document.querySelector('[data-testid="input-question-text"]').value,
          translation: document.querySelector('[data-testid="textarea-question-translation"]').value,
          options: Array.from({ length: 4 }, (_, index) =>
            document.querySelector('[data-testid="input-question-option-' + index + '"]').value),
          correctAnswer: Array.from(document.querySelectorAll('input[name="correctAnswer"]'))
            .findIndex((radio) => radio.checked),
          explanation: document.querySelector('[data-testid="textarea-question-explanation"]').value
        })`),
        createPayload,
        "a failed create should preserve every entered field",
      );
      loseNextCreateResponseAfterCommit = true;
      await evaluate("document.querySelector('[data-testid=\"button-save-question\"]').click()");
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"status-question-save-error\"]')) && " +
          "document.querySelector('[data-testid=\"dialog-question-form\"]') !== null",
        evaluate,
      );
      assert.equal(
        createdQuestionsByIdempotencyKey.size,
        1,
        "the mock server should commit the draft before dropping the response",
      );
      assert.equal(questions.filter((item) => item.id === "question-authoring-created").length, 1);

      await evaluate("document.querySelector('[data-testid=\"button-save-question\"]').click()");
      await waitFor(
        "!document.querySelector('[data-testid=\"dialog-question-form\"]') && " +
          "Boolean(document.querySelector('[data-testid=\"row-instructor-question-question-authoring-created\"]'))",
        evaluate,
      );
      assert.equal(mutationRequests.length, 3);
      assert.equal(discardDialogs.length, 2, "saving successfully should close without a discard prompt");
      assert.ok(
        mutationRequests.every((request) => request.idempotencyKey === mutationRequests[0].idempotencyKey),
        "all retries for the open create operation should reuse one idempotency key",
      );
      assert.match(mutationRequests[0].idempotencyKey, /^[0-9a-f-]{36}$/i);
      for (const mutation of mutationRequests) {
        assert.deepEqual(
          { method: mutation.method, id: mutation.id, payload: mutation.payload },
          { method: "POST", id: null, payload: createPayload },
        );
      }
      assert.equal(createdQuestionsByIdempotencyKey.size, 1);
      assert.equal(questions.filter((item) => item.id === "question-authoring-created").length, 1);
      assert.ok(instructorRequests.length > readsBeforeCreate, "the visible library should be refetched after creation");
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"row-instructor-question-question-authoring-created\"] h3').textContent"),
        createPayload.question,
      );
      const savedFormBeforeUnloadCount = beforeUnloadDialogs.length;
      await reloadPage();
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"row-instructor-question-question-authoring-created\"]'))",
        evaluate,
      );
      assert.equal(
        beforeUnloadDialogs.length,
        savedFormBeforeUnloadCount,
        "refreshing after a successful save should not show a browser warning",
      );

      await evaluate("document.querySelector('[data-testid=\"button-edit-question-question-authoring-existing\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      assert.deepEqual(
        await evaluate(`({
          domain: document.querySelector('[data-testid="select-question-domain"]').value,
          topic: document.querySelector('[data-testid="input-question-topic"]').value,
          approach: document.querySelector('[data-testid="select-question-approach"]').value,
          difficulty: document.querySelector('[data-testid="select-question-difficulty"]').value,
          question: document.querySelector('[data-testid="input-question-text"]').value,
          translation: document.querySelector('[data-testid="textarea-question-translation"]').value,
          options: Array.from({ length: 4 }, (_, index) =>
            document.querySelector('[data-testid="input-question-option-' + index + '"]').value),
          correctAnswer: Array.from(document.querySelectorAll('input[name="correctAnswer"]'))
            .findIndex((radio) => radio.checked),
          explanation: document.querySelector('[data-testid="textarea-question-explanation"]').value
        })`),
        {
          domain: existingQuestion.domain,
          topic: existingQuestion.topic,
          approach: existingQuestion.approach,
          difficulty: existingQuestion.difficulty,
          question: existingQuestion.question,
          translation: existingQuestion.translation,
          options: existingQuestion.options,
          correctAnswer: existingQuestion.correctAnswer,
          explanation: existingQuestion.explanation,
        },
      );

      await setInputValue(
        '[data-testid="input-question-text"]',
        "This edit should be discarded after confirmation.",
      );
      await evaluate("document.querySelector('.form-modal-footer .secondary-button').click()");
      assert.equal(discardDialogs.length, 3);
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"input-question-text\"]').value"),
        "This edit should be discarded after confirmation.",
        "declining an edit discard should preserve the in-progress change",
      );
      acceptNextDiscardDialog = true;
      await evaluate("document.querySelector('.form-modal-footer .secondary-button').click()");
      await waitFor("!document.querySelector('[data-testid=\"dialog-question-form\"]')", evaluate);
      assert.equal(discardDialogs.length, 4);

      await evaluate("document.querySelector('[data-testid=\"button-edit-question-question-authoring-existing\"]').click()");
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"input-question-text\"]').value"),
        existingQuestion.question,
        "reopening an edit should load the saved question value",
      );
      const updatedQuestion = "A key supplier may miss a milestone. How should the project manager respond?";
      const updatedTopic = "Supplier risk response";
      await setInputValue('[data-testid="input-question-text"]', updatedQuestion);
      await setInputValue('[data-testid="input-question-topic"]', updatedTopic);
      const readsBeforeUpdate = instructorRequests.length;
      failNextSaveMethod = "PATCH";
      await evaluate("document.querySelector('[data-testid=\"button-save-question\"]').click()");
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"status-question-save-error\"]'))",
        evaluate,
      );
      assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))"), true);
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"status-question-save-error\"]').textContent.includes('Temporary save failure')"),
        true,
        "a failed update should show the API error in the form",
      );
      assert.deepEqual(
        await evaluate(`({
          question: document.querySelector('[data-testid="input-question-text"]').value,
          topic: document.querySelector('[data-testid="input-question-topic"]').value
        })`),
        { question: updatedQuestion, topic: updatedTopic },
        "a failed update should preserve edited fields",
      );
      await evaluate("document.querySelector('[data-testid=\"button-save-question\"]').click()");
      await waitFor(
        "!document.querySelector('[data-testid=\"dialog-question-form\"]') && " +
          "document.querySelector('[data-testid=\"row-instructor-question-question-authoring-existing\"] h3')?.textContent === " +
          JSON.stringify(updatedQuestion) + " && " +
          "document.querySelector('[data-testid=\"row-instructor-question-question-authoring-existing\"] p')?.textContent === " +
          JSON.stringify(updatedTopic),
        evaluate,
      );
      assert.equal(mutationRequests.length, 5);
      assert.equal(discardDialogs.length, 4, "saving an edited question should not prompt to discard");
      assert.deepEqual(mutationRequests[3], {
        method: "PATCH",
        id: existingQuestion.id,
        payload: {
          domain: existingQuestion.domain,
          topic: updatedTopic,
          approach: existingQuestion.approach,
          difficulty: existingQuestion.difficulty,
          question: updatedQuestion,
          translation: existingQuestion.translation,
          options: existingQuestion.options,
          correctAnswer: existingQuestion.correctAnswer,
          explanation: existingQuestion.explanation,
        },
      });
      assert.deepEqual(mutationRequests[4], mutationRequests[3], "retrying should submit the retained update values");
      assert.ok(instructorRequests.length > readsBeforeUpdate, "the visible library should be refetched after editing");

      const waitForStatusRequest = async (count) => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (statusRequests.length >= count && releaseStatusResponse) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for status request ${count}: ${JSON.stringify(statusRequests)}`);
      };
      const completeHeldStatusRequest = () => {
        assert.equal(typeof releaseStatusResponse, "function", "the status request should still be pending");
        const release = releaseStatusResponse;
        releaseStatusResponse = null;
        release();
      };

      failNextStatusAction = "publish";
      await evaluate(`document.querySelector('[data-testid="button-publish-question-${existingQuestion.id}"]').click()`);
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-action-error"]')?.textContent.includes('Temporary publish failure')`,
        evaluate,
      );
      assert.deepEqual(statusRequests[0], {
        method: "POST",
        id: existingQuestion.id,
        action: "publish",
      });
      assert.equal(
        questions.find((question) => question.id === existingQuestion.id)?.status,
        "draft",
        "a rejected publish should not change the stored question",
      );
      assert.deepEqual(
        await evaluate(`(() => {
          const row = document.querySelector('[data-testid="row-instructor-question-${existingQuestion.id}"]');
          const publish = document.querySelector('[data-testid="button-publish-question-${existingQuestion.id}"]');
          return {
            stillDraft: row.querySelector('.question-row-meta').textContent.includes('مسودة'),
            publishDisabled: publish.disabled,
            errorIsAlert: document.querySelector('[data-testid="status-instructor-action-error"]').getAttribute('role'),
            errorIsLive: document.querySelector('[data-testid="status-instructor-action-error"]').getAttribute('aria-live')
          };
        })()`),
        {
          stillDraft: true,
          publishDisabled: false,
          errorIsAlert: "alert",
          errorIsLive: "polite",
        },
        "a rejected publish should preserve draft status, report the server error, and leave retry available",
      );

      const readsBeforePublish = instructorRequests.length;
      holdNextStatusResponse = true;
      await evaluate(`document.querySelector('[data-testid="button-publish-question-${existingQuestion.id}"]').click()`);
      await waitForStatusRequest(2);
      await waitFor(
        `(() => {
          const publish = document.querySelector('[data-testid="button-publish-question-${existingQuestion.id}"]');
          const archive = document.querySelector('[data-testid="button-archive-question-${existingQuestion.id}"]');
          return publish?.disabled && archive?.disabled && publish.textContent.includes('جارٍ');
        })()`,
        evaluate,
      );
      assert.deepEqual(statusRequests[0], {
        method: "POST",
        id: existingQuestion.id,
        action: "publish",
      });
      assert.deepEqual(statusRequests[1], {
        method: "POST",
        id: existingQuestion.id,
        action: "publish",
      });
      completeHeldStatusRequest();
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-feedback"]')?.textContent.includes('تم نشر السؤال.') &&
         document.querySelector('[data-testid="row-instructor-question-${existingQuestion.id}"] .question-row-meta')?.textContent.includes('منشور')`,
        evaluate,
      );
      assert.ok(instructorRequests.length > readsBeforePublish, "the library should refresh after publishing");

      failNextStatusAction = "archive";
      await evaluate(`document.querySelector('[data-testid="button-archive-question-${existingQuestion.id}"]').click()`);
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-action-error"]')?.textContent.includes('Temporary archive failure')`,
        evaluate,
      );
      assert.equal(
        questions.find((question) => question.id === existingQuestion.id)?.status,
        "published",
        "a rejected archive should not change the stored question",
      );
      assert.deepEqual(
        await evaluate(`(() => {
          const row = document.querySelector('[data-testid="row-instructor-question-${existingQuestion.id}"]');
          const archive = document.querySelector('[data-testid="button-archive-question-${existingQuestion.id}"]');
          return {
            stillPublished: row.querySelector('.question-row-meta').textContent.includes('منشور'),
            archiveDisabled: archive.disabled
          };
        })()`),
        {
          stillPublished: true,
          archiveDisabled: false,
        },
        "a rejected archive should preserve published status, show the server error, and leave retry available",
      );

      const readsBeforeArchive = instructorRequests.length;
      holdNextStatusResponse = true;
      await evaluate(`document.querySelector('[data-testid="button-archive-question-${existingQuestion.id}"]').click()`);
      await waitForStatusRequest(4);
      await waitFor(
        `(() => {
          const publish = document.querySelector('[data-testid="button-publish-question-${existingQuestion.id}"]');
          const archive = document.querySelector('[data-testid="button-archive-question-${existingQuestion.id}"]');
          return publish?.disabled && archive?.disabled && archive.textContent.includes('جارٍ');
        })()`,
        evaluate,
      );
      assert.deepEqual(statusRequests[2], {
        method: "POST",
        id: existingQuestion.id,
        action: "archive",
      });
      assert.deepEqual(statusRequests[3], {
        method: "POST",
        id: existingQuestion.id,
        action: "archive",
      });
      completeHeldStatusRequest();
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-feedback"]')?.textContent.includes('تمت أرشفة السؤال.') &&
         document.querySelector('[data-testid="row-instructor-question-${existingQuestion.id}"] .question-row-meta')?.textContent.includes('مؤرشف')`,
        evaluate,
      );
      assert.ok(instructorRequests.length > readsBeforeArchive, "the library should refresh after retrying archive");

      failNextStatusAction = "restore";
      await evaluate(`document.querySelector('[data-testid="button-restore-question-${existingQuestion.id}"]').click()`);
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-action-error"]')?.textContent.includes('Temporary restore failure')`,
        evaluate,
      );
      assert.equal(
        questions.find((question) => question.id === existingQuestion.id)?.status,
        "archived",
        "a rejected restore should leave the question archived",
      );
      assert.deepEqual(
        await evaluate(`(() => {
          const row = document.querySelector('[data-testid="row-instructor-question-${existingQuestion.id}"]');
          const restore = document.querySelector('[data-testid="button-restore-question-${existingQuestion.id}"]');
          return {
            stillArchived: row.querySelector('.question-row-meta').textContent.includes('مؤرشف'),
            restoreEnabled: !restore.disabled,
            errorIsAlert: document.querySelector('[data-testid="status-instructor-action-error"]').getAttribute('role')
          };
        })()`),
        {
          stillArchived: true,
          restoreEnabled: true,
          errorIsAlert: "alert",
        },
        "a rejected restore should show the server error and leave retry available",
      );

      const readsBeforeRestore = instructorRequests.length;
      holdNextStatusResponse = true;
      await evaluate(`document.querySelector('[data-testid="button-restore-question-${existingQuestion.id}"]').click()`);
      await waitForStatusRequest(6);
      await waitFor(
        `(() => {
          const publish = document.querySelector('[data-testid="button-publish-question-${existingQuestion.id}"]');
          const archive = document.querySelector('[data-testid="button-archive-question-${existingQuestion.id}"]');
          const restore = document.querySelector('[data-testid="button-restore-question-${existingQuestion.id}"]');
          return publish?.disabled && archive?.disabled && restore?.disabled && restore.textContent.includes('جارٍ');
        })()`,
        evaluate,
      );
      assert.deepEqual(statusRequests[5], {
        method: "POST",
        id: existingQuestion.id,
        action: "restore",
      });
      completeHeldStatusRequest();
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-feedback"]')?.textContent.includes('تمت استعادة السؤال كمسودة للمراجعة قبل النشر.') &&
         document.querySelector('[data-testid="row-instructor-question-${existingQuestion.id}"] .question-row-meta')?.textContent.includes('مسودة')`,
        evaluate,
      );
      assert.equal(
        questions.find((question) => question.id === existingQuestion.id)?.status,
        "draft",
        "a successful restore should return the question to draft",
      );
      assert.ok(instructorRequests.length > readsBeforeRestore, "the library should refetch after restoring");

      const createdQuestionId = "question-authoring-created";
      const readsBeforeCreatedArchive = instructorRequests.length;
      holdNextStatusResponse = true;
      await evaluate(`document.querySelector('[data-testid="button-archive-question-${createdQuestionId}"]').click()`);
      await waitForStatusRequest(7);
      await waitFor(
        `(() => {
          const publish = document.querySelector('[data-testid="button-publish-question-${createdQuestionId}"]');
          const archive = document.querySelector('[data-testid="button-archive-question-${createdQuestionId}"]');
          return publish?.disabled && archive?.disabled && archive.textContent.includes('جارٍ');
        })()`,
        evaluate,
      );
      assert.deepEqual(statusRequests[6], {
        method: "POST",
        id: createdQuestionId,
        action: "archive",
      });
      completeHeldStatusRequest();
      await waitFor(
        `document.querySelector('[data-testid="status-instructor-feedback"]')?.textContent.includes('تمت أرشفة السؤال.') &&
         document.querySelector('[data-testid="row-instructor-question-${createdQuestionId}"] .question-row-meta')?.textContent.includes('مؤرشف')`,
        evaluate,
      );
      assert.ok(instructorRequests.length > readsBeforeCreatedArchive, "the library should refresh after archiving");

      await evaluate(`document.querySelector('[data-testid="button-edit-question-${existingQuestion.id}"]').click()`);
      await waitFor("Boolean(document.querySelector('[data-testid=\"dialog-question-form\"]'))", evaluate);
      const recoveredEditText = "Recovered edit after browser restart";
      await setInputValue('[data-testid="input-question-text"]', recoveredEditText);
      await waitFor(
        `JSON.parse(localStorage.getItem(${JSON.stringify(firstInstructorDraftKey)}))?.editingId === ${JSON.stringify(existingQuestion.id)} &&
         JSON.parse(localStorage.getItem(${JSON.stringify(firstInstructorDraftKey)}))?.form.question === ${JSON.stringify(recoveredEditText)}`,
        evaluate,
      );
      acceptNextBeforeUnload = true;
      await reloadPage();
      await waitFor(
        "Boolean(document.querySelector('[data-testid=\"dialog-recovered-question-draft\"]'))",
        evaluate,
      );
      assert.equal(
        await evaluate("document.querySelector('[data-testid=\"status-recovered-question-draft-preview\"]').textContent.includes('تعديلات على سؤال موجود')"),
        true,
        "the recovery summary should identify an edit to an existing question",
      );
      await evaluate("document.querySelector('[data-testid=\"button-restore-question-draft\"]').click()");
      await waitFor(
        `document.querySelector('[data-testid="input-question-text"]')?.value === ${JSON.stringify(recoveredEditText)}`,
        evaluate,
      );
      assert.equal(
        await evaluate("document.querySelector('#question-form-title')?.textContent.includes('تعديل السؤال')"),
        true,
        "restoring an edit should reopen the correct existing-question form",
      );
      acceptNextDiscardDialog = true;
      await evaluate("document.querySelector('[aria-label=\"إغلاق النموذج\"]').click()");
      await waitFor("!document.querySelector('[data-testid=\"dialog-question-form\"]')", evaluate);
      assert.equal(
        await evaluate(`localStorage.getItem(${JSON.stringify(firstInstructorDraftKey)})`),
        null,
        "discarding a restored edit should remove its recovery copy",
      );
      assert.deepEqual(runtimeExceptions, []);
      assert.deepEqual(browserErrors, []);
      assert.deepEqual(interceptionErrors, []);
    } finally {
      closing = true;
      await page?.close();
      await stopProcess(browser);
      await stopProcess(web);
    }
  },
);