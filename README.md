# filoAI

**Less digital clutter. More peace of mind.**

filoAI is a privacy-first digital decluttering agent designed to help people understand and organize files safely. The application scans user-selected folders, detects identical files, uses local AI to recommend categories and destinations, and executes only explicitly approved operations.

> **Status: Phase 6 — Recovery and Security Hardening.** This repository contains the working foundation with secure read-only folder scanning, streaming SHA-256 duplicate detection, private local AI organization recommendations powered by Ollama and Gemma models, safe user-approved file organization with cryptographic single-use approval tokens, and a durable crash-resilient append-only recovery journal. Interrupted operations are detected on startup without automatically modifying files on disk.

## Goals

- Keep file analysis local wherever practical.
- Make recommendations understandable and reviewable.
- Require explicit user approval before changing any file on disk.
- Never overwrite existing files under any circumstance.
- Avoid automatic deletion and destructive bulk operations.
- Record operations in a durable local recovery journal and support safe undo.
- Make the project approachable for open-source contributors.

## Project Structure

```text
filoAI/
├── backend/
│   ├── app.js                      # Express application setup and middleware
│   ├── server.js                   # Server initialization and startup journal audit
│   ├── routes/
│   │   ├── duplicateRoutes.js      # POST /api/duplicates
│   │   ├── healthRoutes.js         # GET /api/health
│   │   ├── organizationRoutes.js   # POST /api/organization/preview, execute, undo, recover, history
│   │   ├── recommendationRoutes.js # GET /api/recommendations/status, POST /api/recommendations
│   │   └── scanRoutes.js           # GET /api/scan/config, POST /api/scan
│   └── services/
│       ├── duplicateService.js     # Streaming SHA-256 hashing and candidate grouping
│       ├── organizationService.js  # Preview, approval tokens, atomic moves, undo, and concurrency
│       ├── recommendationService.js # Local Ollama/Gemma integration and schema validation
│       ├── recoveryJournal.js      # Durable append-only recovery journal and startup crash recovery
│       └── scanService.js          # Bounded read-only scanning & path validation
├── frontend/
│   ├── index.html                  # Industrial-dark dashboard with organization workstation
│   ├── css/
│   │   └── style.css               # Design system, layout, and responsive styles
│   └── js/
│       └── app.js                  # Connectivity, scanning, recommendations, and approval workflow
├── tests/
│   ├── duplicate.test.js           # Streaming SHA-256 and duplicate detection tests
│   ├── health.test.js              # Health and 404 tests
│   ├── organization.test.js        # Preview, approval token, conflict, undo, and security tests
│   ├── recommendations.test.js     # Ollama integration, privacy, and schema validation tests
│   └── scan.test.js                # Scan security, containment, and metadata tests
├── .github/
│   └── workflows/
│       └── ci.yml                  # GitHub Actions CI workflow (npm ci & npm test)
├── .env.example                    # Environment variable template
├── .gitignore                      # Git ignore rules (node_modules, .env, workspaces)
├── LICENSE                         # MIT License
├── CONTRIBUTING.md                 # Contribution guidelines
└── README.md                       # Project documentation
```

## Technology

- Node.js (v20+)
- Express
- HTML, CSS, and vanilla JavaScript
- Node.js built-in test runner (`node:test`, `node:assert`)
- Planned: Ollama with a compatible Gemma model

## Requirements

- Node.js 20 or later
- npm

## Getting Started

1. Clone and install dependencies:

```bash
git clone https://github.com/VipinKumar04/FiloAI.git
cd FiloAI
npm install
```

2. Run automated tests:

```bash
npm test
```

3. Start the application:

```bash
npm start
```

Open <http://localhost:3000> in your browser.

For local development with Node's watch mode:

```bash
npm run dev
```

## Directory Selection & Scanning (Phase 2)

### How Directory Selection Works

Modern web browsers do not allow web pages to read arbitrary server-side filesystem paths via file input dialogs due to standard browser sandboxing. Because filoAI runs as a local web server:

