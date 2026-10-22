# filoAI

**Less digital clutter. More peace of mind.**

filoAI is a privacy-first digital decluttering agent designed to help people understand and organize files safely. The application scans user-selected folders, detects identical files, uses local AI to recommend categories and destinations, and executes only explicitly approved operations.

> **Status: Phase 3 — SHA-256 Duplicate Detection.** This repository contains the working foundation with secure, read-only folder scanning, bounded traversal, path-traversal protection, streaming SHA-256 duplicate detection, and real-time dashboard telemetry. AI recommendations and file operations will follow in subsequent phases.

## Goals

- Keep file analysis local wherever practical.
- Make recommendations understandable and reviewable.
- Require user approval before changing files.
- Avoid automatic deletion.
- Record operations and support safe undo where possible.
- Make the project approachable for open-source contributors.

## Project Structure

```text
filoAI/
├── backend/
│   ├── app.js                      # Express application setup and middleware
│   ├── server.js                   # Server initialization and port listening
│   ├── routes/
│   │   ├── duplicateRoutes.js      # POST /api/duplicates
│   │   ├── healthRoutes.js         # GET /api/health
│   │   └── scanRoutes.js           # GET /api/scan/config, POST /api/scan
│   └── services/
│       ├── duplicateService.js     # Streaming SHA-256 hashing and candidate grouping
│       └── scanService.js          # Bounded read-only scanning & path validation
├── frontend/
│   ├── index.html                  # Industrial-dark dashboard
│   ├── css/
│   │   └── style.css               # Design system, layout, and responsive styles
│   └── js/
│       └── app.js                  # Connectivity, scan execution, and UI state
├── tests/
│   ├── duplicate.test.js           # Streaming SHA-256 and duplicate detection tests
│   ├── health.test.js              # Health and 404 tests
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

## Current Functionality

- Express server with health, scan, and duplicate endpoints
- Responsive industrial-dark dashboard with real-time status and telemetry
- Secure read-only folder scanning with path traversal protection
- Streaming SHA-256 duplicate detection with candidate size pre-grouping
- Duplicate group cards with hash badges, role differentiation, and reclaimable bytes
- Real file metadata listing with formatting and sorting
- Automated test suite (30 unit and integration tests passing)
- GitHub Actions CI workflow

## Roadmap

- [x] Initial project foundation and CI workflow (Phase 1)
- [x] Secure selection and scanning of a user-approved folder (Phase 2)
- [x] File metadata listing and dashboard statistics (Phase 2)
- [x] SHA-256 duplicate detection (Phase 3)
- [ ] Local Ollama/Gemma integration (Phase 4)
- [ ] Structured AI organization recommendations (Phase 4)
- [ ] Review and approval queue (Phase 5)
- [ ] Validated file moves and conflict handling (Phase 6)
- [ ] Operation history and safe undo (Phase 7)
- [ ] Expanded security tests and desktop integration (Phase 8)

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
