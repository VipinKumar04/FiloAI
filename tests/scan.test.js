const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const app = require("../backend/app");
const { scanDirectory, isPathInsideApprovedRoot, getApprovedRoot } = require("../backend/services/scanService");

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

function createTempDir(prefix = "filo-scan-test-") {
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

test("GET /api/scan/config returns read-only configuration", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan/config`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.readOnly, true);
  assert.equal(typeof body.data.maxFilesLimit, "number");
  assert.equal(typeof body.data.approvedRootDisplay, "string");
});

test("POST /api/scan returns successful metadata for valid directory", async (t) => {
  const tempDir = createTempDir("filo-valid-scan-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  // Create subdirectories and sample files
  fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "docs", "alpha.txt"), "Hello Alpha", "utf8");
  fs.writeFileSync(path.join(tempDir, "docs", "beta.md"), "# Beta Markdown Content", "utf8");
  fs.writeFileSync(path.join(tempDir, "root.json"), JSON.stringify({ test: true }), "utf8");

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(Array.isArray(body.data.files), true);
  assert.equal(body.data.files.length, 3);

  // Verify metadata fields
  const alpha = body.data.files.find((f) => f.name === "alpha.txt");
  assert.ok(alpha, "alpha.txt should be found");
  assert.equal(alpha.extension, ".txt");
  assert.equal(alpha.relativePath, "docs/alpha.txt");
  assert.equal(alpha.sizeBytes, 11);
  assert.equal(alpha.type, "file");
  assert.ok(Date.parse(alpha.lastModified), "lastModified should be valid ISO date");

  // Verify summary statistics
  assert.equal(body.data.summary.totalFiles, 3);
  assert.equal(body.data.summary.totalDirectories, 1);
  assert.ok(body.data.summary.totalSizeBytes > 0);
  assert.equal(body.data.summary.isTruncated, false);
});

test("POST /api/scan handles an empty directory", async (t) => {
  const tempDir = createTempDir("filo-empty-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "." })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.files.length, 0);
  assert.equal(body.data.summary.totalFiles, 0);
  assert.equal(body.data.summary.totalDirectories, 0);
  assert.equal(body.data.summary.totalSizeBytes, 0);
});

test("POST /api/scan rejects missing or nonexistent directory with 404", async (t) => {
  const tempDir = createTempDir("filo-missing-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "nonexistent-subfolder" })
  });

  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "DIRECTORY_NOT_FOUND");
});

test("POST /api/scan rejects path traversal attempts with 403 OUTSIDE_APPROVED_ROOT", async (t) => {
  const tempDir = createTempDir("filo-traversal-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../../../" })
  });

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OUTSIDE_APPROVED_ROOT");
});

test("POST /api/scan rejects null byte injection with 400 PATH_TRAVERSAL_DETECTED", async (t) => {
  const tempDir = createTempDir("filo-nullbyte-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "subfolder\0evil" })
  });

  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "PATH_TRAVERSAL_DETECTED");
});

test("POST /api/scan rejects when path is a file instead of a directory", async (t) => {
  const tempDir = createTempDir("filo-notadir-");
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

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "sample.txt" })
  });

  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "NOT_A_DIRECTORY");
});

test("scanService truncates results when maxFiles limit is reached", async (t) => {
  const tempDir = createTempDir("filo-truncate-");

  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(tempDir, `file-${i}.txt`), `file ${i}`, "utf8");
  }

  t.after(() => {
    removeDirRecursive(tempDir);
  });

  const result = await scanDirectory(".", {
    approvedRoot: tempDir,
    maxFiles: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.data.files.length, 3);
  assert.equal(result.data.summary.isTruncated, true);
});

test("scanService ignores symlinks escaping approved root", async (t) => {
  const approvedDir = createTempDir("filo-symlink-root-");
  const outsideDir = createTempDir("filo-symlink-outside-");

  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret data", "utf8");
  fs.writeFileSync(path.join(approvedDir, "safe.txt"), "safe data", "utf8");

  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideDir, path.join(approvedDir, "outside-link"), "junction");
    symlinkCreated = true;
  } catch {
    // Symlinks may require elevated privileges on older Windows without Developer Mode
  }

  t.after(() => {
    removeDirRecursive(approvedDir);
    removeDirRecursive(outsideDir);
  });

  if (symlinkCreated) {
    const result = await scanDirectory(".", { approvedRoot: approvedDir });
    assert.equal(result.success, true);
    // Should contain safe.txt, but NOT secret.txt from outsideDir
    const hasSecret = result.data.files.some((f) => f.name === "secret.txt");
    assert.equal(hasSecret, false, "Symlink outside approved root must not be traversed");
  }
});

test("POST /api/scan rejects absolute paths outside approved root", async (t) => {
  const tempDir = createTempDir("filo-abs-");
  const outsideDir = createTempDir("filo-outside-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    removeDirRecursive(outsideDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: outsideDir })
  });

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OUTSIDE_APPROVED_ROOT");
});

test("POST /api/scan pre-checks containment and avoids path existence oracle", async (t) => {
  const tempDir = createTempDir("filo-oracle-");
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = tempDir;

  const { server, baseUrl } = await startTestServer();

  t.after(() => new Promise((resolve, reject) => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(tempDir);
    server.close((error) => error ? reject(error) : resolve());
  }));

  // Probe non-existent path outside root: must return 403 OUTSIDE_APPROVED_ROOT, NOT 404
  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "../../definitely-does-not-exist-xyz123" })
  });

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "OUTSIDE_APPROVED_ROOT");
});

test("scanService handles directory cycles without infinite loops", async (t) => {
  const tempDir = createTempDir("filo-cycle-");
  const subDir = path.join(tempDir, "sub");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "item.txt"), "hello", "utf8");

  let symlinkCreated = false;
  try {
    fs.symlinkSync(tempDir, path.join(subDir, "loop"), "junction");
    symlinkCreated = true;
  } catch {
    // Symlinks may not be permitted without elevated permissions
  }

  t.after(() => {
    removeDirRecursive(tempDir);
  });

  if (symlinkCreated) {
    const result = await scanDirectory(".", { approvedRoot: tempDir });
    assert.equal(result.success, true);
    // Cycle is detected and skipped without maxDepth runaway
    assert.equal(result.data.summary.isTruncated, false);
    assert.equal(result.data.files.length, 1);
  }
});

test("custom FILO_SCAN_ROOT does not create directories if nonexistent", async (t) => {
  const nonExistentPath = path.join(os.tmpdir(), `filo-never-created-${Date.now()}`);
  const originalScanRoot = process.env.FILO_SCAN_ROOT;
  process.env.FILO_SCAN_ROOT = nonExistentPath;

  t.after(() => {
    process.env.FILO_SCAN_ROOT = originalScanRoot;
    removeDirRecursive(nonExistentPath);
  });

  const root = getApprovedRoot();
  assert.equal(fs.existsSync(nonExistentPath), false, "Custom root must not be created on disk");

  const scanResult = await scanDirectory(".");
  assert.equal(scanResult.success, false);
  assert.equal(scanResult.status, 404);
  assert.equal(scanResult.error.code, "DIRECTORY_NOT_FOUND");
  assert.equal(fs.existsSync(nonExistentPath), false, "Must remain non-existent after scan attempt");
});

test("scanDirectory safely bounds invalid and extreme FILO_MAX_FILES values", async (t) => {
  const tempDir = createTempDir("filo-bounds-");
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(tempDir, `item-${i}.txt`), "content", "utf8");
  }

  const originalMaxFiles = process.env.FILO_MAX_FILES;

  t.after(() => {
    process.env.FILO_MAX_FILES = originalMaxFiles;
    removeDirRecursive(tempDir);
  });

  // Test negative/invalid value: should fallback to default (2000), not crash or behave as negative
  process.env.FILO_MAX_FILES = "-99";
  const resultNegative = await scanDirectory(".", { approvedRoot: tempDir });
  assert.equal(resultNegative.success, true);
  assert.equal(resultNegative.data.files.length, 3);
  assert.equal(resultNegative.data.summary.maxFilesLimit, 2000);

  // Test non-numeric string: should fallback to default (2000)
  process.env.FILO_MAX_FILES = "invalid-number";
  const resultInvalid = await scanDirectory(".", { approvedRoot: tempDir });
  assert.equal(resultInvalid.success, true);
  assert.equal(resultInvalid.data.files.length, 3);
  assert.equal(resultInvalid.data.summary.maxFilesLimit, 2000);

  // Test excessive value: should be capped at ABSOLUTE_MAX_FILES (10000)
  process.env.FILO_MAX_FILES = "999999";
  const resultExcessive = await scanDirectory(".", { approvedRoot: tempDir });
  assert.equal(resultExcessive.success, true);
  assert.equal(resultExcessive.data.summary.maxFilesLimit, 10000);
});