1. **Approved Root Principle**: To prevent unauthorized access to sensitive system directories, scanning is strictly confined to an explicitly approved root directory (`FILO_SCAN_ROOT`).
2. **Default Workspace**: When `FILO_SCAN_ROOT` is not configured, the backend defaults to a local `./scan-workspace/` directory within the project, which is safe and isolated.
3. **Subfolder Scans**: The dashboard allows the user to specify relative subpaths (e.g., `.` for the entire approved root, or subdirectories like `documents/inbox`).
4. **Strict Containment Verification**: Every requested path is resolved with `path.resolve` and verified using canonical paths (`fs.realpathSync`). Any attempt to traverse upward (`..`), access parent directories, follow external symlinks, or switch drives is rejected.

### Configuring the Approved Scan Root

You can configure the approved root by setting the `FILO_SCAN_ROOT` environment variable or defining it in a local `.env` file:

```env
# Example .env configuration
PORT=3000
FILO_SCAN_ROOT=C:/Users/username/Documents/DeclutterFolder
FILO_MAX_FILES=2000
```

### Running a Scan

1. **From the Dashboard**:
   - Open <http://localhost:3000>.
   - Check the **Approved Scan Root** banner in the Source panel.
   - Enter `.` or a subfolder name in the path input.
   - Click **Scan directory**.
   - Real statistics (files, directories, total size) and the complete file table will render.

2. **Via API**:
   - `GET /api/scan/config` — Returns public scan configuration and the active root name.
   - `POST /api/scan` — Scans the requested path:

   **Request Body**:
   ```json
   {
     "path": "."
   }
   ```

   **Success Response (HTTP 200)**:
   ```json
   {
     "success": true,
     "data": {
       "files": [
         {
           "name": "report.pdf",
           "relativePath": "docs/report.pdf",
           "extension": ".pdf",
           "sizeBytes": 1048576,
           "lastModified": "2026-10-22T00:00:00.000Z",
           "type": "file"
         }
       ],
       "summary": {
         "totalFiles": 1,
         "totalDirectories": 1,
         "totalSizeBytes": 1048576,
         "scanDurationMs": 14,
         "isTruncated": false,
         "maxFilesLimit": 2000
       }
     }
   }
   ```

   **Error Response (HTTP 400 / 403 / 404)**:
   ```json
   {
     "success": false,
     "error": {
       "code": "OUTSIDE_APPROVED_ROOT",
       "message": "Access denied: The requested path is outside the approved scan root."
     }
   }
   ```

### Metadata Collected

During read-only scanning, filoAI collects:
- **File Name**: The base filename (`name`).
- **Relative Path**: Normalized path relative to the scanned directory (`relativePath`). Absolute OS paths are never exposed to the client.
- **Extension**: Normalized lowercase extension (`extension`).
- **Size**: File size in bytes (`sizeBytes`).
- **Last Modified**: File timestamp in ISO 8601 format (`lastModified`).
- **Type**: Entry type (`"file"` or `"directory"`).

### Security Restrictions & Safeguards

- **Read-Only**: The scanner does not modify, move, rename, or delete any files.
- **Bounded Resource Limits**: Scans are bounded by `maxFiles` (default 2,000) and `maxDepth` (default 15) to prevent accidental memory exhaustion on large directory trees. Truncation is clearly signaled in the API and UI.
- **Path Traversal Protection**: Rejects null bytes, `..` traversals, and non-canonical paths outside the approved root.
- **Symlink Boundary Checks**: Symbolic links pointing outside the approved root are detected and skipped.
- **Graceful Error Handling**: Missing paths, permission errors (`EACCES`), and files deleted during a scan are caught gracefully without crashing the server.

### Platform Limitations

- **Browser-Host Separation**: In standard web mode, the browser cannot browse arbitrary host directories without manual path entry or setting `FILO_SCAN_ROOT`. Future desktop builds (e.g., Electron or Tauri) will enable native OS file dialogs.
- **Symlinks on Windows**: Symlink creation requires Developer Mode or elevated privileges on certain Windows configurations; symlink containment validation is active across all platforms.
- **Filesystem Race Conditions (TOCTOU)**: While the scanner applies `lstat` pre-checks, pre-traversal containment verification, cycle tracking, and external symlink skipping, standard Node.js userland APIs cannot provide kernel-level directory descriptor locking against hostile concurrent filesystem processes swapping parent directories mid-scan. filoAI is designed as a personal, local-first utility for user-approved directories rather than a multi-tenant hardened sandbox.

