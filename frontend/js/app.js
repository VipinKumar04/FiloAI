// DOM Elements — Health
const checkButton = document.querySelector("#check-backend");
const connectionStatus = document.querySelector("#connection-status");

// DOM Elements — Scan
const approvedRootDisplay = document.querySelector("#approved-root-display");
const scanForm = document.querySelector("#scan-form");
const scanPathInput = document.querySelector("#scan-path-input");
const scanButton = document.querySelector("#scan-button");
const scanButtonText = document.querySelector("#scan-button-text");
const scanSpinner = document.querySelector("#scan-spinner");
const scanAlert = document.querySelector("#scan-alert");
const scanLoading = document.querySelector("#scan-loading");
const scanEmptyState = document.querySelector("#scan-empty-state");
const scanResults = document.querySelector("#scan-results");
const resultsCount = document.querySelector("#results-count");
const resultsDuration = document.querySelector("#results-duration");
const resultsTruncatedBanner = document.querySelector("#results-truncated-banner");
const fileTableBody = document.querySelector("#file-table-body");

// DOM Elements — Stats
const statFiles = document.querySelector("#stat-files");
const statFilesNote = document.querySelector("#stat-files-note");
const statDirs = document.querySelector("#stat-dirs");
const statDirsNote = document.querySelector("#stat-dirs-note");
const statSize = document.querySelector("#stat-size");
const statSizeNote = document.querySelector("#stat-size-note");
const statDupGroups = document.querySelector("#stat-dup-groups");
const statDupGroupsNote = document.querySelector("#stat-dup-groups-note");
const statDupCopies = document.querySelector("#stat-dup-copies");
const statDupCopiesNote = document.querySelector("#stat-dup-copies-note");
const statDupReclaimable = document.querySelector("#stat-dup-reclaimable");
const statDupReclaimableNote = document.querySelector("#stat-dup-reclaimable-note");

// DOM Elements — Duplicates
const duplicatesButton = document.querySelector("#duplicates-button");
const duplicatesButtonText = document.querySelector("#duplicates-button-text");
const duplicatesSpinner = document.querySelector("#duplicates-spinner");
const dupAlert = document.querySelector("#dup-alert");
const dupLoading = document.querySelector("#dup-loading");
const dupEmptyState = document.querySelector("#dup-empty-state");
const dupZeroState = document.querySelector("#dup-zero-state");
const dupResults = document.querySelector("#dup-results");
const dupResultsCount = document.querySelector("#dup-results-count");
const dupResultsDuration = document.querySelector("#dup-results-duration");
const dupTruncatedBanner = document.querySelector("#dup-truncated-banner");
const dupGroupsContainer = document.querySelector("#dup-groups-container");

// DOM Elements — AI Recommendations
const ollamaStatusBadge = document.querySelector("#ollama-status-badge");
const ollamaStatusDot = document.querySelector("#ollama-status-dot");
const ollamaStatusText = document.querySelector("#ollama-status-text");
const ollamaModelDisplay = document.querySelector("#ollama-model-display");
const ollamaNotice = document.querySelector("#ollama-notice");
const recommendationsButton = document.querySelector("#recommendations-button");
const recommendationsButtonText = document.querySelector("#recommendations-button-text");
const recommendationsSpinner = document.querySelector("#recommendations-spinner");
const recAlert = document.querySelector("#rec-alert");
const recLoading = document.querySelector("#rec-loading");
const recEmptyState = document.querySelector("#rec-empty-state");
const recZeroState = document.querySelector("#rec-zero-state");
const recResults = document.querySelector("#rec-results");
const recResultsCount = document.querySelector("#rec-results-count");
const recResultsMeta = document.querySelector("#rec-results-meta");
const recCardsContainer = document.querySelector("#rec-cards-container");

