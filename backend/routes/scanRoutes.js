const express = require("express");
const { scanDirectory, getScanConfig } = require("../services/scanService");

const router = express.Router();

/**
 * GET /api/scan/config
 * Returns public metadata about the configured approved scan root.
 */
router.get("/config", (req, res) => {
  const config = getScanConfig();
  res.status(200).json({
    success: true,
    data: config
  });
});

/**
 * POST /api/scan
 * Scans an approved directory in read-only mode and returns metadata.
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

    const result = await scanDirectory(requestedPath);

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
