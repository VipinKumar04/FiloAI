const path = require("node:path");
const {
  resolveAndValidateTarget,
  scanDirectory,
  parseBoundedLimit
} = require("./scanService");
const { findDuplicates } = require("./duplicateService");

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "gemma2:2b";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_METADATA_FILES_FOR_PROMPT = 60;
const MAX_RECOMMENDATIONS_COUNT = 10;

const ALLOWED_RECOMMENDATION_TYPES = new Set([
  "file_organization",
  "duplicate_review",
  "large_files",
  "type_grouping",
  "archive_candidate"
]);

const ALLOWED_CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);

/**
 * Returns the configured Ollama settings from environment variables.
 */
function getOllamaConfig() {
  const rawBase = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  const baseUrl = rawBase.trim().replace(/\/+$/, "");
  const model = (process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim();
  const timeoutMs = parseBoundedLimit(process.env.OLLAMA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000);

  return {
    baseUrl,
    model,
    timeoutMs
  };
}

/**
 * Checks connection readiness to the local Ollama instance and verifies model availability.
 *
 * @param {string} [customBaseUrl]
 * @param {string} [customModel]
 * @returns {Promise<{ available: boolean, model: string, modelInstalled: boolean, installedModels: string[], baseUrl: string, error?: string }>}
 */
async function checkOllamaStatus(customBaseUrl, customModel) {
  const config = getOllamaConfig();
  const baseUrl = customBaseUrl ? customBaseUrl.trim().replace(/\/+$/, "") : config.baseUrl;
  const targetModel = customModel ? customModel.trim() : config.model;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        available: false,
        model: targetModel,
        modelInstalled: false,
        installedModels: [],
        baseUrl,
        error: `Ollama returned HTTP ${res.status}`
      };
    }

    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const modelNames = models.map((m) => (typeof m.name === "string" ? m.name : "")).filter(Boolean);

    const isInstalled = modelNames.some((name) => {
      const lowerTarget = targetModel.toLowerCase();
      const lowerName = name.toLowerCase();
      return lowerName === lowerTarget || lowerName.startsWith(`${lowerTarget}:`) || lowerName === `${lowerTarget}:latest`;
    });

    return {
      available: true,
      model: targetModel,
      modelInstalled: isInstalled,
      installedModels: modelNames,
      baseUrl
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    return {
      available: false,
      model: targetModel,
      modelInstalled: false,
      installedModels: [],
      baseUrl,
      error: isTimeout ? "Connection to Ollama timed out" : (err.message || "Unable to connect to Ollama")
    };
  }
}

/**
 * Builds a privacy-preserving prompt containing only minimal metadata and duplicate metrics.
 * Never includes absolute paths or file contents.
 */
function buildPrompt(files, duplicateGroups) {
  // Select a bounded subset of metadata to prevent context overflow on small models
  const sampleFiles = files.slice(0, MAX_METADATA_FILES_FOR_PROMPT).map((f) => ({
    name: f.name,
    relativePath: f.relativePath,
    extension: f.extension || "",
    sizeBytes: f.sizeBytes
  }));

  const sampleDuplicates = (duplicateGroups || []).slice(0, 10).map((g) => ({
    hash: g.hash ? g.hash.slice(0, 12) : "",
    count: g.count,
    reclaimableBytes: g.reclaimableBytes,
    paths: g.files.map((f) => f.relativePath)
  }));

  return `You are filoAI, a private, local file organization assistant.
Analyze the following file metadata and duplicate groups to recommend helpful organizational actions.

CRITICAL PRIVACY AND SAFETY RULES:
1. You only see metadata (names, relative paths, sizes). You do NOT see file contents.
2. You must NOT suggest deleting files.
3. You must NOT suggest executing code, commands, or automated filesystem actions.
4. Only reference relative paths that exist in the provided file list. Do NOT invent or hallucinate new paths.
5. All recommendations require explicit human approval and review.
6. Clearly state whether the recommendation is based on strong file patterns or is an uncertain suggestion.

ALLOWED RECOMMENDATION TYPES:
- "file_organization": Categorize related files into standard folder structures (e.g., documents, media, code).
- "duplicate_review": Flag identical content copies for the user to manually review.
- "large_files": Identify files with large byte sizes that the user might want to review.
- "type_grouping": Group files by format/extension.
- "archive_candidate": Suggest potential folders for dated or reference files.

ALLOWED CONFIDENCE VALUES: "high", "medium", "low".

Return ONLY a JSON object strictly matching this schema:
{
  "recommendations": [
    {
      "id": "rec_1",
      "type": "file_organization",
      "title": "Short title (max 80 chars)",
      "explanation": "Clear reason for this recommendation",
      "relevantPaths": ["path/to/file1.ext", "path/to/file2.ext"],
      "confidence": "high",
      "requiresReview": true
    }
  ]
}

FILES METADATA (${sampleFiles.length} files):
${JSON.stringify(sampleFiles)}

DUPLICATE GROUPS (${sampleDuplicates.length} groups):
${JSON.stringify(sampleDuplicates)}`;
}