// DOM Elements — Organization & Approval (Phase 5)
const organizationPanel = document.querySelector("#organization-panel");
const orgPreviewForm = document.querySelector("#org-preview-form");
const orgSourceInput = document.querySelector("#org-source-input");
const orgDestInput = document.querySelector("#org-dest-input");
const btnOrgPreview = document.querySelector("#btn-org-preview");
const btnOrgPreviewText = document.querySelector("#btn-org-preview-text");
const orgPreviewSpinner = document.querySelector("#org-preview-spinner");
const orgAlert = document.querySelector("#org-alert");
const orgEmptyState = document.querySelector("#org-empty-state");
const orgPreviewCard = document.querySelector("#org-preview-card");
const orgPreviewOpId = document.querySelector("#org-preview-op-id");
const orgPreviewExpires = document.querySelector("#org-preview-expires");
const orgConflictBadge = document.querySelector("#org-conflict-badge");
const orgPreviewSource = document.querySelector("#org-preview-source");
const orgPreviewSize = document.querySelector("#org-preview-size");
const orgPreviewDest = document.querySelector("#org-preview-dest");
const orgPreviewDestFolder = document.querySelector("#org-preview-dest-folder");
const orgPreviewRationale = document.querySelector("#org-preview-rationale");
const orgConflictBanner = document.querySelector("#org-conflict-banner");
const orgConflictMessage = document.querySelector("#org-conflict-message");
const btnOrgApprove = document.querySelector("#btn-org-approve");
const btnOrgApproveText = document.querySelector("#btn-org-approve-text");
const orgApproveSpinner = document.querySelector("#org-approve-spinner");
const btnOrgCancel = document.querySelector("#btn-org-cancel");
const orgExecResult = document.querySelector("#org-exec-result");
const orgExecStatusIcon = document.querySelector("#org-exec-status-icon");
const orgExecTitle = document.querySelector("#org-exec-title");
const orgExecMessage = document.querySelector("#org-exec-message");
const btnRefreshHistory = document.querySelector("#btn-refresh-history");
const orgHistoryEmpty = document.querySelector("#org-history-empty");
const orgHistoryTableContainer = document.querySelector("#org-history-table-container");
const orgHistoryBody = document.querySelector("#org-history-body");

/**
 * Formats bytes into human-readable string.
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/**
 * Formats an ISO date string into readable local date and time.
 */
function formatDate(isoString) {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    }) + ", " + d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return isoString;
  }
}

/**
 * Safe HTML escape helper.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Checks backend health.
 */
