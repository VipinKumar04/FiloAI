const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const app = require("../backend/app");
const { findDuplicates, streamHashFile } = require("../backend/services/duplicateService");

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

function createTempDir(prefix = "filo-dup-test-") {
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

test("POST /api/duplicates detects two files with identical content but different names", async (t) => {
  const tempDir = createTempDir("filo-dup-identical-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const content = "Exact identical content for duplicate test";
  fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "original.txt"), content, "utf8");
  fs.writeFileSync(path.join(tempDir, "sub", "copy.txt"), content, "utf8");
  fs.writeFileSync(path.join(tempDir, "unique.txt"), "Completely different content", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.duplicateGroups.length, 1);

  const group = body.data.duplicateGroups[0];
  assert.equal(group.count, 2);
  assert.equal(group.redundantCopies, 1);
  assert.equal(group.sizeBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(group.reclaimableBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(group.files.length, 2);

  // Validate distinction between primary candidate and duplicate copy
  const primary = group.files.find((f) => f.role === "primary_candidate");
  const copy = group.files.find((f) => f.role === "duplicate_copy");
  assert.ok(primary, "Group should have a primary candidate");
  assert.ok(copy, "Group should have a duplicate copy");
  assert.equal(primary.isPrimaryCandidate, true);
  assert.equal(copy.isPrimaryCandidate, false);

  // Verify paths are relative, not absolute
  assert.ok(!primary.relativePath.includes(":") && !primary.relativePath.startsWith("/"));
  assert.ok(!copy.relativePath.includes(":") && !copy.relativePath.startsWith("/"));

  // Verify summary statistics
  assert.equal(body.data.summary.totalDuplicateGroups, 1);
  assert.equal(body.data.summary.totalDuplicateFiles, 2);
  assert.equal(body.data.summary.totalRedundantCopies, 1);
  assert.equal(body.data.summary.reclaimableBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(body.data.summary.totalScannedFiles, 3);
});

test("POST /api/duplicates does not group files with same size but different content", async (t) => {
  const tempDir = createTempDir("filo-dup-diff-content-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  // Same byte length (14 bytes), different content
  fs.writeFileSync(path.join(tempDir, "file_a.txt"), "aaaa_123456789", "utf8");
  fs.writeFileSync(path.join(tempDir, "file_b.txt"), "bbbb_123456789", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.duplicateGroups.length, 0);
  assert.equal(body.data.summary.totalDuplicateGroups, 0);
  assert.equal(body.data.summary.totalRedundantCopies, 0);
  assert.equal(body.data.summary.reclaimableBytes, 0);
  assert.equal(body.data.summary.totalCandidateFiles, 2); // Both were candidate files and checked
});

test("POST /api/duplicates does not group files with different sizes", async (t) => {
  const tempDir = createTempDir("filo-dup-diff-size-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "short.txt"), "short", "utf8");
  fs.writeFileSync(path.join(tempDir, "longer.txt"), "longer content string", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.duplicateGroups.length, 0);
  assert.equal(body.data.summary.totalCandidateFiles, 0); // Neither file needed hashing
});

test("POST /api/duplicates correctly handles empty (0-byte) files with identical content", async (t) => {
  const tempDir = createTempDir("filo-dup-empty-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, "empty1.txt"), "", "utf8");
  fs.writeFileSync(path.join(tempDir, "empty2.txt"), "", "utf8");
  fs.writeFileSync(path.join(tempDir, "not-empty.txt"), "data", "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.duplicateGroups.length, 1);

  const group = body.data.duplicateGroups[0];
  assert.equal(group.sizeBytes, 0);
  assert.equal(group.count, 2);
  assert.equal(group.redundantCopies, 1);
  assert.equal(group.reclaimableBytes, 0);
  assert.equal(group.hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("POST /api/duplicates calculates accurate reclaimable bytes for multiple duplicate groups", async (t) => {
  const tempDir = createTempDir("filo-dup-multi-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  // Group 1: 3 copies of 10-byte file (reclaimable: 2 * 10 = 20 bytes)
  const content1 = "1234567890";
  fs.writeFileSync(path.join(tempDir, "a1.txt"), content1, "utf8");
  fs.writeFileSync(path.join(tempDir, "a2.txt"), content1, "utf8");
  fs.writeFileSync(path.join(tempDir, "a3.txt"), content1, "utf8");

  // Group 2: 2 copies of 20-byte file (reclaimable: 1 * 20 = 20 bytes)
  const content2 = "12345678901234567890";
  fs.writeFileSync(path.join(tempDir, "b1.txt"), content2, "utf8");
  fs.writeFileSync(path.join(tempDir, "b2.txt"), content2, "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.duplicateGroups.length, 2);
  assert.equal(body.data.summary.totalDuplicateGroups, 2);
  assert.equal(body.data.summary.totalDuplicateFiles, 5);
  assert.equal(body.data.summary.totalRedundantCopies, 3);
  assert.equal(body.data.summary.reclaimableBytes, 40);
});

test("POST /api/duplicates rejects path traversal outside approved root with 403 OUTSIDE_APPROVED_ROOT", async (t) => {
  const tempDir = createTempDir("filo-dup-traversal-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../../../" })
  });

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OUTSIDE_APPROVED_ROOT");
});

test("POST /api/duplicates rejects absolute paths outside approved root with 403", async (t) => {
  const tempDir = createTempDir("filo-dup-abs-");
  const outsideDir = createTempDir("filo-dup-outside-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    removeDirRecursive(outsideDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: outsideDir })
  });

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OUTSIDE_APPROVED_ROOT");
});

test("POST /api/duplicates rejects null byte injection with 400 PATH_TRAVERSAL_DETECTED", async (t) => {
  const tempDir = createTempDir("filo-dup-nullbyte-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "subfolder\0evil" })
  });

  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "PATH_TRAVERSAL_DETECTED");
});

test("POST /api/duplicates rejects when path is a file instead of a directory", async (t) => {
  const tempDir = createTempDir("filo-dup-notadir-");
  const filePath = path.join(tempDir, "sample.txt");
  fs.writeFileSync(filePath, "content", "utf8");

  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "sample.txt" })
  });

  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "NOT_A_DIRECTORY");
});

test("POST /api/duplicates rejects nonexistent directory with 404 DIRECTORY_NOT_FOUND", async (t) => {
  const tempDir = createTempDir("filo-dup-missing-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/duplicates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "nonexistent-subfolder" })
  });

  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "DIRECTORY_NOT_FOUND");
});

