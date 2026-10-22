const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const app = require("../backend/app");
const {
  previewOperation,
  executeOperation,
  undoOperation,
  resolveRecoveryOperation,
  getOperationHistory,
  initOrganizationService,
  resetServiceState
} = require("../backend/services/organizationService");
const {
  readJournalEntries,
  appendJournalEntry,
  loadAndRecoverJournal
} = require("../backend/services/recoveryJournal");

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

function createTempDir(prefix = "filo-org-test-") {
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

test("POST /api/organization/preview validates move and never modifies files on disk", async (t) => {
  const tempDir = createTempDir("filo-org-preview-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const fileName = "report.pdf";
  const sourceFile = path.join(tempDir, fileName);
  const content = "Confidential report content";
  fs.writeFileSync(sourceFile, content, "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourcePath: fileName,
      destinationDir: "documents/archive",
      recommendationId: "rec_archive",
      rationale: "Archive older reports"
    })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.operationId.startsWith("op_"));
  assert.ok(typeof body.data.approvalToken === "string" && body.data.approvalToken.length > 20);
  assert.equal(body.data.sourcePath, fileName);
  assert.equal(body.data.destinationPath, "documents/archive/report.pdf");
  assert.equal(body.data.destinationDir, "documents/archive");
  assert.equal(body.data.conflict, false);
  assert.equal(body.data.canExecute, true);
  assert.equal(body.data.recommendationId, "rec_archive");

  // Verify preview is strictly read-only: source still exists at original path, destination does NOT exist
  assert.equal(fs.existsSync(sourceFile), true);
  assert.equal(fs.readFileSync(sourceFile, "utf8"), content);
  assert.equal(fs.existsSync(path.join(tempDir, "documents/archive/report.pdf")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "documents/archive")), false);
});

test("POST /api/organization/preview flags conflict when destination already exists", async (t) => {
  const tempDir = createTempDir("filo-org-conflict-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.mkdirSync(path.join(tempDir, "documents"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "source.txt"), "source data", "utf8");
  fs.writeFileSync(path.join(tempDir, "documents", "source.txt"), "existing file", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourcePath: "source.txt",
      destinationDir: "documents"
    })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.conflict, true);
  assert.equal(body.data.canExecute, false);
  assert.ok(body.data.conflictReason.includes("already exists"));
});

test("POST /api/organization/execute moves file with valid approval token and updates history", async (t) => {
  const tempDir = createTempDir("filo-org-exec-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const fileName = "data.csv";
  const sourcePath = path.join(tempDir, fileName);
  fs.writeFileSync(sourcePath, "a,b,c\n1,2,3", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  // 1. Preview
  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourcePath: fileName,
      destinationDir: "tables"
    })
  });
  const previewBody = await previewRes.json();
  assert.equal(previewBody.success, true);

  const { operationId, approvalToken } = previewBody.data;

  // 2. Execute
  const execRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId,
      approvalToken
    })
  });
  const execBody = await execRes.json();

  assert.equal(execRes.status, 200);
  assert.equal(execBody.success, true);
  assert.equal(execBody.data.status, "completed");
  assert.equal(execBody.data.sourcePath, fileName);
  assert.equal(execBody.data.destinationPath, "tables/data.csv");
  assert.equal(execBody.data.undoAvailable, true);

  // 3. Verify filesystem changes
  const destPath = path.join(tempDir, "tables", "data.csv");
  assert.equal(fs.existsSync(sourcePath), false, "Source file should have been moved");
  assert.equal(fs.existsSync(destPath), true, "File must exist at destination");
  assert.equal(fs.readFileSync(destPath, "utf8"), "a,b,c\n1,2,3");

  // 4. Verify history endpoint
  const historyRes = await fetch(`${baseUrl}/api/organization/history`);
  const historyBody = await historyRes.json();
  assert.equal(historyBody.success, true);
  const entry = historyBody.data.history.find((h) => h.operationId === operationId);
  assert.ok(entry, "Completed move must be recorded in history");
  assert.equal(entry.status, "completed");
  assert.equal(entry.approvalToken, undefined, "Approval token must not be exposed in history");
});