async function checkBackend() {
  checkButton.disabled = true;
  connectionStatus.dataset.state = "loading";
  connectionStatus.textContent = "Checking backend…";

  try {
    const response = await fetch("/api/health", {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Backend returned HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.success !== true) {
      throw new Error("Unexpected health response.");
    }

    connectionStatus.dataset.state = "success";
    connectionStatus.textContent = "Backend connected";
  } catch (error) {
    connectionStatus.dataset.state = "error";
    connectionStatus.textContent = "Backend unavailable";
    console.error("filoAI health check failed:", error.message);
  } finally {
    checkButton.disabled = false;
  }
}

/**
 * Loads approved scan root configuration.
 */
async function loadScanConfig() {
  try {
    const response = await fetch("/api/scan/config", {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return;

    const body = await response.json();
    if (body.success && body.data) {
      approvedRootDisplay.textContent = body.data.approvedRootDisplay;
      approvedRootDisplay.title = body.data.isCustomRoot
        ? `Custom approved root: ${body.data.approvedRootDisplay}`
        : `Default workspace folder: ${body.data.approvedRootDisplay}`;
    }
  } catch (error) {
    console.warn("Unable to load scan configuration:", error.message);
    approvedRootDisplay.textContent = "scan-workspace";
  }
}

/**
 * Executes secure read-only directory scan.
 */
async function handleScan(event) {
  if (event) event.preventDefault();

  const requestedPath = scanPathInput.value.trim() || ".";

  // UI state: Loading
  scanButton.disabled = true;
  scanButtonText.textContent = "Scanning…";
  scanSpinner.classList.remove("hidden");
  scanAlert.classList.add("hidden");
  scanAlert.textContent = "";
  scanEmptyState.classList.add("hidden");
  scanResults.classList.add("hidden");
  scanLoading.classList.remove("hidden");

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ path: requestedPath })
    });

    const body = await response.json();

    if (!response.ok || !body.success) {
      const err = body.error || {};
      const code = err.code ? `[${err.code}] ` : "";
      const message = err.message || `Scan failed with HTTP ${response.status}.`;
      throw new Error(`${code}${message}`);
    }

    const { files = [], summary = {} } = body.data;

    // Update real statistics without fabrication
    statFiles.textContent = (summary.totalFiles || 0).toLocaleString();
    statFilesNote.textContent = summary.totalDirectories === 1 ? "In 1 directory" : `In ${summary.totalDirectories || 0} directories`;

    statDirs.textContent = (summary.totalDirectories || 0).toLocaleString();
    statDirsNote.textContent = "Subdirectories discovered";

    statSize.textContent = formatBytes(summary.totalSizeBytes || 0);
    statSizeNote.textContent = `${(summary.totalSizeBytes || 0).toLocaleString()} bytes cataloged`;

    // Render results
    scanLoading.classList.add("hidden");

    if (files.length === 0) {
      scanEmptyState.classList.remove("hidden");
      const emptyTitle = scanEmptyState.querySelector(".empty-title");
      if (emptyTitle) emptyTitle.textContent = "Directory is empty";
      const emptyMuted = scanEmptyState.querySelector(".muted");
      if (emptyMuted) emptyMuted.textContent = "No files or subfolders were found in the scanned location.";
      return;
    }

    // Populate file table
    fileTableBody.innerHTML = files.map((file) => `
      <tr>
        <td>
          <div class="file-info">
            <span class="file-name" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.name)}</span>
            <span class="file-subpath" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.relativePath)}</span>
          </div>
        </td>
        <td class="td-ext">
          <span class="file-ext-badge">${escapeHtml(file.extension ? file.extension.replace(".", "") : "file")}</span>
        </td>
        <td class="td-size">${formatBytes(file.sizeBytes)}</td>
        <td class="td-date" title="${escapeHtml(file.lastModified)}">${formatDate(file.lastModified)}</td>
      </tr>
    `).join("");

    resultsCount.textContent = `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"} cataloged`;
    resultsDuration.textContent = typeof summary.scanDurationMs === "number" ? `Completed in ${summary.scanDurationMs}ms` : "";

    if (summary.isTruncated) {
      resultsTruncatedBanner.classList.remove("hidden");
    } else {
      resultsTruncatedBanner.classList.add("hidden");
    }

    scanResults.classList.remove("hidden");
  } catch (error) {
    scanLoading.classList.add("hidden");
    scanAlert.textContent = error.message || "An unexpected error occurred during scanning.";
    scanAlert.classList.remove("hidden");

    // Clear stats on error
    statFiles.textContent = "—";
    statFilesNote.textContent = "Scan encountered an error";
    statDirs.textContent = "—";
    statDirsNote.textContent = "Scan encountered an error";
    statSize.textContent = "—";
    statSizeNote.textContent = "Scan encountered an error";
  } finally {
    scanButton.disabled = false;
    scanButtonText.textContent = "Scan directory";
    scanSpinner.classList.add("hidden");
  }
}

/**
 * Executes duplicate detection using streaming SHA-256 hashes.
 */