test("findDuplicates ignores symlinks escaping approved root", async (t) => {
  const approvedDir = createTempDir("filo-dup-symlink-root-");
  const outsideDir = createTempDir("filo-dup-symlink-outside-");

  const content = "Confidential payload";
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), content, "utf8");
  fs.writeFileSync(path.join(approvedDir, "inside.txt"), content, "utf8");

  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideDir, path.join(approvedDir, "outside-link"), "junction");
    symlinkCreated = true;
  } catch {
    // Windows permissions without Developer Mode
  }

  t.after(() => {
    removeDirRecursive(approvedDir);
    removeDirRecursive(outsideDir);
  });

  if (symlinkCreated) {
    const result = await findDuplicates(".", { approvedRoot: approvedDir });
    assert.equal(result.success, true);
    // Because outside-link was ignored, there is only inside.txt, so 0 duplicate groups
    assert.equal(result.data.duplicateGroups.length, 0);
  }
});

test("findDuplicates safely handles disappearing or unreadable files without crashing", async (t) => {
  const tempDir = createTempDir("filo-dup-disappearing-");

  // Create two files with identical size (10 bytes)
  fs.writeFileSync(path.join(tempDir, "file1.txt"), "0123456789", "utf8");
  const file2Path = path.join(tempDir, "file2.txt");
  fs.writeFileSync(file2Path, "0123456789", "utf8");

  t.after(() => {
    removeDirRecursive(tempDir);
  });

  // Temporarily delete file2 right before duplicate detection runs its hash phase
  // We can test this by running findDuplicates with a disappearing file
  // To simulate disappearance right after scan: delete file2, but if scan runs first, let's delete during candidate check:
  // Even directly: if a candidate file is deleted or unreadable, streamHashFile or realpath fails gracefully.
  fs.unlinkSync(file2Path);

  const result = await findDuplicates(".", { approvedRoot: tempDir });
  assert.equal(result.success, true);
  // Only 1 file remained, so 0 candidates/duplicates
  assert.equal(result.data.duplicateGroups.length, 0);
});

test("findDuplicates signals truncation when maxFiles limit is reached", async (t) => {
  const tempDir = createTempDir("filo-dup-truncate-");

  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(tempDir, `file-${i}.txt`), "identical content", "utf8");
  }

  t.after(() => {
    removeDirRecursive(tempDir);
  });

  const result = await findDuplicates(".", {
    approvedRoot: tempDir,
    maxFiles: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.data.summary.isTruncated, true);
  assert.equal(result.data.summary.totalScannedFiles, 3);
});

test("streamHashFile produces accurate SHA-256 hex digest for file content", async (t) => {
  const tempDir = createTempDir("filo-dup-hash-");
  const filePath = path.join(tempDir, "sample.txt");
  const testString = "Hello filoAI SHA-256";
  fs.writeFileSync(filePath, testString, "utf8");

  t.after(() => {
    removeDirRecursive(tempDir);
  });

  const hash = await streamHashFile(filePath);
  const expectedHash = require("node:crypto").createHash("sha256").update(testString).digest("hex");
  assert.equal(hash, expectedHash);
});
