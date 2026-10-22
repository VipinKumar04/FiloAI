const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILES = 2000;
const ABSOLUTE_MAX_FILES = 10000;
const DEFAULT_MAX_DEPTH = 15;
const ABSOLUTE_MAX_DEPTH = 30;

/**
 * Parses and bounds numeric configuration values to prevent invalid or runaway limits.
 */
function parseBoundedLimit(value, defaultValue, minVal, maxVal) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < minVal) {
    return defaultValue;
  }
  return Math.min(parsed, maxVal);
}

/**
 * Returns the configured approved root directory.
 * If FILO_SCAN_ROOT is set, resolves it directly without creating directories.
 * Only initializes the safe local './scan-workspace' folder if no custom root is set.
 */
function getApprovedRoot() {
  const envRoot = process.env.FILO_SCAN_ROOT;

  if (envRoot && typeof envRoot === "string" && envRoot.trim().length > 0) {
    const customRoot = path.resolve(envRoot.trim());
    return fs.existsSync(customRoot) ? fs.realpathSync(customRoot) : customRoot;
  }

  // Fallback to default local workspace inside project
  const defaultRoot = path.resolve(process.cwd(), "scan-workspace");
  if (!fs.existsSync(defaultRoot)) {
    try {
      fs.mkdirSync(defaultRoot, { recursive: true });
    } catch {
      // If unable to create default root, proceed with resolved path
    }
  }

  return fs.existsSync(defaultRoot) ? fs.realpathSync(defaultRoot) : defaultRoot;
}

/**
 * Validates whether a target path is safely contained within an approved root.
 * Normalizes case on Windows (win32) to prevent drive letter or case discrepancies.
 */
function isPathInsideApprovedRoot(targetPath, approvedRoot) {
  const normTarget = process.platform === "win32"
    ? path.normalize(targetPath).toLowerCase()
    : path.normalize(targetPath);
  const normRoot = process.platform === "win32"
    ? path.normalize(approvedRoot).toLowerCase()
    : path.normalize(approvedRoot);

  if (normTarget === normRoot) {
    return true;
  }
  const rootWithSep = normRoot.endsWith(path.sep)
    ? normRoot
    : normRoot + path.sep;
  return normTarget.startsWith(rootWithSep);
}

/**
 * Returns safe public configuration about the approved scan root.
 */
function getScanConfig(customRoot) {
  const root = customRoot ? path.resolve(customRoot) : getApprovedRoot();
  const isCustom = Boolean(process.env.FILO_SCAN_ROOT && process.env.FILO_SCAN_ROOT.trim());
  const maxLimit = parseBoundedLimit(process.env.FILO_MAX_FILES, DEFAULT_MAX_FILES, 1, ABSOLUTE_MAX_FILES);

  return {
    approvedRootDisplay: path.basename(root) || root,
    isCustomRoot: isCustom,
    readOnly: true,
    maxFilesLimit: maxLimit
  };
}

/**
 * Validates and resolves the approved root and requested target directory.
 * Enforces strict containment, avoids path existence oracles, and checks directory status.
 *
 * @param {string} [requestedPath="."] - Relative subpath or path within the approved root
 * @param {string} [approvedRootOption=null] - Optional custom approved root override
 * @returns {Promise<{ success: boolean, canonicalRoot?: string, canonicalTarget?: string, error?: object, status?: number }>}
 */
async function resolveAndValidateTarget(requestedPath = ".", approvedRootOption = null) {
  // 1. Determine and canonicalize approved root
  let canonicalRoot;
  try {
    const rawRoot = approvedRootOption ? path.resolve(approvedRootOption) : getApprovedRoot();
    if (!fs.existsSync(rawRoot)) {
      return {
        success: false,
        status: 404,
        error: {
          code: "DIRECTORY_NOT_FOUND",
          message: "The approved scan root directory does not exist."
        }
      };
    }
    canonicalRoot = fs.realpathSync(rawRoot);
  } catch (err) {
    return {
      success: false,
      status: 500,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to resolve the approved scan root."
      }
    };
  }

  // 2. Validate requested path input
  if (typeof requestedPath !== "string") {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_DIRECTORY",
        message: "Directory path must be a string."
      }
    };
  }

  // Check for null byte injection
  if (requestedPath.includes("\0")) {
    return {
      success: false,
      status: 400,
      error: {
        code: "PATH_TRAVERSAL_DETECTED",
        message: "Invalid path sequence detected."
      }
    };
  }

  // 3. Resolve target path against approved root
  const trimmedPath = requestedPath.trim() || ".";
  const resolvedTarget = path.resolve(canonicalRoot, trimmedPath);

  // 4. Pre-check containment before touching filesystem to prevent path enumeration oracles
  if (!isPathInsideApprovedRoot(resolvedTarget, canonicalRoot)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: The requested path is outside the approved scan root."
      }
    };
  }

  // 5. Verify target exists
  if (!fs.existsSync(resolvedTarget)) {
    return {
      success: false,
      status: 404,
      error: {
        code: "DIRECTORY_NOT_FOUND",
        message: "The selected directory does not exist."
      }
    };
  }

  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync(resolvedTarget);
  } catch (err) {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_DIRECTORY",
        message: "Unable to access the specified directory."
      }
    };
  }

  // 6. Strict canonical containment check (prevents symlinks escaping at the root target)
  if (!isPathInsideApprovedRoot(canonicalTarget, canonicalRoot)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: The requested path is outside the approved scan root."
      }
    };
  }

  // 7. Ensure target is a directory
  let targetStat;
  try {
    targetStat = await fs.promises.stat(canonicalTarget);
  } catch (err) {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_DIRECTORY",
        message: "Unable to read directory status."
      }
    };
  }

  if (!targetStat.isDirectory()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "NOT_A_DIRECTORY",
        message: "The specified path is a file, not a directory."
      }
    };
  }

  return {
    success: true,
    canonicalRoot,
    canonicalTarget
  };
}

