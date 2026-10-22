const fs = require("node:fs");
const path = require("node:path");

const VALID_STATUSES = new Set([
  "previewed",
  "executing",
  "completed",
  "undone",
  "failed",
  "recovery_required"
]);

const MAX_JOURNAL_LINE_BYTES = 64 * 1024; // 64 KB safety limit per line

/**
 * Resolves the path to the durable recovery journal file.
 *
 * @param {object} [options={}]
 * @param {string} [options.journalPath] - Explicit path override
 * @returns {string} Absolute path to the journal file
 */
function getJournalPath(options = {}) {
  if (options.journalPath && typeof options.journalPath === "string") {
    return path.resolve(options.journalPath);
  }
  if (process.env.FILO_JOURNAL_PATH && typeof process.env.FILO_JOURNAL_PATH === "string") {
    return path.resolve(process.env.FILO_JOURNAL_PATH);
  }
  return path.resolve(process.cwd(), "data", "filo-recovery-journal.jsonl");
}

/**
 * Validates and sanitizes a journal entry before writing or after reading.
 * Ensures no approval tokens or absolute server paths are persisted.
 *
 * @param {object} raw - Entry to validate
 * @returns {object|null} Sanitized entry or null if invalid
 */
function validateJournalEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const operationId = raw.operationId;
  const status = raw.status;
  const sourcePath = raw.sourcePath || raw.sourceRelative;
  const destinationPath = raw.destinationPath || raw.destRelative;
  const destinationDir = raw.destinationDir || raw.destDirRelative;
  const fileName = raw.fileName;
  const sizeBytes = raw.sizeBytes;
  const recommendationId = raw.recommendationId;
  const rationale = raw.rationale;
  const executedAt = raw.executedAt;
  const undoneAt = raw.undoneAt;
  const recoveryReason = raw.recoveryReason;
  const error = raw.error;
  const timestamp = raw.timestamp;

  // Validate operation ID
  if (typeof operationId !== "string" || !/^op_[a-zA-Z0-9_-]+$/.test(operationId.trim())) {
    return null;
  }

  // Validate status
  if (typeof status !== "string" || !VALID_STATUSES.has(status.trim())) {
    return null;
  }

  // Validate relative paths (must not be empty, must not escape or contain null bytes)
  if (typeof sourcePath !== "string" || !sourcePath.trim() || sourcePath.includes("\0") || sourcePath.includes("..")) {
    return null;
  }

  if (typeof destinationPath !== "string" || !destinationPath.trim() || destinationPath.includes("\0") || destinationPath.includes("..")) {
    return null;
  }

  // Never allow approvalToken or absolute paths to be stored
  const sanitized = {
    timestamp: typeof timestamp === "string" ? timestamp : new Date().toISOString(),
    operationId: operationId.trim(),
    status: status.trim(),
    sourcePath: sourcePath.trim().replace(/\\/g, "/"),
    destinationPath: destinationPath.trim().replace(/\\/g, "/"),
    destinationDir: typeof destinationDir === "string" ? destinationDir.trim().replace(/\\/g, "/") : path.dirname(destinationPath).replace(/\\/g, "/"),
    fileName: typeof fileName === "string" ? fileName.trim() : path.basename(sourcePath),
    sizeBytes: typeof sizeBytes === "number" && sizeBytes >= 0 ? sizeBytes : null,
    recommendationId: typeof recommendationId === "string" ? recommendationId.trim() : null,
    rationale: typeof rationale === "string" ? rationale.trim() : null,
    executedAt: typeof executedAt === "string" ? executedAt : null,
    undoneAt: typeof undoneAt === "string" ? undoneAt : null,
    recoveryReason: typeof recoveryReason === "string" ? recoveryReason.trim() : null,
    error: typeof error === "string" ? error.trim() : null
  };

  return sanitized;
}

/**
 * Safely appends an entry to the recovery journal.
 * Uses append-only JSONL format to prevent corrupting previous records.
 *
 * @param {object} entry - Entry data to record
 * @param {object} [options={}] - Options including journalPath
 * @returns {Promise<boolean>} True if appended successfully
 */
async function appendJournalEntry(entry, options = {}) {
  const sanitized = validateJournalEntry(entry);
  if (!sanitized) {
    throw new Error("Invalid journal entry: schema validation failed.");
  }

  const journalPath = getJournalPath(options);
  const journalDir = path.dirname(journalPath);

  try {
    await fs.promises.mkdir(journalDir, { recursive: true });
    const line = JSON.stringify(sanitized) + "\n";
    await fs.promises.appendFile(journalPath, line, "utf8");
    return true;
  } catch (err) {
    throw new Error(`Failed to write to recovery journal: ${err.message}`);
  }
}

