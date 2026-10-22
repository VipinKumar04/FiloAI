const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  getApprovedRoot,
  isPathInsideApprovedRoot
} = require("./scanService");

// In-memory store for previewed operations and completed history
const previewStore = new Map();
const operationHistory = [];

const PREVIEW_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Validates and previews a proposed file organization move.
 * Strictly read-only: does not modify the filesystem.
 *
 * @param {object} params
 * @param {string} params.sourcePath - Relative path to the source file
 * @param {string} params.destinationDir - Relative directory path for destination
 * @param {string} [params.recommendationId] - Optional linked recommendation ID
 * @param {string} [params.rationale] - Optional explanation
 * @param {object} [options={}] - Options including custom approvedRoot
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function previewOperation(params = {}, options = {}) {
  const { sourcePath, destinationDir = ".", recommendationId, rationale } = params;

  // 1. Resolve and canonicalize approved root
  let canonicalRoot;
  try {
    const rawRoot = options.approvedRoot ? path.resolve(options.approvedRoot) : getApprovedRoot();
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
  } catch {
    return {
      success: false,
      status: 500,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to resolve the approved scan root."
      }
    };
  }

  // 2. Validate input parameters
  if (typeof sourcePath !== "string" || !sourcePath.trim()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_SOURCE",
        message: "Source file path must be a non-empty string."
      }
    };
  }

  if (typeof destinationDir !== "string") {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_DESTINATION",
        message: "Destination directory must be a string."
      }
    };
  }

  // Null byte injection check
  if (sourcePath.includes("\0") || destinationDir.includes("\0")) {
    return {
      success: false,
      status: 400,
      error: {
        code: "PATH_TRAVERSAL_DETECTED",
        message: "Invalid path sequence detected."
      }
    };
  }

  // 3. Resolve and validate source path containment
  const trimmedSource = sourcePath.trim();
  const resolvedSource = path.resolve(canonicalRoot, trimmedSource);

  if (!isPathInsideApprovedRoot(resolvedSource, canonicalRoot)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: Source path is outside the approved scan root."
      }
    };
  }

  // 4. Verify source exists and is a regular file
  if (!fs.existsSync(resolvedSource)) {
    return {
      success: false,
      status: 404,
      error: {
        code: "FILE_NOT_FOUND",
        message: "The specified source file does not exist."
      }
    };
  }

  let canonicalSource;
  try {
    canonicalSource = fs.realpathSync(resolvedSource);
  } catch {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_SOURCE",
        message: "Unable to resolve canonical path of source file."
      }
    };
  }

  if (!isPathInsideApprovedRoot(canonicalSource, canonicalRoot)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: Source target is outside the approved scan root."
      }
    };
  }

  let lstat;
  try {
    lstat = await fs.promises.lstat(resolvedSource);
  } catch {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_SOURCE",
        message: "Unable to inspect source file entry."
      }
    };
  }

  if (lstat.isSymbolicLink()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "SYMLINK_NOT_ALLOWED",
        message: "Organizing symbolic links is prohibited for filesystem safety."
      }
    };
  }

  let sourceStat;
  try {
    sourceStat = await fs.promises.stat(canonicalSource);
  } catch {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_SOURCE",
        message: "Unable to read source file status."
      }
    };
  }

  if (!sourceStat.isFile()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "NOT_A_REGULAR_FILE",
        message: "Only regular files can be organized. Directories or special files are not eligible."
      }
    };
  }

  // 5. Resolve and validate destination directory
  const trimmedDestDir = destinationDir.trim() || ".";
  const resolvedDestDir = path.resolve(canonicalRoot, trimmedDestDir);

  if (!isPathInsideApprovedRoot(resolvedDestDir, canonicalRoot)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: Destination directory is outside the approved scan root."
      }
    };
  }

  // Destination file target
  const fileName = path.basename(resolvedSource);
  const resolvedDestPath = path.resolve(resolvedDestDir, fileName);

  if (!isPathInsideApprovedRoot(resolvedDestPath, canonicalRoot)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: Destination file path is outside the approved scan root."
      }
    };
  }

  // 6. Check for identity (source and destination are the same)
  if (resolvedSource.toLowerCase() === resolvedDestPath.toLowerCase()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "SAME_FILE_OPERATION",
        message: "Source file and proposed destination are already identical."
      }
    };
  }

  // 7. Check conflict status (destination already exists)
  const conflict = fs.existsSync(resolvedDestPath);
  const conflictReason = conflict
    ? "A file with the same name already exists in the destination folder."
    : null;
  const canExecute = !conflict;

  // 8. Generate secure tokens and relative display paths
  const sourceRelative = path.relative(canonicalRoot, resolvedSource).split(path.sep).join("/");
  const destRelative = path.relative(canonicalRoot, resolvedDestPath).split(path.sep).join("/");
  const destDirRelative = path.relative(canonicalRoot, resolvedDestDir).split(path.sep).join("/") || ".";

  const operationId = "op_" + crypto.randomBytes(8).toString("hex");
  const approvalToken = crypto.randomBytes(24).toString("hex");
  const expiresIn = typeof options.expiresInMs === "number" ? options.expiresInMs : PREVIEW_EXPIRY_MS;
  const expiresAt = Date.now() + expiresIn;

  const preview = {
    operationId,
    approvalToken,
    sourceRelative,
    destRelative,
    destDirRelative,
    fileName,
    sizeBytes: sourceStat.size,
    sourceMtime: sourceStat.mtime.toISOString(),
    recommendationId: typeof recommendationId === "string" ? recommendationId.trim() : null,
    rationale: typeof rationale === "string" ? rationale.trim() : null,
    conflict,
    conflictReason,
    canExecute,
    status: "previewed",
    createdAt: new Date().toISOString(),
    expiresAt
  };

  previewStore.set(operationId, preview);

  return {
    success: true,
    status: 200,
    data: {
      operationId,
      approvalToken,
      sourcePath: sourceRelative,
      destinationPath: destRelative,
      destinationDir: destDirRelative,
      fileName,
      sizeBytes: sourceStat.size,
      conflict,
      conflictReason,
      canExecute,
      expiresAt: new Date(expiresAt).toISOString(),
      recommendationId: preview.recommendationId,
      rationale: preview.rationale
    }
  };
}

