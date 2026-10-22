const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const app = require("../backend/app");
const {
  initOrganizationService,
  resetServiceState
} = require("../backend/services/organizationService");
const {
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

function createTempDir(prefix = "filo-e2e-") {
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

test("E2E: Full decluttering lifecycle (health, scan, duplicates, preview, execute, history, undo)", async (t) => {
  const tempDir = createTempDir("filo-e2e-full-");
  const journalPath = path.join(tempDir, "e2e-journal.jsonl");

  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  const originalJournalPath = process.env.FILO_JOURNAL_PATH;
  process.env.FILO_SCAN_ROOT = tempDir;
  process.env.FILO_JOURNAL_PATH = journalPath;

  // Setup sample folder structure inside approved root
  fs.mkdirSync(path.join(tempDir, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "archive"), { recursive: true });

  const invoiceContent = "INVOICE #1042 - FILOAI SERVICES - 2026";
  const duplicateContent = "PROJECT SCOPE DRAFT - IDENTICAL CONTENT";

  fs.writeFileSync(path.join(tempDir, "inbox", "invoice.pdf"), invoiceContent, "utf8");
  fs.writeFileSync(path.join(tempDir, "inbox", "draft1.txt"), duplicateContent, "utf8");
  fs.writeFileSync(path.join(tempDir, "archive", "draft2_copy.txt"), duplicateContent, "utf8");

  const { server, baseUrl } = await startTestServer();
  resetServiceState();

  t.after(async () => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.FILO_JOURNAL_PATH = originalJournalPath;
    await new Promise((resolve) => server.close(resolve));
    removeDirRecursive(tempDir);
    resetServiceState();
  });

  // 1. GET /api/health
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthBody = await healthRes.json();
  assert.equal(healthBody.success, true);
  assert.equal(healthBody.message, "filoAI backend is running");

  // 2. GET /api/scan/config
  const configRes = await fetch(`${baseUrl}/api/scan/config`);
  assert.equal(configRes.status, 200);
  const configBody = await configRes.json();
  assert.equal(configBody.success, true);
  assert.ok(configBody.data.approvedRootDisplay);
  assert.equal(configBody.data.readOnly, true);

  // 3. POST /api/scan (read-only directory scan)
  const scanRes = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });
  assert.equal(scanRes.status, 200);
  const scanBody = await scanRes.json();
  assert.equal(scanBody.success, true);
  assert.equal(scanBody.data.files.length, 3);
  assert.equal(scanBody.data.summary.totalFiles, 3);
  assert.equal(scanBody.data.summary.totalDirectories >= 2, true);

  // 4. POST /api/duplicates (SHA-256 duplicate detection)
  const dupRes = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });
  assert.equal(dupRes.status, 200);
  const dupBody = await dupRes.json();
  assert.equal(dupBody.success, true);
  assert.equal(dupBody.data.duplicateGroups.length, 1);
  const dupGroup = dupBody.data.duplicateGroups[0];
  assert.equal(dupGroup.count, 2);
  assert.equal(dupGroup.redundantCopies, 1);
  assert.equal(dupGroup.reclaimableBytes, Buffer.byteLength(duplicateContent, "utf8"));
  assert.equal(dupGroup.files[0].isPrimaryCandidate, true);

  // 5. GET /api/recommendations/status
  const recStatusRes = await fetch(`${baseUrl}/api/recommendations/status`);
  assert.equal(recStatusRes.status, 200);
  const recStatusBody = await recStatusRes.json();
  assert.equal(recStatusBody.success, true);
  assert.equal(typeof recStatusBody.data.available, "boolean");

  // 6. POST /api/organization/preview (safe preview without altering files)
  const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourcePath: "inbox/invoice.pdf",
      destinationDir: "documents/finance"
    })
  });
  assert.equal(previewRes.status, 200);
  const previewBody = await previewRes.json();
  assert.equal(previewBody.success, true);
  assert.equal(previewBody.data.sourcePath, "inbox/invoice.pdf");
  assert.equal(previewBody.data.destinationPath, "documents/finance/invoice.pdf");
  assert.equal(previewBody.data.conflict, false);
  assert.equal(previewBody.data.canExecute, true);
  assert.ok(previewBody.data.operationId);
  assert.ok(previewBody.data.approvalToken);

  const { operationId, approvalToken } = previewBody.data;

  // File is not moved during preview
  assert.equal(fs.existsSync(path.join(tempDir, "inbox", "invoice.pdf")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "documents", "finance", "invoice.pdf")), false);

  // 7. POST /api/organization/execute (user-approved execution)
  const execRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  assert.equal(execRes.status, 200);
  const execBody = await execRes.json();
  assert.equal(execBody.success, true);
  assert.equal(execBody.data.status, "completed");
  assert.equal(execBody.data.undoAvailable, true);

  // Verify file has moved on disk
  assert.equal(fs.existsSync(path.join(tempDir, "inbox", "invoice.pdf")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "documents", "finance", "invoice.pdf")), true);
  assert.equal(fs.readFileSync(path.join(tempDir, "documents", "finance", "invoice.pdf"), "utf8"), invoiceContent);

  // 8. GET /api/organization/history (verify completed operation)
  const historyRes = await fetch(`${baseUrl}/api/organization/history`);
  assert.equal(historyRes.status, 200);
  const historyBody = await historyRes.json();
  assert.equal(historyBody.success, true);
  assert.equal(historyBody.data.history.length, 1);
  assert.equal(historyBody.data.history[0].operationId, operationId);
  assert.equal(historyBody.data.history[0].status, "completed");
  assert.equal(historyBody.data.recoveryRequiredCount, 0);

  // 9. Replay prevention: executing the same approval token must be rejected
  const replayRes = await fetch(`${baseUrl}/api/organization/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, approvalToken })
  });
  assert.equal(replayRes.status, 409);
  const replayBody = await replayRes.json();
  assert.equal(replayBody.error.code, "INVALID_OPERATION_STATE");

  // 10. POST /api/organization/undo (safely restores file to original path)
  const undoRes = await fetch(`${baseUrl}/api/organization/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId })
  });
  assert.equal(undoRes.status, 200);
  const undoBody = await undoRes.json();
  assert.equal(undoBody.success, true);
  assert.equal(undoBody.data.status, "undone");

  // Verify file returned to original location
  assert.equal(fs.existsSync(path.join(tempDir, "inbox", "invoice.pdf")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "documents", "finance", "invoice.pdf")), false);
  assert.equal(fs.readFileSync(path.join(tempDir, "inbox", "invoice.pdf"), "utf8"), invoiceContent);

  // Verify undo history update
  const postUndoHistoryRes = await fetch(`${baseUrl}/api/organization/history`);
  const postUndoHistoryBody = await postUndoHistoryRes.json();
  assert.equal(postUndoHistoryBody.data.history[0].status, "undone");
  assert.equal(postUndoHistoryBody.data.history[0].undoAvailable, false);
});