## Duplicate Detection (Phase 3)

### How Duplicate Detection Works

filoAI uses a multi-tier, streaming detection pipeline designed for high performance and minimal memory consumption:

1. **Candidate Grouping by Size**: Files of different byte lengths cannot contain identical data. filoAI groups cataloged files by size first. Files with unique sizes are skipped immediately, saving disk I/O and CPU cycles.
2. **Streaming SHA-256 Hashing**: For files sharing identical sizes (including 0-byte empty files), SHA-256 hashes are computed using Node.js `crypto` and `fs.createReadStream`. Files are never loaded entirely into memory, allowing large files to be processed safely.
3. **Bounded Concurrency**: File hashing runs through an internal worker pool (`HASH_CONCURRENCY = 4`) to prevent file descriptor exhaustion (`EMFILE`) or system thrashing.
4. **Candidate Role Distinction**: filoAI identifies identical files and displays the earliest detected copy as `PRIMARY CANDIDATE` and additional copies as `DUPLICATE COPY`. Crucially, filoAI treats this as a neutral reference without claiming that any copy is definitively the "correct" original.
5. **Reclaimable Space Calculation**: filoAI computes the exact potential space savings: `(redundantCopies) * sizeBytes` for each duplicate group.
6. **Strictly Read-Only**: filoAI never modifies, moves, renames, or deletes any files during duplicate detection.

### API: POST /api/duplicates

Analyzes the approved folder or subfolder and returns duplicate groups.

**Request Body**:
```json
{
  "path": "."
}
```

**Success Response (HTTP 200)**:
```json
{
  "success": true,
  "data": {
    "duplicateGroups": [
      {
        "hash": "c6f33cf9a4d84316443018599cc8e7e1dfec6b682ceacdb80bcd902e954fa61a",
        "sizeBytes": 117,
        "count": 2,
        "redundantCopies": 1,
        "reclaimableBytes": 117,
        "files": [
          {
            "name": "project-plan.md",
            "relativePath": "documents/project-plan.md",
            "extension": ".md",
            "sizeBytes": 117,
            "lastModified": "2026-10-21T19:06:56.288Z",
            "role": "primary_candidate",
            "isPrimaryCandidate": true
          },
          {
            "name": "project-plan-backup.md",
            "relativePath": "documents/project-plan-backup.md",
            "extension": ".md",
            "sizeBytes": 117,
            "lastModified": "2026-10-22T17:42:33.397Z",
            "role": "duplicate_copy",
            "isPrimaryCandidate": false
          }
        ]
      }
    ],
    "summary": {
      "totalDuplicateGroups": 1,
      "totalDuplicateFiles": 2,
      "totalRedundantCopies": 1,
      "reclaimableBytes": 117,
      "totalScannedFiles": 4,
      "totalScannedDirectories": 2,
      "totalCandidateFiles": 2,
      "skippedFilesCount": 0,
      "skippedFiles": [],
      "isTruncated": false,
      "scanDurationMs": 28,
      "maxFilesLimit": 2000
    }
  }
}
```

**Security and Error Responses**:
- `400 Bad Request` (`PATH_TRAVERSAL_DETECTED` / `NOT_A_DIRECTORY` / `INVALID_DIRECTORY`): Returned for null bytes, non-directory targets, or malformed inputs.
- `403 Forbidden` (`OUTSIDE_APPROVED_ROOT`): Returned for path traversal (`../`) or absolute paths attempting to escape the approved root.
- `404 Not Found` (`DIRECTORY_NOT_FOUND`): Returned if the scan target or approved root does not exist.

## Local AI Recommendations (Phase 4)

