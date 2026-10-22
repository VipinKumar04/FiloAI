const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  resolveAndValidateTarget,
  scanDirectory,
  isPathInsideApprovedRoot,
  getApprovedRoot
} = require("./scanService");

// Bounded concurrency limit for simultaneous file hash read streams
const HASH_CONCURRENCY = 4;

/**
 * Calculates SHA-256 hash using streaming reads to avoid loading files into memory.
 * Safely destroys stream and rejects on error.
 *
 * @param {string} filePath - Absolute canonical path to the file
 * @returns {Promise<string>} Hex SHA-256 hash
 */
function streamHashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    let settled = false;

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(hash.digest("hex"));
      }
    });

    stream.on("error", (err) => {
      if (!settled) {
        settled = true;
        try {
          stream.destroy();
        } catch {
          // Ignore stream destruction error
        }
        reject(err);
      }
    });
  });
}

/**
 * Concurrently processes items with a bounded concurrency pool.
 *
 * @param {Array<T>} items
 * @param {number} concurrencyLimit
 * @param {Function} fn
 * @returns {Promise<Array<R>>}
 */
async function mapConcurrent(items, concurrencyLimit, fn) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workersCount = Math.min(concurrencyLimit, items.length);
  const workers = Array.from({ length: workersCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Detects duplicate files inside the approved scan root using streaming SHA-256 hashing.
 * Read-only operation: does not move, rename, or delete any files.
 *
 * @param {string} [requestedPath="."] - Relative subpath or path within the approved root
 * @param {object} [options={}] - Options including custom approvedRoot, maxFiles, maxDepth
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function findDuplicates(requestedPath = ".", options = {}) {
  const startTime = Date.now();

  // 1. Validate requested path and resolve canonical root & target directory
  const targetValidation = await resolveAndValidateTarget(requestedPath, options.approvedRoot);
  if (!targetValidation.success) {
    return targetValidation;
  }
  const { canonicalRoot, canonicalTarget } = targetValidation;

  // 2. Perform bounded read-only scan of the directory
  const scanResult = await scanDirectory(requestedPath, options);
  if (!scanResult.success) {
    return scanResult;
  }

  const { files, summary: scanSummary } = scanResult.data;

  // 3. Group files by size
  // Files with different sizes CANNOT have identical content.
  const sizeBuckets = new Map();
  for (const file of files) {
    const list = sizeBuckets.get(file.sizeBytes);
    if (list) {
      list.push(file);
    } else {
      sizeBuckets.set(file.sizeBytes, [file]);
    }
  }

  // Filter for candidate files where bucket length >= 2
  const candidateFiles = [];
  for (const bucketFiles of sizeBuckets.values()) {
    if (bucketFiles.length >= 2) {
      candidateFiles.push(...bucketFiles);
    }
  }

  const skippedFiles = [];

  // 4. Concurrently hash candidate files with bounded concurrency and strict containment checks
  const hashedCandidates = await mapConcurrent(candidateFiles, HASH_CONCURRENCY, async (candidate) => {
    // Treat hashes as identifiers, not proof that paths remain safe.
    // Validate file path against canonical root and target.
    const fullPath = path.resolve(canonicalTarget, candidate.relativePath);

    // Containment check on resolved path
    if (!isPathInsideApprovedRoot(fullPath, canonicalRoot)) {
      skippedFiles.push({
        relativePath: candidate.relativePath,
        reason: "Path escapes approved root"
      });
      return null;
    }

    // Canonical path verification (realpath checks against symlink race or escape)
    let realFilePath;
    try {
      realFilePath = await fs.promises.realpath(fullPath);
    } catch (err) {
      skippedFiles.push({
        relativePath: candidate.relativePath,
        reason: err.code || "File inaccessible or disappeared during scan"
      });
      return null;
    }

    if (!isPathInsideApprovedRoot(realFilePath, canonicalRoot)) {
      skippedFiles.push({
        relativePath: candidate.relativePath,
        reason: "Target path escapes approved root"
      });
      return null;
    }

    // Ensure target is still a regular file
    try {
      const stat = await fs.promises.stat(realFilePath);
      if (!stat.isFile()) {
        skippedFiles.push({
          relativePath: candidate.relativePath,
          reason: "Entry is not a regular file"
        });
        return null;
      }
    } catch (err) {
      skippedFiles.push({
        relativePath: candidate.relativePath,
        reason: err.code || "Unable to stat file"
      });
      return null;
    }

    // Streaming SHA-256 computation
    try {
      const hash = await streamHashFile(realFilePath);
      return {
        candidate,
        hash,
        sizeBytes: candidate.sizeBytes
      };
    } catch (err) {
      skippedFiles.push({
        relativePath: candidate.relativePath,
        reason: err.code || err.message || "Read stream error during hashing"
      });
      return null;
    }
  });

  // 5. Group successfully hashed files by SHA-256 hash
  const hashGroups = new Map();
  for (const item of hashedCandidates) {
    if (!item) continue;
    const group = hashGroups.get(item.hash);
    if (group) {
      group.push(item.candidate);
    } else {
      hashGroups.set(item.hash, [item.candidate]);
    }
  }

  // 6. Filter to only duplicate groups (>= 2 files with identical SHA-256 hash)
  const duplicateGroups = [];
  let totalDuplicateFiles = 0;
  let totalRedundantCopies = 0;
  let reclaimableBytes = 0;

  for (const [hash, groupFiles] of hashGroups.entries()) {
    if (groupFiles.length >= 2) {
      // Deterministic sort: oldest lastModified first, then relativePath
      groupFiles.sort((a, b) => {
        const timeDiff = new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.relativePath.localeCompare(b.relativePath);
      });

      const sizeBytes = groupFiles[0].sizeBytes;
      const copiesCount = groupFiles.length - 1;
      const groupReclaimable = copiesCount * sizeBytes;

      totalDuplicateFiles += groupFiles.length;
      totalRedundantCopies += copiesCount;
      reclaimableBytes += groupReclaimable;

      duplicateGroups.push({
        hash,
        sizeBytes,
        count: groupFiles.length,
        redundantCopies: copiesCount,
        reclaimableBytes: groupReclaimable,
        files: groupFiles.map((f, idx) => ({
          name: f.name,
          relativePath: f.relativePath,
          extension: f.extension,
          sizeBytes: f.sizeBytes,
          lastModified: f.lastModified,
          // Role distinction: primary candidate vs duplicate copy
          role: idx === 0 ? "primary_candidate" : "duplicate_copy",
          isPrimaryCandidate: idx === 0
        }))
      });
    }
  }

  // Sort duplicate groups by reclaimable space descending (highest potential savings first)
  duplicateGroups.sort((a, b) => {
    const diff = b.reclaimableBytes - a.reclaimableBytes;
    if (diff !== 0) return diff;
    return a.hash.localeCompare(b.hash);
  });

  const durationMs = Date.now() - startTime;

  return {
    success: true,
    status: 200,
    data: {
      duplicateGroups,
      summary: {
        totalDuplicateGroups: duplicateGroups.length,
        totalDuplicateFiles,
        totalRedundantCopies,
        reclaimableBytes,
        totalScannedFiles: files.length,
        totalScannedDirectories: scanSummary.totalDirectories,
        totalCandidateFiles: candidateFiles.length,
        skippedFilesCount: skippedFiles.length,
        skippedFiles,
        isTruncated: scanSummary.isTruncated,
        scanDurationMs: durationMs,
        maxFilesLimit: scanSummary.maxFilesLimit
      }
    }
  };
}

module.exports = {
  findDuplicates,
  streamHashFile,
  HASH_CONCURRENCY
};
