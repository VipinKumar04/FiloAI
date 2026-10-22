const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  getApprovedRoot,
  isPathInsideApprovedRoot
} = require("./scanService");
const recoveryJournal = require("./recoveryJournal");

// In-memory store for active previewed operations and fast history access
const previewStore = new Map();
let operationHistory = [];
const activeExecutionLocks = new Set();

const PREVIEW_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
let lastCorruptedLinesCount = 0;
let lastRecoveryRequiredCount = 0;

/**
 * Safely appends an entry to the recovery journal without throwing.
 */
async function safeAppendJournalEntry(entry, options = {}) {
  try {
    return await recoveryJournal.appendJournalEntry(entry, options);
  } catch (err) {
    console.warn(`[Recovery Journal] Failed to append entry for ${entry && entry.operationId}:`, err.message);
    return false;
  }
}

/**
 * Initializes the organization service and synchronizes with the durable recovery journal.
 * Detects interrupted operations and transitions them to 'recovery_required' without altering files on disk.
 *
 * @param {object} [options={}]
 * @returns {Promise<{ recoveryRequiredCount: number, corruptedLinesCount: number }>}
 */
async function initOrganizationService(options = {}) {
  let canonicalRoot = null;
  try {
    const rawRoot = options.approvedRoot ? path.resolve(options.approvedRoot) : getApprovedRoot();
    if (fs.existsSync(rawRoot)) {
      canonicalRoot = fs.realpathSync(rawRoot);
    }
  } catch {
    // Ignore root resolution failure during early initialization
  }

  const result = await recoveryJournal.loadAndRecoverJournal({
    canonicalRoot,
    journalPath: options.journalPath
  });

  operationHistory = result.history;
  lastCorruptedLinesCount = result.corruptedLinesCount;
  lastRecoveryRequiredCount = result.recoveryRequiredCount;

  // Sync loaded operations into previewStore for undo lookups
  for (const [opId, op] of result.operations.entries()) {
    if (!previewStore.has(opId)) {
      previewStore.set(opId, {
        ...op,
        sourceRelative: op.sourcePath,
        destRelative: op.destinationPath,
        destDirRelative: op.destinationDir
      });
    }
  }

  return {
    recoveryRequiredCount: result.recoveryRequiredCount,
    corruptedLinesCount: result.corruptedLinesCount
  };
}

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
    sourcePath: sourceRelative,
    destinationPath: destRelative,
    destinationDir: destDirRelative,
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
 * Records state changes to the durable recovery journal with concurrency protection.
 *
 * @param {object} params
 * @param {string} params.operationId - The ID generated during preview
 * @param {string} params.approvalToken - The secure token issued during preview
 * @param {object} [options={}] - Options including custom approvedRoot and journalPath
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

  const cleanOpId = operationId.trim();

  // 1. Concurrency guard: reject concurrent execution attempts on the same operationId
  if (activeExecutionLocks.has(cleanOpId)) {
    return {
      success: false,
      status: 409,
      error: {
        code: "OPERATION_ALREADY_IN_PROGRESS",
        message: "This operation is currently being executed. Duplicate concurrent execution is prohibited."
      }
    };
  }

  // 2. Lookup preview in store
  const record = previewStore.get(cleanOpId);
  if (!record) {
    // Check if it's already in history
    const existingHistory = operationHistory.find((h) => h.operationId === cleanOpId);
    if (existingHistory) {
      return {
        success: false,
        status: 409,
        error: {
          code: "ALREADY_COMPLETED",
          message: `This operation has already been ${existingHistory.status}. Replaying approval is prohibited.`
        }
      };
    }

    return {
      success: false,
      status: 404,
      error: {
        code: "OPERATION_NOT_FOUND",
        message: "Operation preview was not found or has expired. Please preview the operation again."
      }
    };
  }

  // 3. Validate operation status
  if (record.status === "executing") {
    return {
      success: false,
      status: 409,
      error: {
        code: "OPERATION_ALREADY_IN_PROGRESS",
        message: "This operation is already executing. Concurrent execution is prohibited."
      }
    };
  }

  if (record.status !== "previewed") {
    return {
      success: false,
      status: 409,
      error: {
        code: "INVALID_OPERATION_STATE",
        message: `This operation has already been ${record.status}. Replaying approval is prohibited.`
      }
    };
  }

  // 4. Verify token expiration
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

  // 5. Constant-time timing-safe token verification
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

  // 6. Acquire execution lock and transition status to 'executing'
  activeExecutionLocks.add(cleanOpId);
  record.status = "executing";

  // Journal the in-flight state immediately before performing filesystem actions
  try {
    await recoveryJournal.appendJournalEntry({
      operationId: record.operationId,
      status: "executing",
      sourcePath: record.sourceRelative,
      destinationPath: record.destRelative,
      destinationDir: record.destDirRelative,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      recommendationId: record.recommendationId,
      rationale: record.rationale
    }, options);
  } catch (journalErr) {
    activeExecutionLocks.delete(cleanOpId);
    record.status = "previewed"; // Restore preview status if pre-execution journal fails
    return {
      success: false,
      status: 500,
      error: {
        code: "JOURNAL_WRITE_FAILED",
        message: `Failed to write to recovery journal prior to execution: ${journalErr.message}`
      }
    };
  }

  try {
    // 7. Revalidate approved root containment
    let canonicalRoot;
    try {
      const rawRoot = options.approvedRoot ? path.resolve(options.approvedRoot) : getApprovedRoot();
      if (!fs.existsSync(rawRoot)) {
        record.status = "failed";
        await safeAppendJournalEntry({ ...record, status: "failed", error: "Root directory missing" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Cannot resolve approved root" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Path traversal outside root" }, options);
      return {
        success: false,
        status: 403,
        error: {
          code: "OUTSIDE_APPROVED_ROOT",
          message: "Access denied: One or more paths escape the approved scan root."
        }
      };
    }

    // 8. Confirm source file still exists and has not been modified or replaced
    if (!fs.existsSync(resolvedSource)) {
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Source file missing" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Cannot inspect source entry" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Source is symbolic link" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Cannot stat source" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Not a regular file" }, options);
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
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Source modified" }, options);
      return {
        success: false,
        status: 409,
        error: {
          code: "SOURCE_MODIFIED",
          message: "Source file was modified after preview. Please preview again."
        }
      };
    }

    // 9. Strict destination conflict check: NEVER overwrite an existing file!
    if (fs.existsSync(resolvedDestPath)) {
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: "Destination conflict" }, options);
      return {
        success: false,
        status: 409,
        error: {
          code: "DESTINATION_CONFLICT",
          message: "Destination file already exists. Overwrite is strictly prohibited."
        }
      };
    }

    // 10. Safely ensure destination subdirectory exists inside approved root
    try {
      await fs.promises.mkdir(resolvedDestDir, { recursive: true });
    } catch (err) {
      record.status = "failed";
      await safeAppendJournalEntry({ ...record, status: "failed", error: `Directory creation failed: ${err.message}` }, options);
      return {
        success: false,
        status: 500,
        error: {
          code: "DIRECTORY_CREATION_FAILED",
          message: `Failed to create destination directory: ${err.message}`
        }
      };
    }

    // 11. Perform atomic move with verified cross-device fallback
    try {
      await fs.promises.rename(resolvedSource, resolvedDestPath);
    } catch (renameErr) {
      if (renameErr.code === "EXDEV") {
        // Cross-device fallback with verified copy and destination preservation
        let copyCompleted = false;
        try {
          await fs.promises.copyFile(resolvedSource, resolvedDestPath, fs.constants.COPYFILE_EXCL);
          copyCompleted = true;

          // Verify copied file exists and size matches source before removing source
          const destStat = await fs.promises.stat(resolvedDestPath);
          if (destStat.size !== record.sizeBytes) {
            throw new Error(`Copied destination file size (${destStat.size}B) does not match source (${record.sizeBytes}B)`);
          }

          await fs.promises.unlink(resolvedSource);
        } catch (copyErr) {
          if (!copyCompleted) {
            // Copy failed before completing: preserve source intact, remove partial destination if present
            try {
              if (fs.existsSync(resolvedDestPath)) {
                await fs.promises.unlink(resolvedDestPath);
              }
            } catch {
              // Ignore cleanup error
            }
            record.status = "failed";
            await safeAppendJournalEntry({ ...record, status: "failed", error: `Copy failed: ${copyErr.message}` }, options);
            return {
              success: false,
              status: 500,
              error: {
                code: "COPY_FAILED",
                message: `Cross-device move failed: ${copyErr.message}. Source file remains unchanged.`
              }
            };
          } else {
            // Copy completed, but unlinking source failed: both copies exist!
            // Transition to recovery_required state
            record.status = "recovery_required";
            record.recoveryReason = `Destination file copied, but source could not be deleted: ${copyErr.message}`;
            await safeAppendJournalEntry({ ...record, status: "recovery_required", error: copyErr.message }, options);
            operationHistory.unshift({
              operationId: record.operationId,
              sourcePath: record.sourceRelative,
              destinationPath: record.destRelative,
              destinationDir: record.destDirRelative,
              fileName: record.fileName,
              sizeBytes: record.sizeBytes,
              recommendationId: record.recommendationId,
              rationale: record.rationale,
              status: "recovery_required",
              recoveryReason: record.recoveryReason,
              executedAt: new Date().toISOString()
            });
            lastRecoveryRequiredCount++;
            return {
              success: false,
              status: 500,
              error: {
                code: "RECOVERY_REQUIRED",
                message: `Destination file was copied successfully, but source could not be removed: ${copyErr.message}. Operation marked as requiring recovery.`
              }
            };
          }
        }
      } else {
        record.status = "failed";
        await safeAppendJournalEntry({ ...record, status: "failed", error: renameErr.message }, options);
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

    // 12. Move succeeded: update record and journal status as 'completed'
    const executedAt = new Date().toISOString();
    record.status = "completed";
    record.executedAt = executedAt;
    record.undoAvailable = true;

    try {
      await recoveryJournal.appendJournalEntry({
        operationId: record.operationId,
        status: "completed",
        sourcePath: record.sourceRelative,
        destinationPath: record.destRelative,
        destinationDir: record.destDirRelative,
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        recommendationId: record.recommendationId,
        rationale: record.rationale,
        executedAt
      }, options);
    } catch (journalWriteErr) {
      // The file was moved on disk, but writing the completed record to the journal failed
      record.status = "recovery_required";
      record.recoveryReason = `File moved on disk, but journal write failed: ${journalWriteErr.message}`;
      operationHistory.unshift({
        operationId: record.operationId,
        sourcePath: record.sourceRelative,
        destinationPath: record.destRelative,
        destinationDir: record.destDirRelative,
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        recommendationId: record.recommendationId,
        rationale: record.rationale,
        status: "recovery_required",
        recoveryReason: `File moved on disk, but journal write failed: ${journalWriteErr.message}`,
        executedAt
      });
      lastRecoveryRequiredCount++;
      return {
        success: false,
        status: 500,
        error: {
          code: "JOURNAL_WRITE_FAILED",
          message: `File moved on disk, but failed to record completion to recovery journal: ${journalWriteErr.message}. Marked as recovery required.`
        }
      };
    }

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
  } finally {
    activeExecutionLocks.delete(cleanOpId);
  }
}