filoAI generates intelligent organization suggestions using a local LLM via [Ollama](https://ollama.com/), defaulting to Google's lightweight `gemma2:2b` model.

### Privacy Guarantees & Safeguards

- **Metadata Only**: Only filenames, relative subpaths, file extensions, byte sizes, and duplicate metrics are sent to the model. File contents are **never** opened, read, or transmitted.
- **Strictly Local**: Analysis executes entirely on your machine via Ollama HTTP API (`http://127.0.0.1:11434`). filoAI never connects or silently falls back to any remote cloud AI provider.
- **Untrusted Model Output**: Filenames and model responses are treated as untrusted data. Responses are validated against a strict JSON schema.
- **Anti-Hallucination Path Validation**: Every file path returned in an AI recommendation is validated against the cataloged files in the approved scan root. Any hallucinated or invalid path is discarded.
- **Zero Execution or Code Running**: AI recommendations cannot execute code, scripts, or automated filesystem actions.
- **Human Approval Always**: Recommendations are purely advisory. They do not alter, move, rename, or delete files.

### Ollama Setup & Model Installation

1. Install Ollama:
   Download and install from [ollama.com](https://ollama.com/).

2. Download a compatible Gemma model:
   ```bash
   ollama pull gemma2:2b
   ```

3. Ensure Ollama is running:
   ```bash
   ollama serve
   ```
   (On macOS and Windows, the Ollama desktop app runs the service automatically).

### Configuration

Set configuration variables in your environment or local `.env` file:

```env
# Ollama base URL (defaults to http://127.0.0.1:11434)
OLLAMA_BASE_URL=http://127.0.0.1:11434

# Model name (defaults to gemma2:2b)
OLLAMA_MODEL=gemma2:2b

# Request timeout in milliseconds (defaults to 30000)
OLLAMA_TIMEOUT_MS=30000
```

### Recommendation API

#### Check Ollama Readiness
`GET /api/recommendations/status`

**Response (HTTP 200)**:
```json
{
  "success": true,
  "data": {
    "available": true,
    "model": "gemma2:2b",
    "modelInstalled": true,
    "installedModels": ["gemma2:2b"],
    "baseUrl": "http://127.0.0.1:11434"
  }
}
```

#### Generate Recommendations
`POST /api/recommendations`

**Request Body**:
```json
{
  "path": "."
}
```

**Success Response (HTTP 200)**:
```json
{
  "success": true,
  "data": {
    "recommendations": [
      {
        "id": "rec_1",
        "type": "type_grouping",
        "title": "Group Financial Invoices",
        "explanation": "Collect related PDF invoice files into a dedicated finance folder.",
        "relevantPaths": [
          "documents/invoice_2026_01.pdf",
          "documents/invoice_2026_02.pdf"
        ],
        "confidence": "high",
        "requiresReview": true
      }
    ],
    "model": "gemma2:2b",
    "summary": {
      "totalRecommendations": 1,
      "totalFilesScanned": 8,
      "ollamaDurationMs": 1420,
      "totalDurationMs": 1450
    }
  }
}
```

**Error Responses**:
- `503 Service Unavailable` (`OLLAMA_UNAVAILABLE`): Ollama is not running on the configured host/port.
- `404 Not Found` (`MODEL_NOT_FOUND`): The configured model has not been downloaded in Ollama yet.
- `504 Gateway Timeout` (`OLLAMA_TIMEOUT`): Ollama inference exceeded the configured timeout limit.
- `502 Bad Gateway` (`INVALID_MODEL_OUTPUT`): The model returned unparseable or malformed output.
- `403 Forbidden` (`OUTSIDE_APPROVED_ROOT`): The requested directory path is outside the approved root.

## Safe User-Approved File Organization (Phase 5)

filoAI enforces an uncompromising human-in-the-loop guarantee: **no file may ever be moved, renamed, overwritten, or deleted without explicit human approval.** AI recommendations generated in Phase 4 are strictly advisory.

### The Two-Phase Approval Workflow

```text
[ AI Advisory / User Selection ]
               │
               ▼
   POST /api/organization/preview
               │
   ┌───────────┴───────────┐
   │ Check Root Containment│
   │ Verify Regular File   │
   │ Detect Name Conflicts │
   │ Issue Approval Token  │
   └───────────┬───────────┘
               │ (Strictly Read-Only — 0 disk changes)
               ▼
[ Human Review in Dashboard ]
   - Source & Target Paths
   - Conflict Warning Badge
   - Rationale / Recommendation
               │
      ┌────────┴────────┐
      ▼                 ▼
  [ Cancel ]      [ Approve Move ]
                        │
                        ▼
            POST /api/organization/execute
                        │
            ┌───────────┴───────────┐
            │ Validate Time & Token │
            │ Revalidate Source Size│
            │ Re-verify No Conflict │
            │ Safe Atomic Relocation│
            │ Record to History Log │
            └───────────┬───────────┘
                        ▼
            [ Operation Recorded with Undo ]
```

1. **Step 1: Preview (Strictly Read-Only)**
   - The user selects a file from an AI recommendation or manually enters a source file and destination subdirectory inside the approved root.
   - The backend validates path containment inside the canonical root (`fs.realpathSync`), confirms the source is an eligible regular file (rejecting directories, device nodes, and symlinks), and inspects the target location for naming collisions.
   - The server creates a temporary preview record with a cryptographically random `operationId` (`op_...`) and high-entropy `approvalToken` (valid for 15 minutes).
   - If a file already exists at the proposed destination, `conflict: true` is flagged and execution is locked.
   - **Zero filesystem modifications occur during preview.**

2. **Step 2: Explicit Human Review**
   - The dashboard presents the proposed source path, target path, file size, recommendation rationale, and a prominent conflict indicator.
   - If a conflict is present, the **Approve** button is disabled, making accidental overwrites impossible.
   - The user must explicitly click **Approve & Move File** or **Cancel preview**. Merely viewing recommendations or clicking "Generate recommendations" never triggers a move.

3. **Step 3: Cryptographically Validated Execution**
   - The client submits `operationId` and `approvalToken` to `POST /api/organization/execute`.
   - The server verifies:
     - The operation exists and is in `previewed` state (rejecting repeated or replayed executions).
     - The token has not expired (`expiresAt > Date.now()`).
     - The token matches the server record using constant-time timing-safe comparison (`crypto.timingSafeEqual`).
     - Source, destination directory, and destination path all remain strictly inside the canonical approved root.
     - The source file still exists and its size matches the previewed snapshot (rejecting modified or tampered files).
     - The destination file **does not exist** (strictly preventing overwriting).
     - The source file is not a symbolic link.
   - The file is atomically moved to the destination subfolder (`fs.promises.rename`, with fallback to exclusive copy `COPYFILE_EXCL` and unlink for cross-device filesystems).
   - The result is saved to an in-memory operation history with relative paths.

4. **Step 4: Safe Undo & Recovery**
   - The user can review the history of completed operations and request an undo for any completed move.
   - Before undoing:
     - The backend verifies that the moved file still exists at the destination location.
     - The backend verifies that the original source path is **unoccupied** (preventing overwriting any new file placed there in the interim).
     - If both checks pass, the file is moved back to its original location.

### Organization API Contracts

#### 1. Preview Proposed Move

- **Endpoint**: `POST /api/organization/preview`
- **Request Body**:
  ```json
  {
    "sourcePath": "inbox/quarterly_report.pdf",
    "destinationDir": "documents/reports",
    "recommendationId": "rec_1",
    "rationale": "Group financial reports into the documents folder."
  }
  ```
- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "data": {
      "operationId": "op_9f8b417c82a1d30e",
      "approvalToken": "7b82f1...c289",
      "sourcePath": "inbox/quarterly_report.pdf",
      "destinationPath": "documents/reports/quarterly_report.pdf",
      "destinationDir": "documents/reports",
      "fileName": "quarterly_report.pdf",
      "sizeBytes": 245760,
      "conflict": false,
      "conflictReason": null,
      "canExecute": true,
      "expiresAt": "2026-10-22T18:30:00.000Z",
      "recommendationId": "rec_1",
      "rationale": "Group financial reports into the documents folder."
    }
  }
  ```

#### 2. Execute Approved Move

- **Endpoint**: `POST /api/organization/execute`
- **Request Body**:
  ```json
  {
    "operationId": "op_9f8b417c82a1d30e",
    "approvalToken": "7b82f1...c289"
  }
  ```
- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "data": {
      "operationId": "op_9f8b417c82a1d30e",
      "status": "completed",
      "sourcePath": "inbox/quarterly_report.pdf",
      "destinationPath": "documents/reports/quarterly_report.pdf",
      "destinationDir": "documents/reports",
      "fileName": "quarterly_report.pdf",
      "executedAt": "2026-10-22T18:16:45.123Z",
      "undoAvailable": true
    }
  }
  ```

#### 3. Undo Move Operation

- **Endpoint**: `POST /api/organization/undo`
- **Request Body**:
  ```json
  {
    "operationId": "op_9f8b417c82a1d30e"
  }
  ```
- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "data": {
      "operationId": "op_9f8b417c82a1d30e",
      "status": "undone",
      "sourcePath": "inbox/quarterly_report.pdf",
      "destinationPath": "documents/reports/quarterly_report.pdf",
      "undoneAt": "2026-10-22T18:17:10.500Z"
    }
  }
  ```

#### 4. Operation History

- **Endpoint**: `GET /api/organization/history`
- **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "data": {
      "history": [
        {
          "operationId": "op_9f8b417c82a1d30e",
          "sourcePath": "inbox/quarterly_report.pdf",
          "destinationPath": "documents/reports/quarterly_report.pdf",
          "destinationDir": "documents/reports",
          "fileName": "quarterly_report.pdf",
          "sizeBytes": 245760,
          "recommendationId": "rec_1",
          "rationale": "Group financial reports into the documents folder.",
          "status": "completed",
          "executedAt": "2026-10-22T18:16:45.123Z",
          "undoneAt": null,
          "undoAvailable": true
        }
      ]
    }
  }
  ```

