const app = require("./app");
const { initOrganizationService } = require("./services/organizationService");

const port = Number.parseInt(process.env.PORT || "3000", 10);

initOrganizationService()
  .then((metrics) => {
    if (metrics.recoveryRequiredCount > 0) {
      console.warn(`[filoAI Recovery] ${metrics.recoveryRequiredCount} operation(s) require recovery review.`);
    }
  })
  .catch((err) => {
    console.warn("[filoAI Recovery] Warning during startup journal recovery audit:", err.message);
  });

const server = app.listen(port, () => {
  console.log(`filoAI is running at http://localhost:${port}`);
});

server.on("error", (error) => {
  console.error("Unable to start filoAI:", error.message);
  process.exitCode = 1;
});