/**
 * Strictly parses and validates the model's raw JSON output against the application schema.
 * Rejects or sanitizes hallucinated paths, unknown types, and oversized fields.
 *
 * @param {string} rawResponse
 * @param {Set<string>} validPathsSet - Set of known valid relativePaths from the directory scan
 * @returns {Array<object>} Validated recommendations array
 */
function validateModelOutput(rawResponse, validPathsSet) {
  if (typeof rawResponse !== "string" || !rawResponse.trim()) {
    throw new Error("Model response was empty.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawResponse.trim());
  } catch (err) {
    throw new Error(`Model returned malformed JSON: ${err.message}`);
  }

  let rawList = [];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.recommendations)) {
      rawList = parsed.recommendations;
    } else if (Array.isArray(parsed.data)) {
      rawList = parsed.data;
    }
  }

  if (!Array.isArray(rawList)) {
    throw new Error("Model response did not contain a recommendations array.");
  }

  const validated = [];
  const boundedList = rawList.slice(0, MAX_RECOMMENDATIONS_COUNT);

  for (let i = 0; i < boundedList.length; i++) {
    const item = boundedList[i];
    if (!item || typeof item !== "object") continue;

    const rawType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
    const type = ALLOWED_RECOMMENDATION_TYPES.has(rawType) ? rawType : "file_organization";

    const title = typeof item.title === "string" && item.title.trim()
      ? item.title.trim().slice(0, 100)
      : `Recommendation #${i + 1}`;

    const explanation = typeof item.explanation === "string" && item.explanation.trim()
      ? item.explanation.trim().slice(0, 500)
      : "No detailed explanation provided by model.";

    // Strictly sanitize relevant paths: only keep paths that actually exist in the scanned directory
    const rawPaths = Array.isArray(item.relevantPaths) ? item.relevantPaths : [];
    const sanitizedPaths = [];
    for (const p of rawPaths) {
      if (typeof p !== "string") continue;
      const cleanPath = p.trim().split(path.sep).join("/");
      // Ensure path is part of verified scanned files set to prevent hallucinated path injection
      if (validPathsSet.has(cleanPath) && !sanitizedPaths.includes(cleanPath)) {
        sanitizedPaths.push(cleanPath);
      }
    }

    const rawConf = typeof item.confidence === "string" ? item.confidence.trim().toLowerCase() : "";
    const confidence = ALLOWED_CONFIDENCE_LEVELS.has(rawConf) ? rawConf : "low";

    validated.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `rec_${i + 1}`,
      type,
      title,
      explanation,
      relevantPaths: sanitizedPaths,
      confidence,
      requiresReview: true
    });
  }

  return validated;
}

/**
 * Generates local AI organization recommendations using Ollama and Gemma.
 *
 * @param {string} [requestedPath="."] - Relative subpath or path within the approved root
 * @param {object} [options={}] - Options including custom approvedRoot, baseUrl, model, timeoutMs
 * @returns {Promise<{ success: boolean, data?: object, error?: object, status?: number }>}
 */
