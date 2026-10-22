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

// Event Listeners
checkButton.addEventListener("click", checkBackend);
scanForm.addEventListener("submit", handleScan);
duplicatesButton.addEventListener("click", handleFindDuplicates);

// Initialization
checkBackend();
loadScanConfig();