test("E2E: Startup crash recovery audits interrupted operation without modifying files", async (t) => {
  const tempDir = createTempDir("filo-e2e-crash-");
  const journalPath = path.join(tempDir, "crash-journal.jsonl");

  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  const originalJournalPath = process.env.FILO_JOURNAL_PATH;
  process.env.FILO_SCAN_ROOT = tempDir;
  process.env.FILO_JOURNAL_PATH = journalPath;

  // Create an intact source file on disk
  const content = "CRITICAL FINANCIAL RECORD - DO NOT TOUCH AUTOMATICALLY";
  fs.writeFileSync(path.join(tempDir, "unmoved.csv"), content, "utf8");

  // Simulate an interrupted operation recorded in journal as 'executing'
  const interruptedOpId = "op_interrupted_test_123";
  await appendJournalEntry({
    operationId: interruptedOpId,
    status: "executing",
    sourcePath: "unmoved.csv",
    destinationPath: "organized/unmoved.csv",
    destinationDir: "organized",
    fileName: "unmoved.csv",
    sizeBytes: Buffer.byteLength(content, "utf8")
  }, { journalPath });

  const { server, baseUrl } = await startTestServer();

  t.after(async () => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    process.env.FILO_JOURNAL_PATH = originalJournalPath;
    await new Promise((resolve) => server.close(resolve));
    removeDirRecursive(tempDir);
    resetServiceState();
  });

  // Trigger startup recovery audit
  const startupMetrics = await initOrganizationService({
    approvedRoot: tempDir,
    journalPath
  });

  assert.equal(startupMetrics.recoveryRequiredCount, 1);

  // ABSOLUTE SAFETY GUARANTEE: Startup recovery must NEVER modify, move, or delete files on disk
  assert.equal(fs.existsSync(path.join(tempDir, "unmoved.csv")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "organized", "unmoved.csv")), false);
  assert.equal(fs.readFileSync(path.join(tempDir, "unmoved.csv"), "utf8"), content);

  // History endpoint exposes recovery_required status and recovery reason
  const historyRes = await fetch(`${baseUrl}/api/organization/history`);
  assert.equal(historyRes.status, 200);
  const historyBody = await historyRes.json();
  assert.equal(historyBody.data.recoveryRequiredCount, 1);
  const recItem = historyBody.data.history.find((h) => h.operationId === interruptedOpId);
  assert.ok(recItem);
  assert.equal(recItem.status, "recovery_required");
  assert.ok(recItem.recoveryReason.includes("Interrupted before move: Source file is intact"));

  // Explicit user resolution of recovery warning
  const recoverRes = await fetch(`${baseUrl}/api/organization/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: interruptedOpId,
      resolution: "dismiss"
    })
  });

  assert.equal(recoverRes.status, 200);
  const recoverBody = await recoverRes.json();
  assert.equal(recoverBody.success, true);
  assert.equal(recoverBody.data.status, "failed");
  assert.equal(recoverBody.data.resolution, "dismissed");

  // Post-recovery history has 0 recovery required items
  const postRecoverRes = await fetch(`${baseUrl}/api/organization/history`);
  const postRecoverBody = await postRecoverRes.json();
  assert.equal(postRecoverBody.data.recoveryRequiredCount, 0);

  // File on disk remains intact and untouched
  assert.equal(fs.existsSync(path.join(tempDir, "unmoved.csv")), true);
  assert.equal(fs.readFileSync(path.join(tempDir, "unmoved.csv"), "utf8"), content);
});

test("E2E: Path traversal and security containment across all API endpoints", async (t) => {
  const tempDir = createTempDir("filo-e2e-security-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();
  resetServiceState();

  t.after(async () => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    await new Promise((resolve) => server.close(resolve));
    removeDirRecursive(tempDir);
    resetServiceState();
  });

  const attackPayloads = [
    "../secret.txt",
    "..\\..\\Windows\\System32",
    "subfolder/../../../etc/passwd"
  ];

  for (const maliciousPath of attackPayloads) {
    // Scan endpoint rejection
    const scanRes = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: maliciousPath })
    });
    assert.equal(scanRes.status, 403);
    const scanBody = await scanRes.json();
    assert.equal(scanBody.error.code, "OUTSIDE_APPROVED_ROOT");

    // Duplicates endpoint rejection
    const dupRes = await fetch(`${baseUrl}/api/duplicates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: maliciousPath })
    });
    assert.equal(dupRes.status, 403);
    const dupBody = await dupRes.json();
    assert.equal(dupBody.error.code, "OUTSIDE_APPROVED_ROOT");

    // Recommendations endpoint rejection
    const recRes = await fetch(`${baseUrl}/api/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: maliciousPath })
    });
    assert.equal(recRes.status, 403);
    const recBody = await recRes.json();
    assert.equal(recBody.error.code, "OUTSIDE_APPROVED_ROOT");

    // Organization preview endpoint rejection
    const previewRes = await fetch(`${baseUrl}/api/organization/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePath: maliciousPath, destinationDir: "target" })
    });
    assert.equal(previewRes.status, 403);
    const previewBody = await previewRes.json();
    assert.equal(previewBody.error.code, "OUTSIDE_APPROVED_ROOT");
  }
});