async function handleFindDuplicates(event) {
  if (event) event.preventDefault();

  const requestedPath = scanPathInput.value.trim() || ".";

  // UI state: Loading
  duplicatesButton.disabled = true;
  scanButton.disabled = true;
  duplicatesButtonText.textContent = "Analyzing…";
  duplicatesSpinner.classList.remove("hidden");
  dupAlert.classList.add("hidden");
  dupAlert.textContent = "";
  dupEmptyState.classList.add("hidden");
  dupZeroState.classList.add("hidden");
  dupResults.classList.add("hidden");
  dupLoading.classList.remove("hidden");

  try {
    const response = await fetch("/api/duplicates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ path: requestedPath })
    });

    const body = await response.json();

    if (!response.ok || !body.success) {
      const err = body.error || {};
      const code = err.code ? `[${err.code}] ` : "";
      const message = err.message || `Duplicate analysis failed with HTTP ${response.status}.`;
      throw new Error(`${code}${message}`);
    }

    const { duplicateGroups = [], summary = {} } = body.data;

    // Update duplicate telemetry
    statDupGroups.textContent = (summary.totalDuplicateGroups || 0).toLocaleString();
    statDupGroupsNote.textContent = summary.totalDuplicateGroups === 1
      ? "1 duplicate group"
      : `${(summary.totalDuplicateGroups || 0).toLocaleString()} groups found`;

    statDupCopies.textContent = (summary.totalRedundantCopies || 0).toLocaleString();
    statDupCopiesNote.textContent = summary.totalRedundantCopies === 1
      ? "1 redundant copy"
      : `${(summary.totalRedundantCopies || 0).toLocaleString()} redundant copies`;

    statDupReclaimable.textContent = formatBytes(summary.reclaimableBytes || 0);
    statDupReclaimableNote.textContent = `${(summary.reclaimableBytes || 0).toLocaleString()} bytes reclaimable`;

    // Also update scan overview stats if available
    if (typeof summary.totalScannedFiles === "number") {
      statFiles.textContent = summary.totalScannedFiles.toLocaleString();
      statFilesNote.textContent = summary.totalScannedDirectories === 1
        ? "In 1 directory"
        : `In ${summary.totalScannedDirectories || 0} directories`;
    }
    if (typeof summary.totalScannedDirectories === "number") {
      statDirs.textContent = summary.totalScannedDirectories.toLocaleString();
      statDirsNote.textContent = "Subdirectories discovered";
    }

    dupLoading.classList.add("hidden");

    if (duplicateGroups.length === 0) {
      dupZeroState.classList.remove("hidden");
      return;
    }

    // Populate duplicate groups cards
    dupGroupsContainer.innerHTML = duplicateGroups.map((group, groupIndex) => {
      const shortHash = group.hash.slice(0, 16) + "…";
      return `
        <div class="dup-group-card">
          <div class="dup-group-header">
            <div class="dup-group-meta">
              <span class="dup-group-tag">GROUP #${groupIndex + 1}</span>
              <span class="dup-group-size">${formatBytes(group.sizeBytes)} each</span>
              <span class="dup-group-savings">${formatBytes(group.reclaimableBytes)} reclaimable (${group.redundantCopies} ${group.redundantCopies === 1 ? "extra copy" : "extra copies"})</span>
            </div>
            <div class="dup-hash-badge" title="SHA-256: ${escapeHtml(group.hash)}">
              <span class="dup-hash-label">SHA-256</span>
              <code class="dup-hash-code">${escapeHtml(shortHash)}</code>
            </div>
          </div>
          <div class="dup-files-list">
            ${group.files.map((file) => `
              <div class="dup-file-item ${file.isPrimaryCandidate ? "role-primary" : "role-copy"}">
                <div>
                  <span class="role-badge ${file.isPrimaryCandidate ? "role-badge-primary" : "role-badge-copy"}" title="${file.isPrimaryCandidate ? "First detected copy. Neither file is definitively designated as the sole original." : "Identical SHA-256 content match"}">
                    ${file.isPrimaryCandidate ? "PRIMARY CANDIDATE" : "DUPLICATE COPY"}
                  </span>
                </div>
                <div class="dup-file-details">
                  <span class="dup-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                  <span class="dup-file-path" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.relativePath)}</span>
                </div>
                <div class="dup-file-stats">
                  <span class="dup-file-size">${formatBytes(file.sizeBytes)}</span>
                  <span class="dup-file-date" title="${escapeHtml(file.lastModified)}">${formatDate(file.lastModified)}</span>
                </div>
              </div>
            `).join("")}
          </div>
          <div class="dup-disclaimer">
            <span>Identical content detected via SHA-256. Neither file is automatically designated as the original.</span>
          </div>
        </div>
      `;
    }).join("");

    dupResultsCount.textContent = `${duplicateGroups.length} ${duplicateGroups.length === 1 ? "group" : "groups"} · ${summary.totalRedundantCopies} ${summary.totalRedundantCopies === 1 ? "redundant copy" : "redundant copies"}`;
    dupResultsDuration.textContent = typeof summary.scanDurationMs === "number" ? `Completed in ${summary.scanDurationMs}ms` : "";

    if (summary.isTruncated) {
      dupTruncatedBanner.classList.remove("hidden");
    } else {
      dupTruncatedBanner.classList.add("hidden");
    }

    dupResults.classList.remove("hidden");
  } catch (error) {
    dupLoading.classList.add("hidden");
    dupAlert.textContent = error.message || "An unexpected error occurred during duplicate analysis.";
    dupAlert.classList.remove("hidden");

    statDupGroups.textContent = "—";
    statDupGroupsNote.textContent = "Analysis encountered an error";
    statDupCopies.textContent = "—";
    statDupCopiesNote.textContent = "Analysis encountered an error";
    statDupReclaimable.textContent = "—";
    statDupReclaimableNote.textContent = "Analysis encountered an error";
  } finally {
    duplicatesButton.disabled = false;
    scanButton.disabled = false;
    duplicatesButtonText.textContent = "Find duplicates";
    duplicatesSpinner.classList.add("hidden");
  }
}

