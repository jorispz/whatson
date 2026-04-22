import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// .env lives at the project root (one level above server/)
dotenv.config({ path: path.resolve(here, "..", "..", ".env") });

export const config = {
  tmdbAccessToken: required("TMDB_ACCESS_TOKEN"),
  port: Number(process.env.PORT ?? 3001),
  region: "NL" as const,
  language: "en-US" as const,
  dbPath: path.resolve(here, "..", "data", "whatson.db"),
  providerNames: {
    netflix: "Netflix",
    disneyPlus: "Disney Plus",
    hboMax: "HBO Max",
    ziggoTv: "Ziggo TV",
  },
  autoSyncHours: Number(process.env.AUTO_SYNC_HOURS ?? 24),
  autoSyncEnabled: (process.env.AUTO_SYNC ?? "true").toLowerCase() !== "false",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
