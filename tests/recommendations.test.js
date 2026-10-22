const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const app = require("../backend/app");
const {
  checkOllamaStatus,
  generateRecommendations,
  validateModelOutput,
  buildPrompt
} = require("../backend/services/recommendationService");

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function startMockOllama(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function createTempDir(prefix = "filo-rec-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDirRecursive(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup error
  }
}

test("GET /api/recommendations/status reports Ollama availability and model info", async (t) => {
  const { server: mockOllama, url: mockUrl } = await startMockOllama((req, res) => {
    if (req.url === "/api/tags" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        models: [
          { name: "gemma2:2b", size: 1600000000 },
          { name: "llama3:latest", size: 4000000000 }
        ]
      }));
      return;
    }
    res.writeHead(404).end();
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalModel = process.env.OLLAMA_MODEL;
  process.env.OLLAMA_BASE_URL = mockUrl;
  process.env.OLLAMA_MODEL = "gemma2:2b";

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    process.env.OLLAMA_MODEL = originalModel;
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations/status`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.available, true);
  assert.equal(body.data.model, "gemma2:2b");
  assert.equal(body.data.modelInstalled, true);
  assert.equal(body.data.installedModels.includes("gemma2:2b"), true);
});

test("POST /api/recommendations returns validated recommendations from mock Ollama", async (t) => {
  const tempDir = createTempDir("filo-rec-valid-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "docs", "invoice1.pdf"), "content-1", "utf8");
  fs.writeFileSync(path.join(tempDir, "docs", "invoice2.pdf"), "content-2", "utf8");
  fs.writeFileSync(path.join(tempDir, "notes.txt"), "some notes", "utf8");

  let receivedPrompt = "";

  const { server: mockOllama, url: mockUrl } = await startMockOllama(async (req, res) => {
    if (req.url === "/api/generate" && req.method === "POST") {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = JSON.parse(bodyText);
      receivedPrompt = parsedBody.prompt;

      const mockModelOutput = {
        recommendations: [
          {
            id: "rec_invoices",
            type: "type_grouping",
            title: "Consolidate PDF Invoices",
            explanation: "Group invoice documents into a dedicated finance subfolder.",
            relevantPaths: ["docs/invoice1.pdf", "docs/invoice2.pdf"],
            confidence: "high",
            requiresReview: true
          }
        ]
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model: "gemma2:2b",
        response: JSON.stringify(mockModelOutput),
        done: true
      }));
      return;
    }
    res.writeHead(404).end();
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = mockUrl;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    removeDirRecursive(tempDir);
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(Array.isArray(body.data.recommendations), true);
  assert.equal(body.data.recommendations.length, 1);

  const rec = body.data.recommendations[0];
  assert.equal(rec.id, "rec_invoices");
  assert.equal(rec.type, "type_grouping");
  assert.equal(rec.title, "Consolidate PDF Invoices");
  assert.equal(rec.confidence, "high");
  assert.equal(rec.requiresReview, true);
  assert.deepEqual(rec.relevantPaths, ["docs/invoice1.pdf", "docs/invoice2.pdf"]);

  // Verify privacy: prompt sent to Ollama must NOT contain local absolute path or file contents
  assert.equal(receivedPrompt.includes(tempDir), false, "Prompt must not expose absolute directory path");
  assert.equal(receivedPrompt.includes("content-1"), false, "Prompt must not expose file contents");
  assert.equal(receivedPrompt.includes("docs/invoice1.pdf"), true, "Prompt should contain relative paths");
});

test("POST /api/recommendations sanitizes and strips hallucinated paths not in scan", async (t) => {
  const tempDir = createTempDir("filo-rec-hallucinated-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "real.txt"), "data", "utf8");

  const { server: mockOllama, url: mockUrl } = await startMockOllama(async (req, res) => {
    if (req.url === "/api/generate" && req.method === "POST") {
      const mockModelOutput = {
        recommendations: [
          {
            id: "rec_1",
            type: "file_organization",
            title: "Organize files",
            explanation: "Some explanation",
            // Notice: phantom.pdf does not exist in tempDir!
            relevantPaths: ["real.txt", "phantom.pdf", "../../../escaped.txt"],
            confidence: "medium"
          }
        ]
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model: "gemma2:2b",
        response: JSON.stringify(mockModelOutput),
        done: true
      }));
      return;
    }
    res.writeHead(404).end();
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = mockUrl;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    removeDirRecursive(tempDir);
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.recommendations.length, 1);

  // phantom.pdf and escaped.txt must have been stripped away!
  assert.deepEqual(body.data.recommendations[0].relevantPaths, ["real.txt"]);
});

test("POST /api/recommendations rejects malformed JSON output with 502 INVALID_MODEL_OUTPUT", async (t) => {
  const tempDir = createTempDir("filo-rec-malformed-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "test.txt"), "data", "utf8");

  const { server: mockOllama, url: mockUrl } = await startMockOllama((req, res) => {
    if (req.url === "/api/generate" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model: "gemma2:2b",
        response: "Here are recommendations: { this is NOT valid JSON ...",
        done: true
      }));
      return;
    }
    res.writeHead(404).end();
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = mockUrl;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    removeDirRecursive(tempDir);
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INVALID_MODEL_OUTPUT");
});

test("POST /api/recommendations handles Ollama unavailable with 503 OLLAMA_UNAVAILABLE", async (t) => {
  const tempDir = createTempDir("filo-rec-offline-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "file.txt"), "content", "utf8");

  // Point to a non-existent port where Ollama is definitely not listening
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:54321";

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OLLAMA_UNAVAILABLE");
});

test("POST /api/recommendations handles Ollama timeout with 504 OLLAMA_TIMEOUT", async (t) => {
  const tempDir = createTempDir("filo-rec-timeout-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "file.txt"), "content", "utf8");

  // Mock server that never responds to simulate timeout
  const { server: mockOllama, url: mockUrl } = await startMockOllama((req, res) => {
    // Deliberately do not respond
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalTimeout = process.env.OLLAMA_TIMEOUT_MS;
  process.env.OLLAMA_BASE_URL = mockUrl;
  process.env.OLLAMA_TIMEOUT_MS = "1000"; // 1s timeout for fast test

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    process.env.OLLAMA_TIMEOUT_MS = originalTimeout;
    removeDirRecursive(tempDir);
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 504);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OLLAMA_TIMEOUT");
});

test("POST /api/recommendations handles model not found in Ollama with 404 MODEL_NOT_FOUND", async (t) => {
  const tempDir = createTempDir("filo-rec-nomodel-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "file.txt"), "content", "utf8");

  const { server: mockOllama, url: mockUrl } = await startMockOllama((req, res) => {
    if (req.url === "/api/generate" && req.method === "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "model 'gemma2:2b' not found, try pulling it first" }));
      return;
    }
    res.writeHead(404).end();
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = mockUrl;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    removeDirRecursive(tempDir);
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "MODEL_NOT_FOUND");
});

test("POST /api/recommendations rejects path traversal outside approved root with 403 OUTSIDE_APPROVED_ROOT", async (t) => {
  const tempDir = createTempDir("filo-rec-traversal-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../../../" })
  });

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OUTSIDE_APPROVED_ROOT");
});

test("POST /api/recommendations returns empty recommendations for empty directory without invoking Ollama", async (t) => {
  const tempDir = createTempDir("filo-rec-empty-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  let ollamaInvoked = false;
  const { server: mockOllama, url: mockUrl } = await startMockOllama((req, res) => {
    ollamaInvoked = true;
    res.writeHead(500).end();
  });

  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = mockUrl;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
    removeDirRecursive(tempDir);
    mockOllama.close();
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.recommendations.length, 0);
  assert.equal(ollamaInvoked, false, "Ollama should not be invoked for an empty directory");
});

test("recommendations service does not mutate filesystem files", async (t) => {
  const tempDir = createTempDir("filo-rec-nomutate-");
  const filePath = path.join(tempDir, "sample.txt");
  const initialContent = "Protected content that must not be changed";
  fs.writeFileSync(filePath, initialContent, "utf8");

  const { server: mockOllama, url: mockUrl } = await startMockOllama((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: "gemma2:2b",
      response: JSON.stringify({
        recommendations: [
          {
            id: "rec_1",
            type: "file_organization",
            title: "Suggest archive",
            explanation: "Archive this file",
            relevantPaths: ["sample.txt"],
            confidence: "low"
          }
        ]
      }),
      done: true
    }));
  });

  t.after(() => {
    mockOllama.close();
    removeDirRecursive(tempDir);
  });

  const result = await generateRecommendations(".", {
    approvedRoot: tempDir,
    baseUrl: mockUrl
  });

  assert.equal(result.success, true);
  // File must remain unchanged and exist in its original location
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.readFileSync(filePath, "utf8"), initialContent);
});