async function generateRecommendations(requestedPath = ".", options = {}) {
  const startTime = Date.now();
  const config = getOllamaConfig();

  const baseUrl = options.baseUrl ? options.baseUrl.trim().replace(/\/+$/, "") : config.baseUrl;
  const model = options.model ? options.model.trim() : config.model;
  const timeoutMs = options.timeoutMs !== undefined
    ? parseBoundedLimit(options.timeoutMs, config.timeoutMs, 1000, 120000)
    : config.timeoutMs;

  // 1. Validate requested path and resolve approved root
  const targetValidation = await resolveAndValidateTarget(requestedPath, options.approvedRoot);
  if (!targetValidation.success) {
    return targetValidation;
  }

  // 2. Perform safe read-only scan of directory
  const scanResult = await scanDirectory(requestedPath, options);
  if (!scanResult.success) {
    return scanResult;
  }

  const { files = [] } = scanResult.data;

  // If no files were found, return empty recommendations immediately without invoking Ollama
  if (files.length === 0) {
    return {
      success: true,
      status: 200,
      data: {
        recommendations: [],
        model,
        summary: {
          totalRecommendations: 0,
          totalFilesScanned: 0,
          ollamaDurationMs: 0,
          totalDurationMs: Date.now() - startTime
        }
      }
    };
  }

  // 3. Find duplicate groups for richer context
  const dupResult = await findDuplicates(requestedPath, options);
  const duplicateGroups = dupResult.success && dupResult.data ? dupResult.data.duplicateGroups : [];

  // Build known set of valid relative paths for anti-hallucination validation
  const validPathsSet = new Set(files.map((f) => f.relativePath));

  // 4. Construct privacy-preserving prompt
  const prompt = buildPrompt(files, duplicateGroups);

  // 5. Invoke Ollama local API
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let responseData;
  const ollamaStartTime = Date.now();

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.2
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (res.status === 404) {
      const errBody = await res.text().catch(() => "");
      return {
        success: false,
        status: 404,
        error: {
          code: "MODEL_NOT_FOUND",
          message: `Model '${model}' was not found in local Ollama. Please run 'ollama pull ${model}' to install it. (${errBody || "Not Found"})`
        }
      };
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return {
        success: false,
        status: 502,
        error: {
          code: "OLLAMA_ERROR",
          message: `Ollama returned an unexpected HTTP error (${res.status}): ${errBody || "Bad Gateway"}`
        }
      };
    }

    responseData = await res.json();
  } catch (err) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      return {
        success: false,
        status: 504,
        error: {
          code: "OLLAMA_TIMEOUT",
          message: `Ollama request timed out after ${timeoutMs}ms.`
        }
      };
    }

    return {
      success: false,
      status: 503,
      error: {
        code: "OLLAMA_UNAVAILABLE",
        message: `Local Ollama service is not reachable at ${baseUrl}. Ensure Ollama is running ('ollama serve').`
      }
    };
  }

  const ollamaDurationMs = Date.now() - ollamaStartTime;

  // 6. Validate and sanitize model output
  const rawResponse = responseData && typeof responseData.response === "string"
    ? responseData.response
    : "";

  let recommendations = [];
  try {
    recommendations = validateModelOutput(rawResponse, validPathsSet);
  } catch (validationErr) {
    return {
      success: false,
      status: 502,
      error: {
        code: "INVALID_MODEL_OUTPUT",
        message: `Failed to validate model response: ${validationErr.message}`
      }
    };
  }

  return {
    success: true,
    status: 200,
    data: {
      recommendations,
      model,
      summary: {
        totalRecommendations: recommendations.length,
        totalFilesScanned: files.length,
        ollamaDurationMs,
        totalDurationMs: Date.now() - startTime
      }
    }
  };
}

module.exports = {
  getOllamaConfig,
  checkOllamaStatus,
  buildPrompt,
  validateModelOutput,
  generateRecommendations,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_RECOMMENDATION_TYPES,
  ALLOWED_CONFIDENCE_LEVELS
};