### Filesystem Safety Guarantees & Operating System Limitations

- **Strict Overwrite Prohibition**: filoAI never overwrites existing destination files during execute or restore. If any file exists at the target path, the operation is blocked with HTTP 409 `DESTINATION_CONFLICT` or `SOURCE_RESTORE_CONFLICT`.
- **Approved Root Containment**: Every path is validated with canonical resolution. Subpaths attempting `..` directory traversal, absolute server paths, or escaping symlinks are rejected with HTTP 403 `OUTSIDE_APPROVED_ROOT`.
- **Regular Files Only**: Directories, named pipes, sockets, and symbolic links cannot be organized or targeted.
- **Race Condition Limitations (TOCTOU)**: While filoAI applies strict pre-checks and immediate re-validation right before moving files, standard userland Node.js applications cannot guarantee absolute transactional atomicity against hostile concurrent operating-system processes (e.g., another process creating a file at the exact millisecond between existence check and file rename). filoAI is designed for user-controlled personal file management, where non-destructive safety checks minimize risks.

## Operation Recovery & Security Hardening (Phase 6)

### Durable Append-Only Recovery Journal

To guarantee crash resilience without requiring an external database, filoAI maintains a local, append-only recovery journal formatted in JSON Lines (`.jsonl`).

- **Journal Location**: Stored by default at `./data/filo-recovery-journal.jsonl` (or configured via `FILO_JOURNAL_PATH`). The `./data/` directory is strictly excluded from Git tracking via `.gitignore`.
- **Append-Only Safety**: Every state transition (`executing`, `completed`, `undone`, `failed`, `recovery_required`) is written as an immutable JSON line using `fs.promises.appendFile`. If the Node.js process terminates or power is lost mid-write, existing valid lines are never overwritten or corrupted.
- **Privacy & Security Bounding**:
  - Approval tokens and session secrets are **strictly excluded** from journal records.
  - Only normalized relative subpaths inside the approved scan root are stored; absolute server paths are stripped.
  - Journal lines are bounded to 64 KB per line and strictly validated against the internal schema before recording or processing. Malformed or oversized lines are safely bypassed without breaking history.