test("POST /api/organization/execute rejects invalid or altered approval token", async (t) => {
  const tempDir = createTempDir("filo-org-badtoken-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "notes.txt"), "notes", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourcePath: "notes.txt",
      destinationDir: "backup"
    })
  });
  const previewBody = await previewRes.json();
  const { operationId } = previewBody.data;

  // Attempt execution with an incorrect/altered approval token
  const execRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId,
      approvalToken: "forged_invalid_token_12345"
    })
  });
  const execBody = await execRes.json();

  assert.equal(execRes.status, 403);
  assert.equal(execBody.success, false);
  assert.equal(execBody.error.code, "INVALID_APPROVAL_TOKEN");

  // Confirm file was NOT moved
  assert.equal(fs.existsSync(path.join(tempDir, "notes.txt")), true);
});

test("POST /api/organization/execute rejects re-execution of completed operation", async (t) => {
  const tempDir = createTempDir("filo-org-reexec-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "sample.txt"), "content", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "sample.txt", destinationDir: "target" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  // First execution succeeds
  const firstExec = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  assert.equal(firstExec.status, 200);

  // Second execution with same token must be rejected
  const secondExec = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  const secondBody = await secondExec.json();

  assert.equal(secondExec.status, 409);
  assert.equal(secondBody.success, false);
  assert.equal(secondBody.error.code, "INVALID_OPERATION_STATE");
});

test("POST /api/organization/execute rejects if destination file appeared after preview (never overwrites)", async (t) => {
  const tempDir = createTempDir("filo-org-race-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "race.txt"), "original source", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  // Preview when destination does not exist
  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "race.txt", destinationDir: "sub" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  // Intervening step: Create destination file before execute is called
  fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "sub", "race.txt"), "intervening file", "utf8");

  // Attempt execute: MUST reject to prevent overwrite
  const execRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  const execBody = await execRes.json();

  assert.equal(execRes.status, 409);
  assert.equal(execBody.success, false);
  assert.equal(execBody.error.code, "DESTINATION_CONFLICT");

  // Verify intervening file was NOT overwritten
  assert.equal(fs.readFileSync(path.join(tempDir, "sub", "race.txt"), "utf8"), "intervening file");
});

test("POST /api/organization/undo safely restores moved file and rejects if original source occupied", async (t) => {
  const tempDir = createTempDir("filo-org-undo-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const content = "Unique payload to restore";
  fs.writeFileSync(path.join(tempDir, "original.txt"), content, "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  // 1. Preview and Execute
  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "original.txt", destinationDir: "moved" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  const execRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  assert.equal(execRes.status, 200);
  assert.equal(fs.existsSync(path.join(tempDir, "moved", "original.txt")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "original.txt")), false);

  // 2. Undo operation
  const undoRes = await fetch(`${baseUrl}/api/organization/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId })
  });
  const undoBody = await undoRes.json();

  assert.equal(undoRes.status, 200);
  assert.equal(undoBody.success, true);
  assert.equal(undoBody.data.status, "undone");

  // Verify file restored to original location
  assert.equal(fs.existsSync(path.join(tempDir, "original.txt")), true);
  assert.equal(fs.readFileSync(path.join(tempDir, "original.txt"), "utf8"), content);
  assert.equal(fs.existsSync(path.join(tempDir, "moved", "original.txt")), false);

  // 3. Undo again should fail
  const repeatUndo = await fetch(`${baseUrl}/api/organization/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId })
  });
  assert.equal(repeatUndo.status, 400);
});

