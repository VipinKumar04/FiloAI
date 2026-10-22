const express = require("express");
const {
  previewOperation,
  executeOperation,
  undoOperation,
  resolveRecoveryOperation,
  getOperationHistory
} = require("../services/organizationService");

const router = express.Router();

/**
 * POST /api/organization/preview
 * Previews a proposed file move and generates a time-limited approval token.
 * Strictly read-only; does not modify the filesystem.
 */
router.post("/preview", async (req, res, next) => {
  try {
    const result = await previewOperation(req.body || {});

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

/**
 * POST /api/organization/execute
 * Executes a previously previewed and explicitly approved file organization move.
 * Strictly verifies approval token, paths, root containment, and conflict status.
 */
router.post("/execute", async (req, res, next) => {
  try {
    const result = await executeOperation(req.body || {});

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

/**
 * POST /api/organization/undo
 * Restores a moved file to its original source path after verifying no conflict exists.
 */
router.post("/undo", async (req, res, next) => {
  try {
    const result = await undoOperation(req.body || {});

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

/**
 * POST /api/organization/recover
 * Explicitly resolves an operation flagged as recovery_required after user review.
 */
router.post("/recover", async (req, res, next) => {
  try {
    const result = await resolveRecoveryOperation(req.body || {});

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

/**
 * GET /api/organization/history
 * Returns the operation log of completed and recovery actions.
 */
router.get("/history", (req, res) => {
  const historyData = getOperationHistory();
  return res.status(200).json({
    success: true,
    data: historyData
  });
});

module.exports = router;
