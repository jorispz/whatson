import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { config } from "./config.js";
import { api } from "./routes.js";
import { startAutoSync } from "./autoSync.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use("/api", api);

// In production, serve the built client from ../../client/dist
const clientDist = path.resolve(here, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Terminal error handler: anything a route throws (sync) or rejects with (via
// asyncHandler) ends here as JSON rather than Express's default HTML page.
// body-parser errors carry their own status (e.g. 400 for malformed JSON).
const onError: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  if (status >= 500) console.error("unhandled route error:", err);
  res.status(status).json({ error: status >= 500 ? "internal error" : String((err as Error).message ?? "bad request") });
};
app.use(onError);

app.listen(config.port, () => {
  console.log(`whatson server listening on http://localhost:${config.port}`);
  startAutoSync();
});