/**
 * Executes a previously previewed and explicitly approved file organization move.
 * Strictly revalidates all paths, root containment, conflict status, and approval token.
 *
 * @param {object} params
 * @param {string} params.operationId - The ID generated during preview
 * @param {string} params.approvalToken - The secure token issued during preview
 * @param {object} [options={}] - Options including custom approvedRoot
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function executeOperation(params = {}, options = {}) {
  const { operationId, approvalToken } = params;

  if (typeof operationId !== "string" || !operationId.trim()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_OPERATION_ID",
        message: "Operation ID must be a non-empty string."
      }
    };
  }

  if (typeof approvalToken !== "string" || !approvalToken.trim()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_APPROVAL_TOKEN",
        message: "Approval token is required to execute an operation."
      }
    };
  }

  // 1. Lookup preview in store
  const record = previewStore.get(operationId.trim());
  if (!record) {
    return {
      success: false,
      status: 404,
      error: {
        code: "OPERATION_NOT_FOUND",
        message: "Operation preview was not found or has expired. Please preview the operation again."
      }
    };
  }

  // 2. Validate operation status
  if (record.status !== "previewed") {
    return {
      success: false,
      status: 409,
      error: {
        code: "INVALID_OPERATION_STATE",
        message: `This operation has already been ${record.status}.`
      }
    };
  }

  // 3. Verify token expiration
  if (Date.now() > record.expiresAt) {
    previewStore.delete(record.operationId);
    return {
      success: false,
      status: 410,
      error: {
        code: "APPROVAL_EXPIRED",
        message: "The approval token has expired. Please review and preview the operation again."
      }
    };
  }

  // 4. Constant-time timing-safe token verification
  const tokenBuf = Buffer.from(approvalToken.trim());
  const expectedBuf = Buffer.from(record.approvalToken);
  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return {
      success: false,
      status: 403,
      error: {
        code: "INVALID_APPROVAL_TOKEN",
        message: "The provided approval token does not match this operation."
      }
    };
  }

  // 5. Revalidate approved root containment
  let canonicalRoot;
  try {
    const rawRoot = options.approvedRoot ? path.resolve(options.approvedRoot) : getApprovedRoot();
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
  } catch {
    return {
      success: false,
      status: 500,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to resolve the approved scan root."
      }
    };
  }

  const resolvedSource = path.resolve(canonicalRoot, record.sourceRelative);
  const resolvedDestDir = path.resolve(canonicalRoot, record.destDirRelative);
  const resolvedDestPath = path.resolve(canonicalRoot, record.destRelative);

  if (
    !isPathInsideApprovedRoot(resolvedSource, canonicalRoot) ||
    !isPathInsideApprovedRoot(resolvedDestDir, canonicalRoot) ||
    !isPathInsideApprovedRoot(resolvedDestPath, canonicalRoot)
  ) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: One or more paths escape the approved scan root."
      }
    };
  }

  // 6. Confirm source file still exists and has not been modified or replaced
  if (!fs.existsSync(resolvedSource)) {
    return {
      success: false,
      status: 404,
      error: {
        code: "SOURCE_FILE_MISSING",
        message: "Source file no longer exists at the expected location."
      }
    };
  }

  let currentLstat;
  try {
    currentLstat = await fs.promises.lstat(resolvedSource);
  } catch {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_SOURCE",
        message: "Unable to inspect source file entry."
      }
    };
  }

  if (currentLstat.isSymbolicLink()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "SYMLINK_NOT_ALLOWED",
        message: "Source file cannot be a symbolic link."
      }
    };
  }

  let currentSourceStat;
  try {
    currentSourceStat = await fs.promises.stat(resolvedSource);
  } catch {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_SOURCE",
        message: "Unable to verify current source file status."
      }
    };
  }

  if (!currentSourceStat.isFile()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "NOT_A_REGULAR_FILE",
        message: "Source entry is no longer a regular file."
      }
    };
  }

  if (currentSourceStat.size !== record.sizeBytes) {
    return {
      success: false,
      status: 409,
      error: {
        code: "SOURCE_MODIFIED",
        message: "Source file was modified after preview. Please preview again."
      }
    };
  }

  // 7. Strict destination conflict check: NEVER overwrite an existing file!
  if (fs.existsSync(resolvedDestPath)) {
    return {
      success: false,
      status: 409,
      error: {
        code: "DESTINATION_CONFLICT",
        message: "Destination file already exists. Overwrite is strictly prohibited."
      }
    };
  }

  // 8. Safely ensure destination subdirectory exists inside approved root
  try {
    await fs.promises.mkdir(resolvedDestDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      status: 500,
      error: {
        code: "DIRECTORY_CREATION_FAILED",
        message: `Failed to create destination directory: ${err.message}`
      }
    };
  }

  // 9. Perform atomic move
  try {
    await fs.promises.rename(resolvedSource, resolvedDestPath);
  } catch (renameErr) {
    if (renameErr.code === "EXDEV") {
      // Cross-device fallback with exclusive copy
      try {
        await fs.promises.copyFile(resolvedSource, resolvedDestPath, fs.constants.COPYFILE_EXCL);
        await fs.promises.unlink(resolvedSource);
      } catch (copyErr) {
        return {
          success: false,
          status: 500,
          error: {
            code: "MOVE_FAILED",
            message: `Cross-device move failed: ${copyErr.message}`
          }
        };
      }
    } else {
      return {
        success: false,
        status: 500,
        error: {
          code: "MOVE_FAILED",
          message: `Unable to move file: ${renameErr.message}`
        }
      };
    }
  }

  // 10. Update record and record in operation history
  const executedAt = new Date().toISOString();
  record.status = "completed";
  record.executedAt = executedAt;

  const historyItem = {
    operationId: record.operationId,
    sourcePath: record.sourceRelative,
    destinationPath: record.destRelative,
    destinationDir: record.destDirRelative,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    recommendationId: record.recommendationId,
    rationale: record.rationale,
    status: "completed",
    executedAt,
    undoAvailable: true
  };

  operationHistory.unshift(historyItem);

  return {
    success: true,
    status: 200,
    data: {
      operationId: record.operationId,
      status: "completed",
      sourcePath: record.sourceRelative,
      destinationPath: record.destRelative,
      destinationDir: record.destDirRelative,
      fileName: record.fileName,
      executedAt,
      undoAvailable: true
    }
  };
}

/**
 * Safely undos a completed file move by verifying destination and restoring source location.
 *
 * @param {object} params
 * @param {string} params.operationId
 * @param {object} [options={}]
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function undoOperation(params = {}, options = {}) {
  const { operationId } = params;

  if (typeof operationId !== "string" || !operationId.trim()) {
    return {
      success: false,
      status: 400,
      error: {
        code: "INVALID_OPERATION_ID",
        message: "Operation ID must be a non-empty string."
      }
    };
  }

  const record = previewStore.get(operationId.trim());
  const historyItem = operationHistory.find((h) => h.operationId === operationId.trim());

  if (!record || !historyItem) {
    return {
      success: false,
      status: 404,
      error: {
        code: "OPERATION_NOT_FOUND",
        message: "Completed operation was not found in history."
      }
    };
  }

  if (record.status !== "completed" || historyItem.status !== "completed") {
    return {
      success: false,
      status: 400,
      error: {
        code: "CANNOT_UNDO",
        message: `Only completed operations can be undone. Current status: ${record.status}.`
      }
    };
  }

  // 1. Resolve canonical root
  let canonicalRoot;
  try {
    const rawRoot = options.approvedRoot ? path.resolve(options.approvedRoot) : getApprovedRoot();
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
  } catch {
    return {
      success: false,
      status: 500,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to resolve the approved scan root."
      }
    };
  }

  const currentFilePath = path.resolve(canonicalRoot, record.destRelative);
  const restoreSourcePath = path.resolve(canonicalRoot, record.sourceRelative);
  const restoreSourceDir = path.dirname(restoreSourcePath);

  // 2. Validate containment
  if (
    !isPathInsideApprovedRoot(currentFilePath, canonicalRoot) ||
    !isPathInsideApprovedRoot(restoreSourcePath, canonicalRoot)
  ) {
    return {
      success: false,
      status: 403,
      error: {
        code: "OUTSIDE_APPROVED_ROOT",
        message: "Access denied: File paths escape the approved scan root."
      }
    };
  }

  // 3. Verify moved file still exists at destination
  if (!fs.existsSync(currentFilePath)) {
    return {
      success: false,
      status: 404,
      error: {
        code: "FILE_MOVED_OR_MISSING",
        message: "The moved file could not be found at its destination location."
      }
    };
  }

  // 4. Strict check: Original source path must NOT be occupied (prevent overwrite)
  if (fs.existsSync(restoreSourcePath)) {
    return {
      success: false,
      status: 409,
      error: {
        code: "SOURCE_RESTORE_CONFLICT",
        message: "Cannot undo: A file already exists at the original source location. Overwriting is prohibited."
      }
    };
  }

  // 5. Ensure parent directory of original location exists
  try {
    await fs.promises.mkdir(restoreSourceDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      status: 500,
      error: {
        code: "DIRECTORY_CREATION_FAILED",
        message: `Failed to recreate original folder: ${err.message}`
      }
    };
  }

  // 6. Move file back
  try {
    await fs.promises.rename(currentFilePath, restoreSourcePath);
  } catch (renameErr) {
    if (renameErr.code === "EXDEV") {
      try {
        await fs.promises.copyFile(currentFilePath, restoreSourcePath, fs.constants.COPYFILE_EXCL);
        await fs.promises.unlink(currentFilePath);
      } catch (copyErr) {
        return {
          success: false,
          status: 500,
          error: {
            code: "UNDO_FAILED",
            message: `Cross-device undo failed: ${copyErr.message}`
          }
        };
      }
    } else {
      return {
        success: false,
        status: 500,
        error: {
          code: "UNDO_FAILED",
          message: `Unable to restore file: ${renameErr.message}`
        }
      };
    }
  }

  // 7. Update status
  const undoneAt = new Date().toISOString();
  record.status = "undone";
  record.undoneAt = undoneAt;
  historyItem.status = "undone";
  historyItem.undoneAt = undoneAt;
  historyItem.undoAvailable = false;

  return {
    success: true,
    status: 200,
    data: {
      operationId: record.operationId,
      status: "undone",
      sourcePath: record.sourceRelative,
      destinationPath: record.destRelative,
      undoneAt
    }
  };
}

/**
 * Returns the operation history of completed actions.
 * Never exposes approval tokens or absolute server paths.
 */
function getOperationHistory() {
  return operationHistory.map((item) => ({
    operationId: item.operationId,
    sourcePath: item.sourcePath,
    destinationPath: item.destinationPath,
    destinationDir: item.destinationDir,
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    recommendationId: item.recommendationId,
    rationale: item.rationale,
    status: item.status,
    executedAt: item.executedAt,
    undoneAt: item.undoneAt,
    undoAvailable: item.undoAvailable
  }));
}

module.exports = {
  previewOperation,
  executeOperation,
  undoOperation,
  getOperationHistory,
  PREVIEW_EXPIRY_MS
};