test("POST /api/organization/undo rejects if file already exists at original location", async (t) => {
  const tempDir = createTempDir("filo-org-undoconflict-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "file.txt"), "initial", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "file.txt", destinationDir: "sub" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });

  // Intervening step: Place a new file at original location before undo
  fs.writeFileSync(path.join(tempDir, "file.txt"), "new file blocking undo", "utf8");

  // Undo must reject to prevent overwriting the new file
  const undoRes = await fetch(`${baseUrl}/api/organization/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId })
  });
  const undoBody = await undoRes.json();

  assert.equal(undoRes.status, 409);
  assert.equal(undoBody.success, false);
  assert.equal(undoBody.error.code, "SOURCE_RESTORE_CONFLICT");
  assert.equal(fs.readFileSync(path.join(tempDir, "file.txt"), "utf8"), "new file blocking undo");
});

test("POST /api/organization/preview rejects path traversal and absolute paths outside root", async (t) => {
  const tempDir = createTempDir("filo-org-traversal-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "safe.txt"), "safe", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  // Traversal in source
  const res1 = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "../../../etc/passwd", destinationDir: "sub" })
  });
  assert.equal(res1.status, 403);
  assert.equal((await res1.json()).error.code, "OUTSIDE_APPROVED_ROOT");

  // Traversal in destinationDir
  const res2 = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "safe.txt", destinationDir: "../../outside" })
  });
  assert.equal(res2.status, 403);
  assert.equal((await res2.json()).error.code, "OUTSIDE_APPROVED_ROOT");

  // Null byte in source
  const res3 = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "safe.txt\0evil", destinationDir: "sub" })
  });
  assert.equal(res3.status, 400);
  assert.equal((await res3.json()).error.code, "PATH_TRAVERSAL_DETECTED");
});

test("POST /api/organization/preview rejects identical source and destination", async (t) => {
  const tempDir = createTempDir("filo-org-same-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "docs", "file.txt"), "content", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const res = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "docs/file.txt", destinationDir: "docs" })
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.code, "SAME_FILE_OPERATION");
});

test("POST /api/organization/execute rejects missing or expired approval token", async (t) => {
  const tempDir = createTempDir("filo-org-expiry-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "expire.txt"), "will expire", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  // Missing approval token
  const missingTokenRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "op_fake123" })
  });
  assert.equal(missingTokenRes.status, 400);
  assert.equal((await missingTokenRes.json()).error.code, "INVALID_APPROVAL_TOKEN");

  // Expired token test via service helper
  const previewRes = await previewOperation(
    { sourcePath: "expire.txt", destinationDir: "sub" },
    { approvedRoot: tempDir, expiresInMs: -1000 }
  );
  assert.equal(previewRes.success, true);

  const expiredExec = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: previewRes.data.operationId,
      approvalToken: previewRes.data.approvalToken
    })
  });
  const expiredBody = await expiredExec.json();
  assert.equal(expiredExec.status, 410);
  assert.equal(expiredBody.error.code, "APPROVAL_EXPIRED");
});

test("POST /api/organization/execute rejects if source file was modified or deleted after preview", async (t) => {
  const tempDir = createTempDir("filo-org-tamper-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "tamper.txt"), "original size", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "tamper.txt", destinationDir: "archive" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  // Intervening step: Modify source file size
  fs.writeFileSync(path.join(tempDir, "tamper.txt"), "modified content that has a longer size now", "utf8");

  const execRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  const execBody = await execRes.json();

  assert.equal(execRes.status, 409);
  assert.equal(execBody.error.code, "SOURCE_MODIFIED");
});

test("POST /api/organization/preview rejects symlink source files", async (t) => {
  const tempDir = createTempDir("filo-org-symlink-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const targetFile = path.join(tempDir, "target.txt");
  fs.writeFileSync(targetFile, "target content", "utf8");
  const symlinkFile = path.join(tempDir, "link.txt");

  let canCreateSymlink = true;
  try {
    fs.symlinkSync(targetFile, symlinkFile);
  } catch {
    canCreateSymlink = false;
  }

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  if (canCreateSymlink) {
    const res = await fetch(`${baseUrl}/api/organization/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePath: "link.txt", destinationDir: "sub" })
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, "SYMLINK_NOT_ALLOWED");
  }
});

test("POST /api/organization/execute rejects duplicate concurrent execution requests", async (t) => {
  const tempDir = createTempDir("filo-org-concurrent-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "concurrent.txt"), "race test data", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "concurrent.txt", destinationDir: "target" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  // Fire two execution requests concurrently
  const [res1, res2] = await Promise.all([
    fetch(`${baseUrl}/api/organization/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId, approvalToken })
    }),
    fetch(`${baseUrl}/api/organization/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId, approvalToken })
    })
  ]);

  const statuses = [res1.status, res2.status].sort();
  // Exactly one request must succeed (200), and the second must be rejected (409)
  assert.equal(statuses[0], 200, "One request must succeed");
  assert.equal(statuses[1], 409, "Second concurrent request must be rejected with 409 conflict");

  // Verify file was moved exactly once and exists at destination
  assert.equal(fs.existsSync(path.join(tempDir, "target", "concurrent.txt")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "concurrent.txt")), false);
});

