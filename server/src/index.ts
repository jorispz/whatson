import "./fetchPolyfill.js";
import express from "express";
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

app.listen(config.port, () => {
  console.log(`whatson server listening on http://localhost:${config.port}`);
  startAutoSync();
});