/**
 * Loads Ollama connection status and configured model.
 */
async function loadOllamaStatus() {
  try {
    const res = await fetch("/api/recommendations/status", {
      headers: { Accept: "application/json" }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json();
    if (!body.success || !body.data) return;

    const { available, model, modelInstalled } = body.data;
    ollamaModelDisplay.textContent = model || "gemma2:2b";

    if (available && modelInstalled) {
      ollamaStatusDot.dataset.state = "online";
      ollamaStatusText.textContent = `OLLAMA ONLINE · ${model}`;
      ollamaNotice.textContent = "Local Gemma model ready for private file analysis";
      ollamaStatusBadge.title = `Connected to local Ollama with ${model} installed`;
    } else if (available && !modelInstalled) {
      ollamaStatusDot.dataset.state = "missing-model";
      ollamaStatusText.textContent = `MODEL NEEDED (${model})`;
      ollamaNotice.textContent = `Run 'ollama pull ${model}' in your terminal`;
      ollamaStatusBadge.title = `Ollama is running, but model '${model}' is not installed`;
    } else {
      ollamaStatusDot.dataset.state = "offline";
      ollamaStatusText.textContent = "OLLAMA OFFLINE";
      ollamaNotice.textContent = "Local Ollama server not detected. Start with 'ollama serve'";
      ollamaStatusBadge.title = "Ollama is not reachable on localhost:11434";
    }
  } catch {
    ollamaStatusDot.dataset.state = "offline";
    ollamaStatusText.textContent = "OLLAMA OFFLINE";
    ollamaNotice.textContent = "Local Ollama server not detected";
  }
}

/**
 * Executes AI recommendation generation using local Gemma via Ollama.
 */
async function handleGenerateRecommendations(event) {
  if (event) event.preventDefault();

  const requestedPath = scanPathInput.value.trim() || ".";

  // UI state: Loading
  recommendationsButton.disabled = true;
  recommendationsButtonText.textContent = "Consulting local AI…";
  recommendationsSpinner.classList.remove("hidden");
  recAlert.classList.add("hidden");
  recAlert.textContent = "";
  recEmptyState.classList.add("hidden");
  recZeroState.classList.add("hidden");
  recResults.classList.add("hidden");
  recLoading.classList.remove("hidden");

  try {
    const response = await fetch("/api/recommendations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ path: requestedPath })
    });

    const body = await response.json();

    if (!response.ok || !body.success) {
      const err = body.error || {};
      const code = err.code ? `[${err.code}] ` : "";
      const message = err.message || `AI recommendation generation failed (HTTP ${response.status}).`;
      throw new Error(`${code}${message}`);
    }

    const { recommendations = [], model = "gemma2:2b", summary = {} } = body.data;

    recLoading.classList.add("hidden");

    if (recommendations.length === 0) {
      recZeroState.classList.remove("hidden");
      return;
    }

    // Render recommendation cards
    recCardsContainer.innerHTML = recommendations.map((rec) => {
      const typeLabel = rec.type.replace(/_/g, " ");
      const confClass = rec.confidence === "high"
        ? "conf-high"
        : (rec.confidence === "medium" ? "conf-medium" : "conf-low");

      const pathsHtml = Array.isArray(rec.relevantPaths) && rec.relevantPaths.length > 0
        ? `
          <div class="rec-files-section">
            <span class="rec-files-heading">AFFECTED FILES (${rec.relevantPaths.length}):</span>
            <div class="rec-paths-list">
              ${rec.relevantPaths.map((p) => `
                <span class="rec-path-interactive">
                  <span class="rec-path-tag" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
                  <button type="button" class="rec-path-organize-btn" data-source="${escapeHtml(p)}" data-rec-id="${escapeHtml(rec.id)}" data-rationale="${escapeHtml(rec.title + ': ' + rec.explanation)}" title="Preview move for ${escapeHtml(p)}">Preview move ↗</button>
                </span>
              `).join("")}
            </div>
          </div>
        `
        : "";

      const primaryAction = Array.isArray(rec.relevantPaths) && rec.relevantPaths.length > 0
        ? `
          <div class="rec-card-actions">
            <button type="button" class="button button-secondary button-small btn-rec-organize" data-source="${escapeHtml(rec.relevantPaths[0])}" data-rec-id="${escapeHtml(rec.id)}" data-rationale="${escapeHtml(rec.title + ': ' + rec.explanation)}">
              <span>Review & organize in FiloAI ↗</span>
            </button>
          </div>
        `
        : "";

      return `
        <div class="rec-card">
          <div class="rec-card-header">
            <div class="rec-card-tags">
              <span class="rec-type-badge">${escapeHtml(typeLabel)}</span>
              <span class="rec-confidence-badge ${confClass}">CONFIDENCE: ${escapeHtml(rec.confidence.toUpperCase())}</span>
            </div>
            <span class="rec-review-tag">REVIEW REQUIRED</span>
          </div>
          <div class="rec-card-body">
            <h4 class="rec-card-title">${escapeHtml(rec.title)}</h4>
            <p class="rec-card-explanation">${escapeHtml(rec.explanation)}</p>
            ${pathsHtml}
            ${primaryAction}
          </div>
          <div class="rec-card-footer">
            <span class="rec-advisory-note">Advisory recommendation generated by local ${escapeHtml(model)}. File operations require separate explicit user approval.</span>
          </div>
        </div>
      `;
    }).join("");

    recResultsCount.textContent = `${recommendations.length} ${recommendations.length === 1 ? "recommendation" : "recommendations"} suggested`;
    recResultsMeta.textContent = typeof summary.ollamaDurationMs === "number"
      ? `Model inferred in ${summary.ollamaDurationMs}ms`
      : "";

    recResults.classList.remove("hidden");
  } catch (error) {
    recLoading.classList.add("hidden");
    recAlert.textContent = error.message || "An unexpected error occurred while contacting local AI.";
    recAlert.classList.remove("hidden");
  } finally {
    recommendationsButton.disabled = false;
    recommendationsButtonText.textContent = "Generate recommendations";
    recommendationsSpinner.classList.add("hidden");
  }
}

// -------------------------------------------------------------
// Organization & Explicit Human Approval Workflow (Phase 5)
// -------------------------------------------------------------
let currentPreview = null;

/**
 * Initiates safe read-only preview of a file move.
 * Validates containment, regular file status, and detects conflicts without altering disk.
 */
async function initiatePreview(sourcePath, destinationDir, recommendationId = null, rationale = null) {
  if (!sourcePath || !sourcePath.trim()) {
    orgAlert.textContent = "Please specify a source file inside the approved root.";
    orgAlert.classList.remove("hidden");
    return;
  }

  btnOrgPreview.disabled = true;
  btnOrgPreviewText.textContent = "Checking…";
  orgPreviewSpinner.classList.remove("hidden");
  orgAlert.classList.add("hidden");
  orgExecResult.classList.add("hidden");

  try {
    const response = await fetch("/api/organization/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        sourcePath: sourcePath.trim(),
        destinationDir: (destinationDir || "organized").trim(),
        recommendationId,
        rationale
      })
    });

    const body = await response.json();

    if (!response.ok || !body.success) {
      const err = body.error || {};
      const code = err.code ? `[${err.code}] ` : "";
      const message = err.message || `Preview failed (HTTP ${response.status}).`;
      throw new Error(`${code}${message}`);
    }

    const {
      operationId,
      approvalToken,
      sourcePath: srcRel,
      destinationPath: dstRel,
      destinationDir: dstDir,
      sizeBytes,
      conflict,
      conflictReason,
      canExecute,
      expiresAt,
      rationale: recRationale
    } = body.data;

    currentPreview = {
      operationId,
      approvalToken,
      sourcePath: srcRel,
      destinationPath: dstRel,
      destinationDir: dstDir,
      canExecute
    };

    // Populate preview card
    orgPreviewOpId.textContent = operationId;
    orgPreviewExpires.textContent = `Valid until ${new Date(expiresAt).toLocaleTimeString()}`;
    orgPreviewSource.textContent = srcRel;
    orgPreviewSize.textContent = `File size: ${formatBytes(sizeBytes)}`;
    orgPreviewDest.textContent = dstRel;
    orgPreviewDestFolder.textContent = `Target subfolder: ${dstDir}`;
    orgPreviewRationale.textContent = recRationale || "User-approved file organization.";

    // Conflict handling
    if (conflict) {
      orgConflictBadge.textContent = "⚠ CONFLICT DETECTED";
      orgConflictBadge.className = "badge-conflict-status conflict-warning";
      orgConflictMessage.textContent = conflictReason || "A file with this name already exists in destination. Overwrite is strictly prevented.";
      orgConflictBanner.classList.remove("hidden");
      btnOrgApprove.disabled = true;
      btnOrgApprove.title = "Cannot move: Destination file already exists.";
    } else {
      orgConflictBadge.textContent = "✓ DESTINATION CLEAR";
      orgConflictBadge.className = "badge-conflict-status conflict-clear";
      orgConflictBanner.classList.add("hidden");
      btnOrgApprove.disabled = false;
      btnOrgApprove.title = "Click to execute move with explicit cryptographic approval token";
    }

    orgEmptyState.classList.add("hidden");
    orgPreviewCard.classList.remove("hidden");
  } catch (error) {
    orgAlert.textContent = error.message;
    orgAlert.classList.remove("hidden");
    orgPreviewCard.classList.add("hidden");
    orgEmptyState.classList.remove("hidden");
    currentPreview = null;
  } finally {
    btnOrgPreview.disabled = false;
    btnOrgPreviewText.textContent = "Preview move";
    orgPreviewSpinner.classList.add("hidden");
  }
}