test("executeOperation simulates cross-device fallback with verified copy and source unlink", async (t) => {
  const tempDir = createTempDir("filo-org-exdev-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const content = "Cross-device payload content";
  fs.writeFileSync(path.join(tempDir, "crossdev.txt"), content, "utf8");

  const journalPath = path.join(tempDir, "exdev-journal.jsonl");

  t.after(() => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
  });

  const previewResult = await previewOperation(
    { sourcePath: "crossdev.txt", destinationDir: "cross-target" },
    { approvedRoot: tempDir }
  );
  assert.equal(previewResult.success, true);
  const { operationId, approvalToken } = previewResult.data;

  // Temporarily monkey-patch fs.promises.rename to simulate EXDEV
  const originalRename = fs.promises.rename;
  let renameCalled = false;
  fs.promises.rename = async () => {
    renameCalled = true;
    const err = new Error("Cross-device link");
    err.code = "EXDEV";
    throw err;
  };

  try {
    const execResult = await executeOperation(
      { operationId, approvalToken },
      { approvedRoot: tempDir, journalPath }
    );

    assert.equal(execResult.success, true);
    assert.equal(execResult.data.status, "completed");
    assert.equal(renameCalled, true, "Rename was called and threw EXDEV");

    // Verify file moved to destination and unlinked from source
    const destPath = path.join(tempDir, "cross-target", "crossdev.txt");
    assert.equal(fs.existsSync(destPath), true);
    assert.equal(fs.readFileSync(destPath, "utf8"), content);
    assert.equal(fs.existsSync(path.join(tempDir, "crossdev.txt")), false);
  } finally {
    fs.promises.rename = originalRename;
  }
});

test("executeOperation preserves source and cleans destination if cross-device copy fails", async (t) => {
  const tempDir = createTempDir("filo-org-copyfail-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const content = "Preserve source content";
  fs.writeFileSync(path.join(tempDir, "preserve.txt"), content, "utf8");

  const journalPath = path.join(tempDir, "copyfail-journal.jsonl");

  t.after(() => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
  });

  const previewResult = await previewOperation(
    { sourcePath: "preserve.txt", destinationDir: "fail-target" },
    { approvedRoot: tempDir }
  );
  const { operationId, approvalToken } = previewResult.data;

  const originalRename = fs.promises.rename;
  const originalCopyFile = fs.promises.copyFile;

  fs.promises.rename = async () => {
    const err = new Error("Cross-device link");
    err.code = "EXDEV";
    throw err;
  };
  fs.promises.copyFile = async () => {
    throw new Error("Simulated disk error during copy");
  };

  try {
    const execResult = await executeOperation(
      { operationId, approvalToken },
      { approvedRoot: tempDir, journalPath }
    );

    assert.equal(execResult.success, false);
    assert.equal(execResult.status, 500);
    assert.equal(execResult.error.code, "COPY_FAILED");

    // CRITICAL: Source file MUST remain intact!
    assert.equal(fs.existsSync(path.join(tempDir, "preserve.txt")), true);
    assert.equal(fs.readFileSync(path.join(tempDir, "preserve.txt"), "utf8"), content);
    // Destination file must NOT exist
    assert.equal(fs.existsSync(path.join(tempDir, "fail-target", "preserve.txt")), false);
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.copyFile = originalCopyFile;
  }
});

test("executeOperation flags recovery_required if source unlink fails after cross-device copy", async (t) => {
  const tempDir = createTempDir("filo-org-unlinkfail-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const content = "Both files will exist";
  fs.writeFileSync(path.join(tempDir, "both.txt"), content, "utf8");

  const journalPath = path.join(tempDir, "unlinkfail-journal.jsonl");

  t.after(() => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
  });

  const previewResult = await previewOperation(
    { sourcePath: "both.txt", destinationDir: "target" },
    { approvedRoot: tempDir }
  );
  const { operationId, approvalToken } = previewResult.data;

  const originalRename = fs.promises.rename;
  const originalUnlink = fs.promises.unlink;

  fs.promises.rename = async () => {
    const err = new Error("Cross-device link");
    err.code = "EXDEV";
    throw err;
  };
  fs.promises.unlink = async () => {
    throw new Error("Simulated permission error on source unlink");
  };

  try {
    const execResult = await executeOperation(
      { operationId, approvalToken },
      { approvedRoot: tempDir, journalPath }
    );

    assert.equal(execResult.success, false);
    assert.equal(execResult.status, 500);
    assert.equal(execResult.error.code, "RECOVERY_REQUIRED");

    // Both files exist on disk
    assert.equal(fs.existsSync(path.join(tempDir, "both.txt")), true);
    assert.equal(fs.existsSync(path.join(tempDir, "target", "both.txt")), true);
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.unlink = originalUnlink;
  }
});

