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

// Event Listeners
checkButton.addEventListener("click", checkBackend);
scanForm.addEventListener("submit", handleScan);

// Initialization
checkBackend();
loadScanConfig();