/**
 * Safely undos a completed file move by verifying destination integrity and restoring source location.
 * Revalidates that destination file exists, matches expected size, and original source path is unoccupied.
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

  const cleanOpId = operationId.trim();

  if (activeExecutionLocks.has(cleanOpId)) {
    return {
      success: false,
      status: 409,
      error: {
        code: "OPERATION_ALREADY_IN_PROGRESS",
        message: "Operation is currently active. Concurrent undo request is rejected."
      }
    };
  }

  const record = previewStore.get(cleanOpId);
  const historyItem = operationHistory.find((h) => h.operationId === cleanOpId);

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

  activeExecutionLocks.add(cleanOpId);

  try {
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

    let currentDestLstat;
    try {
      currentDestLstat = await fs.promises.lstat(currentFilePath);
    } catch {
      return {
        success: false,
        status: 400,
        error: {
          code: "INVALID_DESTINATION_FILE",
          message: "Unable to inspect file at destination."
        }
      };
    }

    if (currentDestLstat.isSymbolicLink() || !currentDestLstat.isFile()) {
      return {
        success: false,
        status: 400,
        error: {
          code: "NOT_A_REGULAR_FILE",
          message: "The entry at the destination is not a regular file."
        }
      };
    }

    // Detect if destination file was modified after the move (metadata size verification)
    if (typeof record.sizeBytes === "number" && currentDestLstat.size !== record.sizeBytes) {
      return {
        success: false,
        status: 409,
        error: {
          code: "DESTINATION_FILE_MODIFIED",
          message: `The file at the destination was modified after it was moved (expected ${record.sizeBytes} bytes, found ${currentDestLstat.size} bytes). Undo aborted to prevent data loss.`
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

    // 6. Move file back to original location
    try {
      await fs.promises.rename(currentFilePath, restoreSourcePath);
    } catch (renameErr) {
      if (renameErr.code === "EXDEV") {
        try {
          await fs.promises.copyFile(currentFilePath, restoreSourcePath, fs.constants.COPYFILE_EXCL);
          const restoredStat = await fs.promises.stat(restoreSourcePath);
          if (restoredStat.size !== record.sizeBytes) {
            throw new Error("Cross-device restored file size mismatch");
          }
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

    // 7. Update status and append to durable journal
    const undoneAt = new Date().toISOString();
    record.status = "undone";
    record.undoneAt = undoneAt;
    record.undoAvailable = false;
    historyItem.status = "undone";
    historyItem.undoneAt = undoneAt;
    historyItem.undoAvailable = false;

    try {
      await recoveryJournal.appendJournalEntry({
        operationId: record.operationId,
        status: "undone",
        sourcePath: record.sourceRelative,
        destinationPath: record.destRelative,
        destinationDir: record.destDirRelative,
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        undoneAt
      }, options);
    } catch (journalErr) {
      console.warn(`[Recovery Journal] Failed to append undo record for ${record.operationId}:`, journalErr.message);
    }

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
  } finally {
    activeExecutionLocks.delete(cleanOpId);
  }
}

/**
 * Resolves an operation that has been flagged as 'recovery_required'.
 * Requires explicit user confirmation; never modifies files automatically.
 *
 * @param {object} params
 * @param {string} params.operationId
 * @param {string} params.resolution - 'dismiss' or 'retry_unlink_source'
 * @param {object} [options={}]
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function resolveRecoveryOperation(params = {}, options = {}) {
  const { operationId, resolution } = params;

  if (typeof operationId !== "string" || !operationId.trim()) {
    return {
      success: false,
      status: 400,
      error: { code: "INVALID_OPERATION_ID", message: "Operation ID must be a non-empty string." }
    };
  }

  const cleanOpId = operationId.trim();
  const record = previewStore.get(cleanOpId);
  const historyItem = operationHistory.find((h) => h.operationId === cleanOpId);

  if (!record || !historyItem) {
    return {
      success: false,
      status: 404,
      error: { code: "OPERATION_NOT_FOUND", message: "Operation was not found in recovery records." }
    };
  }

  if (record.status !== "recovery_required" && historyItem.status !== "recovery_required") {
    return {
      success: false,
      status: 400,
      error: { code: "NOT_RECOVERY_REQUIRED", message: `Operation status is ${record.status}, not recovery_required.` }
    };
  }

  if (resolution === "dismiss") {
    // Acknowledge the recovery state and mark resolved
    record.status = "failed";
    historyItem.status = "failed";
    historyItem.recoveryResolvedAt = new Date().toISOString();

    await recoveryJournal.appendJournalEntry({
      operationId: record.operationId,
      status: "failed",
      sourcePath: record.sourceRelative,
      destinationPath: record.destRelative,
      destinationDir: record.destDirRelative,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      recoveryReason: "Manually dismissed by user."
    }, options);

    return {
      success: true,
      status: 200,
      data: {
        operationId: record.operationId,
        status: "failed",
        resolution: "dismissed"
      }
    };
  }

  return {
    success: false,
    status: 400,
    error: {
      code: "INVALID_RESOLUTION",
      message: "Unsupported recovery resolution. Allowed values: 'dismiss'."
    }
  };
}

/**
 * Returns the operation history of completed and recovery actions.
 * Never exposes approval tokens or absolute server paths.
 *
 * @param {object} [options={}]
 * @returns {object} History and recovery metrics
 */
function getOperationHistory(options = {}) {
  const history = operationHistory.map((item) => ({
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
    undoAvailable: Boolean(item.undoAvailable),
    recoveryReason: item.recoveryReason || null
  }));

  const recoveryRequiredCount = history.filter((h) => h.status === "recovery_required").length;

  return {
    history,
    recoveryRequiredCount,
    corruptedLinesCount: lastCorruptedLinesCount
  };
}

/**
 * Resets in-memory state for isolated test execution.
 */
function resetServiceState() {
  previewStore.clear();
  operationHistory = [];
  activeExecutionLocks.clear();
  lastCorruptedLinesCount = 0;
  lastRecoveryRequiredCount = 0;
}

module.exports = {
  previewOperation,
  executeOperation,
  undoOperation,
  resolveRecoveryOperation,
  getOperationHistory,
  initOrganizationService,
  resetServiceState,
  PREVIEW_EXPIRY_MS
};
