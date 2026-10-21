const app = require("./app");

const port = Number.parseInt(process.env.PORT || "3000", 10);

const server = app.listen(port, () => {
  console.log(`filoAI is running at http://localhost:${port}`);
});

server.on("error", (error) => {
  console.error("Unable to start filoAI:", error.message);
  process.exitCode = 1;
});
