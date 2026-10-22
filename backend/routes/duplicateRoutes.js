const express = require("express");
const { findDuplicates } = require("../services/duplicateService");

const router = express.Router();

/**
 * POST /api/duplicates
 * Detects duplicate files in read-only mode using streaming SHA-256 hashes.
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

    const result = await findDuplicates(requestedPath);

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
  } catch (error) {
    next(error);
  }
});

module.exports = router;