test("POST /api/organization/undo rejects when destination file was modified after move", async (t) => {
  const tempDir = createTempDir("filo-org-undotamper-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "mod.txt"), "initial content", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath: "mod.txt", destinationDir: "moved" })
  });
  const { operationId, approvalToken } = (await previewRes.json()).data;

  await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });

  // Tamper: Modify destination file (e.g. user edited it)
  const destPath = path.join(tempDir, "moved", "mod.txt");
  fs.writeFileSync(destPath, "tampered and edited destination file with longer size", "utf8");

  const undoRes = await fetch(`${baseUrl}/api/organization/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId })
  });
  const undoBody = await undoRes.json();

  assert.equal(undoRes.status, 409);
  assert.equal(undoBody.error.code, "DESTINATION_FILE_MODIFIED");

  // Tampered file is preserved at destination and NOT deleted
  assert.equal(fs.existsSync(destPath), true);
  assert.equal(fs.existsSync(path.join(tempDir, "mod.txt")), false);
});

test("loadAndRecoverJournal detects interrupted operation on startup without modifying files", async (t) => {
  const tempDir = createTempDir("filo-org-startup-");
  const journalPath = path.join(tempDir, "recovery-journal.jsonl");

  // File exists at source
  const sourceFile = path.join(tempDir, "interrupted.txt");
  fs.writeFileSync(sourceFile, "important data", "utf8");

  t.after(() => removeDirRecursive(tempDir));

  // Simulate an interrupted operation journaled as 'executing' right before a crash
  await appendJournalEntry({
    operationId: "op_interrupted123",
    status: "executing",
    sourcePath: "interrupted.txt",
    destinationPath: "target/interrupted.txt",
    destinationDir: "target",
    fileName: "interrupted.txt",
    sizeBytes: 14
  }, { journalPath });

  const result = await loadAndRecoverJournal({
    canonicalRoot: tempDir,
    journalPath
  });

  assert.equal(result.recoveryRequiredCount, 1);
  const op = result.operations.get("op_interrupted123");
  assert.ok(op);
  assert.equal(op.status, "recovery_required");
  assert.ok(op.recoveryReason.includes("Interrupted before move"));

  // CRITICAL: Startup recovery must NOT move, delete, or modify files
  assert.equal(fs.existsSync(sourceFile), true);
  assert.equal(fs.readFileSync(sourceFile, "utf8"), "important data");
  assert.equal(fs.existsSync(path.join(tempDir, "target", "interrupted.txt")), false);
});

test("readJournalEntries safely skips corrupted and malformed lines", async (t) => {
  const tempDir = createTempDir("filo-org-corrupt-");
  const journalPath = path.join(tempDir, "corrupted.jsonl");

  t.after(() => removeDirRecursive(tempDir));

  const validEntry = {
    operationId: "op_valid1",
    status: "completed",
    sourcePath: "file1.txt",
    destinationPath: "sub/file1.txt",
    destinationDir: "sub",
    fileName: "file1.txt"
  };

  const lines = [
    JSON.stringify(validEntry),
    "{ broken json syntax line",
    "", // blank line
    "123456", // valid json but not an object matching schema
    JSON.stringify({ ...validEntry, operationId: "op_valid2" })
  ];

  fs.writeFileSync(journalPath, lines.join("\n"), "utf8");

  const result = await readJournalEntries({ journalPath });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].operationId, "op_valid1");
  assert.equal(result.entries[1].operationId, "op_valid2");
  assert.equal(result.corruptedLinesCount, 2);
});

test("recovery journal persists completed operations across service restarts", async (t) => {
  const tempDir = createTempDir("filo-org-restart-");
  const journalPath = path.join(tempDir, "persist-journal.jsonl");

  fs.writeFileSync(path.join(tempDir, "restart.txt"), "restart test", "utf8");

  t.after(() => {
    resetServiceState();
    removeDirRecursive(tempDir);
  });

  resetServiceState();

  const previewRes = await previewOperation(
    { sourcePath: "restart.txt", destinationDir: "saved" },
    { approvedRoot: tempDir }
  );
  const { operationId, approvalToken } = previewRes.data;

  const execRes = await executeOperation(
    { operationId, approvalToken },
    { approvedRoot: tempDir, journalPath }
  );
  assert.equal(execRes.success, true);

  // Simulate server restart: wipe memory
  resetServiceState();
  assert.equal(getOperationHistory().history.length, 0);

  // Re-initialize from persistent journal
  await initOrganizationService({ approvedRoot: tempDir, journalPath });

  const historyData = getOperationHistory();
  assert.equal(historyData.history.length, 1);
  assert.equal(historyData.history[0].operationId, operationId);
  assert.equal(historyData.history[0].status, "completed");
  assert.equal(historyData.history[0].sourcePath, "restart.txt");
  assert.equal(historyData.history[0].destinationPath, "saved/restart.txt");
});

test("POST /api/organization/recover allows user to review and resolve recovery_required operation", async (t) => {
  const tempDir = createTempDir("filo-org-recoverroute-");
  const journalPath = path.join(tempDir, "recover-journal.jsonl");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  const originalJournalPath = process.env.FILO_JOURNAL_PATH;

  process.env.FILO_SCAN_ROOT = tempDir;
  process.env.FILO_JOURNAL_PATH = journalPath;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.FILO_JOURNAL_PATH = originalJournalPath;
    resetServiceState();
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  resetServiceState();

  // Create an interrupted journal record
  await appendJournalEntry({
    operationId: "op_rec_review",
    status: "executing",
    sourcePath: "data.csv",
    destinationPath: "archive/data.csv",
    destinationDir: "archive",
    fileName: "data.csv",
    sizeBytes: 100
  }, { journalPath });

  // Init to detect and mark recovery_required
  await initOrganizationService({ approvedRoot: tempDir, journalPath });

  // History should reflect recovery_required
  const historyRes = await fetch(`${baseUrl}/api/organization/history`);
  const historyBody = await historyRes.json();
  assert.equal(historyBody.data.recoveryRequiredCount, 1);

  // Recover endpoint: dismiss recovery warning
  const recoverRes = await fetch(`${baseUrl}/api/organization/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "op_rec_review", resolution: "dismiss" })
  });
  const recoverBody = await recoverRes.json();

  assert.equal(recoverRes.status, 200);
  assert.equal(recoverBody.success, true);
  assert.equal(recoverBody.data.status, "failed");

  // History should now have 0 recoveryRequiredCount
  const afterHistory = await (await fetch(`${baseUrl}/api/organization/history`)).json();
  assert.equal(afterHistory.data.recoveryRequiredCount, 0);
});