### Startup Crash & Interruption Audit

When the server starts (`server.js`), `initOrganizationService()` audits the recovery journal:
1. **Pre-execution Logging**: Before attempting any rename or copy on disk, the operation logs an `executing` state record to the journal.
2. **Crash Detection**: On application boot, any operation whose latest recorded status is `executing` was interrupted by an ungraceful shutdown or crash.
3. **Non-Destructive Diagnostic**: filoAI inspects the filesystem to determine whether the file exists at the source, destination, both, or neither.
4. **Absolute Safety Guarantee**: **Startup recovery NEVER automatically moves, deletes, restores, or cleans up files on disk.** Automatic disk mutations during boot risk data loss if external files have changed. Instead, the operation is flagged as `recovery_required` and presented to the user on the dashboard.

### User-Reviewed Recovery Workflow

When an operation requires recovery:
- The dashboard highlights the operation with a prominent amber alert banner and a `RECOVERY REQUIRED` badge.
- The user can review the exact diagnosis (e.g., `Destination file copied, but source could not be deleted`).
- The user can explicitly resolve the alert by clicking **Review & Dismiss** (`POST /api/organization/recover` with `{ "operationId": "...", "resolution": "dismiss" }`).
- Dismissing records a `recovery_resolved` entry in the journal. No automated unapproved bulk deletions are ever performed.

