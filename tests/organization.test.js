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
  getOperationHistory
} = require("../backend/services/organizationService");

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