/**
 * Handles explicit user approval to execute the previewed move.
 */
async function handleApproveOperation() {
  if (!currentPreview || !currentPreview.canExecute) {
    return;
  }

  btnOrgApprove.disabled = true;
  btnOrgApproveText.textContent = "Moving file…";
  orgApproveSpinner.classList.remove("hidden");
  orgAlert.classList.add("hidden");

  try {
    const response = await fetch("/api/organization/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        operationId: currentPreview.operationId,
        approvalToken: currentPreview.approvalToken
      })
    });

    const body = await response.json();

    if (!response.ok || !body.success) {
      const err = body.error || {};
      const code = err.code ? `[${err.code}] ` : "";
      const message = err.message || `Move execution failed (HTTP ${response.status}).`;
      throw new Error(`${code}${message}`);
    }

    // Success
    orgExecResult.className = "org-exec-result exec-success";
    orgExecStatusIcon.textContent = "✓";
    orgExecTitle.textContent = "Operation executed successfully";
    orgExecMessage.textContent = `Moved "${body.data.sourcePath}" to "${body.data.destinationPath}".`;
    orgExecResult.classList.remove("hidden");

    // Invalidate current preview token
    currentPreview = null;
    btnOrgApprove.disabled = true;

    // Refresh history and scan view
    await loadOperationHistory();
    handleScan();
  } catch (error) {
    orgExecResult.className = "org-exec-result exec-error";
    orgExecStatusIcon.textContent = "✕";
    orgExecTitle.textContent = "Execution rejected or failed";
    orgExecMessage.textContent = error.message;
    orgExecResult.classList.remove("hidden");
  } finally {
    btnOrgApproveText.textContent = "Approve & Move File";
    orgApproveSpinner.classList.add("hidden");
  }
}

