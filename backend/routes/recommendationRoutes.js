const express = require("express");
const {
  checkOllamaStatus,
  generateRecommendations
} = require("../services/recommendationService");

const router = express.Router();

/**
 * GET /api/recommendations/status
 * Returns Ollama connectivity and model installation readiness without exposing local server paths.
 */
router.get("/status", async (req, res, next) => {
  try {
    const status = await checkOllamaStatus();
    return res.status(200).json({
      success: true,
      data: status
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/recommendations
 * Generates local AI organization recommendations based on scanned file metadata and duplicate metrics.
 */
router.post("/", async (req, res, next) => {
  try {
    let requestedPath = ".";

    if (req.body && typeof req.body === "object") {
      if (typeof req.body.path === "string") {
        requestedPath = req.body.path;
      } else if (typeof req.body.directory === "string") {
        requestedPath = req.body.directory;
      }
    }

    const result = await generateRecommendations(requestedPath);

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.error
      });
    }

    return res.status(result.status || 200).json({
      success: true,
      data: result.data
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