/**
 * Scans an approved directory in read-only mode and collects file metadata.
 *
 * @param {string} [requestedPath="."] - Relative subpath or path within the approved root
 * @param {object} [options={}] - Options including custom approvedRoot, maxFiles, maxDepth
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function scanDirectory(requestedPath = ".", options = {}) {
  const startTime = Date.now();
  const envMaxFiles = parseBoundedLimit(process.env.FILO_MAX_FILES, DEFAULT_MAX_FILES, 1, ABSOLUTE_MAX_FILES);
  const maxFiles = options.maxFiles !== undefined
    ? parseBoundedLimit(options.maxFiles, envMaxFiles, 1, ABSOLUTE_MAX_FILES)
    : envMaxFiles;

  const envMaxDepth = parseBoundedLimit(process.env.FILO_MAX_DEPTH, DEFAULT_MAX_DEPTH, 1, ABSOLUTE_MAX_DEPTH);
  const maxDepth = options.maxDepth !== undefined
    ? parseBoundedLimit(options.maxDepth, envMaxDepth, 1, ABSOLUTE_MAX_DEPTH)
    : envMaxDepth;

  // Validate and resolve canonical root and target
  const targetValidation = await resolveAndValidateTarget(requestedPath, options.approvedRoot);
  if (!targetValidation.success) {
    return targetValidation;
  }
  const { canonicalRoot, canonicalTarget } = targetValidation;

  // 8. Recursive bounded read-only scan with cycle detection
  const files = [];
  const visitedDirs = new Set();
  let totalDirectories = 0;
  let totalSizeBytes = 0;
  let isTruncated = false;

  async function walk(dirPath, currentDepth) {
    if (isTruncated || currentDepth > maxDepth) {
      if (currentDepth > maxDepth) {
        isTruncated = true;
      }
      return;
    }

    // Canonicalize directory and detect cycles
    let canonicalDir;
    try {
      canonicalDir = await fs.promises.realpath(dirPath);
    } catch {
      return;
    }

    if (visitedDirs.has(canonicalDir)) {
      return; // Cycle detected, skip
    }
    visitedDirs.add(canonicalDir);

    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      // Gracefully skip unreadable directories (e.g. permission denied) without crashing
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        isTruncated = true;
        break;
      }

      const fullPath = path.join(dirPath, entry.name);

      // Use lstat to reliably check entry without following symlinks blindly (TOCTOU mitigation)
      let entryStat;
      try {
        entryStat = await fs.promises.lstat(fullPath);
      } catch {
        // Transient file deleted or inaccessible during scan
        continue;
      }

      // Handle symbolic links safely
      if (entryStat.isSymbolicLink()) {
        try {
          const realLinkPath = await fs.promises.realpath(fullPath);
          // If symlink points outside the approved root, strictly ignore
          if (!isPathInsideApprovedRoot(realLinkPath, canonicalRoot)) {
            continue;
          }
          const linkTargetStat = await fs.promises.stat(realLinkPath);
          if (linkTargetStat.isDirectory()) {
            totalDirectories += 1;
            await walk(fullPath, currentDepth + 1);
          } else if (linkTargetStat.isFile()) {
            const relPath = path.relative(canonicalTarget, fullPath).split(path.sep).join("/");
            const ext = path.extname(entry.name).toLowerCase();
            files.push({
              name: entry.name,
              relativePath: relPath,
              extension: ext,
              sizeBytes: linkTargetStat.size,
              lastModified: linkTargetStat.mtime.toISOString(),
              type: "file"
            });
            totalSizeBytes += linkTargetStat.size;
          }
        } catch {
          // Broken symlinks or permission errors on symlink targets are skipped safely
          continue;
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        totalDirectories += 1;
        await walk(fullPath, currentDepth + 1);
      } else if (entryStat.isFile()) {
        const relPath = path.relative(canonicalTarget, fullPath).split(path.sep).join("/");
        const ext = path.extname(entry.name).toLowerCase();

        files.push({
          name: entry.name,
          relativePath: relPath,
          extension: ext,
          sizeBytes: entryStat.size,
          lastModified: entryStat.mtime.toISOString(),
          type: "file"
        });
        totalSizeBytes += entryStat.size;
      }
    }
  }

  await walk(canonicalTarget, 0);

  // Sort files predictably by relativePath
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    success: true,
    status: 200,
    data: {
      files,
      summary: {
        totalFiles: files.length,
        totalDirectories,
        totalSizeBytes,
        scanDurationMs: Date.now() - startTime,
        isTruncated,
        maxFilesLimit: maxFiles
      }
    }
  };
}

module.exports = {
  getApprovedRoot,
  isPathInsideApprovedRoot,
  getScanConfig,
  scanDirectory,
  resolveAndValidateTarget,
  parseBoundedLimit,
  DEFAULT_MAX_FILES,
  ABSOLUTE_MAX_FILES,
  DEFAULT_MAX_DEPTH,
  ABSOLUTE_MAX_DEPTH
};