### Hardened Move Execution & Cross-Device Handling

- **Same-Filesystem Moves**: Conducted atomically using `fs.promises.rename`.
- **Cross-Device Fallback (`EXDEV`)**: When source and destination reside on different mounts or partitions, `rename` fails with `EXDEV`. filoAI falls back to a verified multi-step transfer:
  1. Copies the file using `fs.promises.copyFile` with exclusive mode (`COPYFILE_EXCL`), guaranteeing the destination is never overwritten.
  2. Verifies the destination file size against the original source file.
  3. Unlinks the original source file only after destination integrity is verified.
  4. If copy fails partway through, the source remains intact and any partial destination file is cleaned up.
  5. If copy succeeds but source unlinking fails, both copies are preserved and the operation transitions to `recovery_required`.

### Hardened Undo Verification

Before reversing any operation:
- Verifies the destination file still exists and is a regular file.
- Verifies destination file size matches the size recorded during the move to detect whether the file was edited or modified by another application (`DESTINATION_FILE_MODIFIED`).
- Verifies the original source location is completely unoccupied (`SOURCE_RESTORE_CONFLICT`).
- Never overwrites any file during undo.

### Concurrency Protection

Concurrent execution requests for the same `operationId` are prevented using active execution locks (`activeExecutionLocks` set). Duplicate simultaneous requests return HTTP 409 `OPERATION_ALREADY_IN_PROGRESS`.

### Known Operating System Limitations & TOCTOU

While filoAI enforces strict pre-checks, immediate revalidation, and single-use cryptographic tokens:
- Portable Node.js APIs cannot eliminate all kernel-level Time-Of-Check to Time-Of-Use (TOCTOU) race conditions if external hostile processes concurrently alter directories during an operation.
- Operating systems without atomic cross-device renames require two-phase copy-and-unlink, which filoAI hardens with size checks and journaled recovery states.

## Current Functionality

- Express server with health, scan, duplicate, recommendation, and organization endpoints
- Responsive industrial-dark dashboard with real-time status and telemetry
- Secure read-only folder scanning with path traversal protection
- Streaming SHA-256 duplicate detection with candidate size pre-grouping
- Duplicate group cards with hash badges, role differentiation, and reclaimable bytes
- Local AI recommendations using Ollama and Gemma with schema enforcement and anti-hallucination validation
- Safe user-approved file organization with preview, conflict detection, cryptographic approval tokens, and execution logging
- Durable, append-only recovery journal (`.jsonl`) with crash resilience and startup interruption audit
- Safe startup recovery audit that **never modifies, moves, or deletes files automatically**
- Safe undo and recovery workflow preventing accidental overwrites and modifications
- Real file metadata listing with formatting and sorting
- Automated test suite (63 unit and integration tests passing)
- GitHub Actions CI workflow

## Roadmap

- [x] Initial project foundation and CI workflow (Phase 1)
- [x] Secure selection and scanning of a user-approved folder (Phase 2)
- [x] File metadata listing and dashboard statistics (Phase 2)
- [x] SHA-256 duplicate detection (Phase 3)
- [x] Local Ollama/Gemma integration (Phase 4)
- [x] Structured AI organization recommendations (Phase 4)
- [x] Safe, user-approved file organization with preview and conflict detection (Phase 5)
- [x] Operation history and safe undo (Phase 5)
- [x] Recovery journal and security hardening (Phase 6)
- [ ] Validated batch organization with review queue (Phase 7)
- [ ] Duplicate resolution and safe archiving (Phase 8)
- [ ] Expanded desktop integration and file system watchers (Phase 9)

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
