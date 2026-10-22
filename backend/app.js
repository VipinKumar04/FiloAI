const express = require("express");
const path = require("node:path");
const healthRoutes = require("./routes/healthRoutes");
const scanRoutes = require("./routes/scanRoutes");
const duplicateRoutes = require("./routes/duplicateRoutes");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use("/api/health", healthRoutes);
app.use("/api/scan", scanRoutes);
app.use("/api/duplicates", duplicateRoutes);
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "API endpoint not found."
    }
  });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({
    success: false,
    error: {
      code: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
      message: status >= 500 ? "An unexpected server error occurred." : err.message
    }
  });
});

module.exports = app;
