// Explicit local-only preview. Never imported by app.js or index.js. Does not load .env.
if (process.env.NODE_ENV !== "development")
  throw new Error("Preview requires NODE_ENV=development");
const express = require("express");
const cors = require("cors");
const {
  assistantDatabase,
  syntheticAuth,
} = require("../tests/helpers/assistant-db");
const { syntheticProvider } = require("../tests/helpers/synthetic-provider");
const { createStore } = require("../services/patient-assistant/store");
const { createAssistantRouter } = require("../routes/patient-assistant.routes");
async function main() {
  const pool = await assistantDatabase();
  const app = express();
  app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/ }));
  app.use(
    "/api/patient-assistant",
    createAssistantRouter({
      store: createStore(pool),
      provider: syntheticProvider({ delay: 100 }),
      ...syntheticAuth(pool),
    }),
  );
  const server = app.listen(3101, "127.0.0.1", () =>
    console.log(
      "Synthetic assistant preview: http://127.0.0.1:3101 (no OpenAI, no external DB)",
    ),
  );
  process.on("SIGINT", () =>
    server.close(() => pool.end().then(() => process.exit())),
  );
}
main().catch(() => {
  console.error("Preview startup failed");
  process.exitCode = 1;
});