test("executeOperation flags recovery_required when journal write fails after file move", async (t) => {
  const tempDir = createTempDir("filo-org-jfail-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const content = "Journal failure test data";
  fs.writeFileSync(path.join(tempDir, "jfail.txt"), content, "utf8");

  const journalPath = path.join(tempDir, "jfail-journal.jsonl");

  t.after(() => {
    resetServiceState();
    removeDirRecursive(tempDir);
  });

  const previewRes = await previewOperation(
    { sourcePath: "jfail.txt", destinationDir: "moved" },
    { approvedRoot: tempDir }
  );
  const { operationId, approvalToken } = previewRes.data;

  // Intercept appendJournalEntry on recoveryJournal
  const recoveryJournal = require("../backend/services/recoveryJournal");
  const originalAppend = recoveryJournal.appendJournalEntry;
  let calls = 0;
  recoveryJournal.appendJournalEntry = async (entry, opts) => {
    calls++;
    if (calls === 2) {
      // First call is 'executing', second call is 'completed' after move
      throw new Error("Simulated I/O failure writing completed status to journal");
    }
    return originalAppend(entry, opts);
  };

  try {
    const execRes = await executeOperation(
      { operationId, approvalToken },
      { approvedRoot: tempDir, journalPath }
    );

    assert.equal(execRes.success, false);
    assert.equal(execRes.status, 500);
    assert.equal(execRes.error.code, "JOURNAL_WRITE_FAILED");

    // File was moved to destination
    assert.equal(fs.existsSync(path.join(tempDir, "moved", "jfail.txt")), true);
    assert.equal(fs.existsSync(path.join(tempDir, "jfail.txt")), false);

    // Operation is flagged as recovery_required
    const historyData = getOperationHistory();
    const item = historyData.history.find((h) => h.operationId === operationId);
    assert.ok(item);
    assert.equal(item.status, "recovery_required");
    assert.ok(item.recoveryReason.includes("journal write failed"));
  } finally {
    recoveryJournal.appendJournalEntry = originalAppend;
  }
});