/**
 * Cancels current preview.
 */
function handleCancelPreview() {
  currentPreview = null;
  orgPreviewCard.classList.add("hidden");
  orgEmptyState.classList.remove("hidden");
  orgAlert.classList.add("hidden");
  orgExecResult.classList.add("hidden");
}

/**
 * Fetches and displays completed operations history.
 */
async function loadOperationHistory() {
  try {
    const response = await fetch("/api/organization/history", {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return;

    const body = await response.json();
    if (!body.success) return;

    const history = body.data.history || [];

    if (history.length === 0) {
      orgHistoryEmpty.classList.remove("hidden");
      orgHistoryTableContainer.classList.add("hidden");
      return;
    }

    orgHistoryEmpty.classList.add("hidden");
    orgHistoryTableContainer.classList.remove("hidden");

    orgHistoryBody.innerHTML = history.map((item) => {
      const statusBadge = item.status === "completed"
        ? `<span class="badge-completed">Completed</span>`
        : `<span class="badge-undone">Restored (Undone)</span>`;

      const actionBtn = item.undoAvailable
        ? `<button type="button" class="button button-secondary button-small btn-org-undo" data-op-id="${escapeHtml(item.operationId)}">Undo</button>`
        : `<span class="muted" style="font-size: 0.72rem;">—</span>`;

      return `
        <tr>
          <td><code class="org-op-id" style="font-size: 0.7rem;">${escapeHtml(item.operationId)}</code></td>
          <td>
            <div style="font-family: monospace; font-size: 0.75rem;">
              <span style="color: var(--muted);">${escapeHtml(item.sourcePath)}</span>
              <span style="color: var(--silver); margin: 0 4px;">→</span>
              <span style="color: var(--accent); font-weight: 600;">${escapeHtml(item.destinationPath)}</span>
            </div>
          </td>
          <td>${statusBadge}</td>
          <td style="font-size: 0.74rem; color: var(--muted);">${escapeHtml(formatDate(item.executedAt))}</td>
          <td style="text-align: right;">${actionBtn}</td>
        </tr>
      `;
    }).join("");
  } catch (error) {
    console.warn("Failed to load operation history:", error.message);
  }
}

/**
 * Reverts a previously completed move operation.
 */
async function handleUndoOperation(operationId) {
  if (!operationId) return;

  const confirmed = window.confirm(`Restore file for operation ${operationId}? The moved file will be safely returned to its original location.`);
  if (!confirmed) return;

  try {
    const response = await fetch("/api/organization/undo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ operationId })
    });

    const body = await response.json();
    if (!response.ok || !body.success) {
      const err = body.error || {};
      const code = err.code ? `[${err.code}] ` : "";
      alert(`Undo failed: ${code}${err.message || "Unable to restore file."}`);
      return;
    }

    await loadOperationHistory();
    handleScan();
  } catch (error) {
    alert(`Undo request failed: ${error.message}`);
  }
}

// Event Listeners
checkButton.addEventListener("click", checkBackend);
scanForm.addEventListener("submit", handleScan);
duplicatesButton.addEventListener("click", handleFindDuplicates);
recommendationsButton.addEventListener("click", handleGenerateRecommendations);

// Section 04 Event Listeners
orgPreviewForm.addEventListener("submit", (event) => {
  event.preventDefault();
  initiatePreview(orgSourceInput.value, orgDestInput.value);
});
btnOrgApprove.addEventListener("click", handleApproveOperation);
btnOrgCancel.addEventListener("click", handleCancelPreview);
btnRefreshHistory.addEventListener("click", loadOperationHistory);

// Recommendation Cards Action Delegation
recCardsContainer.addEventListener("click", (event) => {
  const btn = event.target.closest(".rec-path-organize-btn, .btn-rec-organize");
  if (!btn) return;

  const source = btn.dataset.source;
  const recId = btn.dataset.recId;
  const rationale = btn.dataset.rationale;

  if (source) {
    orgSourceInput.value = source;
    // Suggest subfolder based on recommendation rationale or file extension
    if (rationale && rationale.toLowerCase().includes("archive")) {
      orgDestInput.value = "archive";
    } else if (source.match(/\.(pdf|docx?|xlsx?|pptx?|txt|md)$/i)) {
      orgDestInput.value = "documents";
    } else if (source.match(/\.(png|jpe?g|gif|svg|mp4|mov)$/i)) {
      orgDestInput.value = "media";
    } else {
      orgDestInput.value = "organized";
    }

    if (organizationPanel) {
      organizationPanel.scrollIntoView({ behavior: "smooth" });
    }
    initiatePreview(source, orgDestInput.value, recId, rationale);
  }
});

// History table undo delegation
orgHistoryBody.addEventListener("click", (event) => {
  const undoBtn = event.target.closest(".btn-org-undo");
  if (undoBtn) {
    const opId = undoBtn.dataset.opId;
    handleUndoOperation(opId);
  }
});

// Initialization
checkBackend();
loadScanConfig();
loadOllamaStatus();
loadOperationHistory();