/**
 * Reads all entries from the recovery journal.
 * Gracefully isolates and skips corrupt or malformed lines.
 *
 * @param {object} [options={}] - Options including journalPath
 * @returns {Promise<{ entries: Array<object>, corruptedLinesCount: number, journalPath: string }>}
 */
async function readJournalEntries(options = {}) {
  const journalPath = getJournalPath(options);

  if (!fs.existsSync(journalPath)) {
    return {
      entries: [],
      corruptedLinesCount: 0,
      journalPath
    };
  }

  let content;
  try {
    content = await fs.promises.readFile(journalPath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read recovery journal: ${err.message}`);
  }

  const lines = content.split(/\r?\n/);
  const entries = [];
  let corruptedLinesCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) {
      continue; // Skip blank lines
    }

    if (Buffer.byteLength(rawLine, "utf8") > MAX_JOURNAL_LINE_BYTES) {
      corruptedLinesCount++;
      continue; // Reject oversized lines
    }

    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      corruptedLinesCount++;
      continue; // Skip malformed JSON
    }

    const validated = validateJournalEntry(parsed);
    if (!validated) {
      corruptedLinesCount++;
      continue; // Skip schema-invalid objects
    }

    entries.push(validated);
  }

  return {
    entries,
    corruptedLinesCount,
    journalPath
  };
}

/**
 * Loads the recovery journal on startup and audits operations.
 * Detects operations that were interrupted during execution and transitions them to 'recovery_required'.
 * NEVER moves, deletes, or modifies files on disk during recovery.
 *
 * @param {object} [options={}] - Options including canonicalRoot and journalPath
 * @returns {Promise<{ operations: Map<string, object>, history: Array<object>, recoveryRequiredCount: number, corruptedLinesCount: number }>}
 */
async function loadAndRecoverJournal(options = {}) {
  const { entries, corruptedLinesCount } = await readJournalEntries(options);

  // Group latest entry by operationId
  const operationsMap = new Map();

  for (const entry of entries) {
    operationsMap.set(entry.operationId, { ...entry });
  }

  let recoveryRequiredCount = 0;
  const canonicalRoot = options.canonicalRoot || null;

  for (const [opId, op] of operationsMap.entries()) {
    // Check if operation was left in 'executing' state (interrupted process crash/shutdown)
    if (op.status === "executing") {
      let diagnosis = "Operation was interrupted before completion.";

      if (canonicalRoot && fs.existsSync(canonicalRoot)) {
        const fullSource = path.resolve(canonicalRoot, op.sourcePath);
        const fullDest = path.resolve(canonicalRoot, op.destinationPath);

        const sourceExists = fs.existsSync(fullSource);
        const destExists = fs.existsSync(fullDest);

        if (destExists && !sourceExists) {
          diagnosis = "Interrupted after move: File exists at destination, but completion was not journaled.";
        } else if (sourceExists && !destExists) {
          diagnosis = "Interrupted before move: Source file is intact at original location.";
        } else if (sourceExists && destExists) {
          diagnosis = "Interrupted during cross-device copy: File exists at both source and destination.";
        } else {
          diagnosis = "Interrupted: File was not found at either source or destination.";
        }
      }

      // Mark operation as recovery_required
      const recoveredRecord = {
        ...op,
        status: "recovery_required",
        recoveryReason: diagnosis,
        timestamp: new Date().toISOString()
      };

      operationsMap.set(opId, recoveredRecord);
      recoveryRequiredCount++;

      // Persist the recovery_required status to the journal (without modifying files on disk)
      try {
        await appendJournalEntry(recoveredRecord, options);
      } catch (appendErr) {
        // Log warning if journal append fails
        console.warn(`[Recovery Journal] Failed to persist recovery status for ${opId}:`, appendErr.message);
      }
    } else if (op.status === "recovery_required") {
      recoveryRequiredCount++;
    }
  }

  // Convert map to history list sorted descending by timestamp
  const history = Array.from(operationsMap.values()).sort((a, b) => {
    const tA = new Date(a.executedAt || a.timestamp || 0).getTime();
    const tB = new Date(b.executedAt || b.timestamp || 0).getTime();
    return tB - tA;
  });

  return {
    operations: operationsMap,
    history,
    recoveryRequiredCount,
    corruptedLinesCount
  };
}

module.exports = {
  getJournalPath,
  validateJournalEntry,
  appendJournalEntry,
  readJournalEntries,
  loadAndRecoverJournal,
  VALID_STATUSES,
  MAX_JOURNAL_LINE_BYTES
};
