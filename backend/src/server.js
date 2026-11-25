const { app } = require("./app");
const { env, getEnvSummary } = require("./config/env");
const scheduler = require("./services/scheduler.service");
const { registerAll } = require("./services/scheduler-tasks.service");

const server = app.listen(env.PORT, () => {
  const summary = getEnvSummary();
  console.log(`Server listening on port ${summary.port} (${summary.nodeEnv})`);
  console.log(`API ready at ${summary.apiPrefix}`);

  // Started here rather than in app.js on purpose: tests and scripts import
  // `app` directly, and starting a timer on import would have them sending
  // real email.
  registerAll();
  scheduler.start();
});

// Stop taking new scheduled work before the process goes, so a deploy does not
// kill a task half-way through sending a batch.
function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  scheduler.stop();
  server.close(() => process.exit(0));
  // Forced exit if a connection refuses to close, so a deploy cannot hang.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
