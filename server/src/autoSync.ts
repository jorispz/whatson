import { config } from "./config.js";
import { getMeta } from "./db.js";
import { triggerSync } from "./sync.js";

const STARTUP_DELAY_MS = 10_000;
const RETRY_DELAY_MS = 60 * 60 * 1000;

export function startAutoSync(): void {
  if (!config.autoSyncEnabled) {
    console.log("auto-sync: disabled (AUTO_SYNC=false)");
    return;
  }
  if (!Number.isFinite(config.autoSyncHours) || config.autoSyncHours <= 0) {
    console.log(`auto-sync: disabled (invalid AUTO_SYNC_HOURS=${config.autoSyncHours})`);
    return;
  }

  const intervalMs = config.autoSyncHours * 60 * 60 * 1000;

  const schedule = (delayMs: number): void => {
    const mins = Math.round(delayMs / 60_000);
    const when = new Date(Date.now() + delayMs).toISOString();
    console.log(`auto-sync: next run in ${mins} min (${when})`);
    setTimeout(() => {
      void runOnce();
    }, delayMs).unref();
  };

  const runOnce = async (): Promise<void> => {
    const started = Date.now();
    try {
      console.log("auto-sync: starting");
      const result = await triggerSync();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`auto-sync: ok in ${secs}s — ${result.totalTitles} titles`);
      schedule(intervalMs);
    } catch (err) {
      console.error("auto-sync: failed —", err);
      schedule(RETRY_DELAY_MS);
    }
  };

  const lastSync = getMeta("last_sync_at");
  if (!lastSync) {
    console.log("auto-sync: no prior sync, will run after startup");
    setTimeout(() => void runOnce(), STARTUP_DELAY_MS).unref();
    return;
  }

  const age = Date.now() - new Date(lastSync).getTime();
  if (!Number.isFinite(age) || age >= intervalMs) {
    const hoursAgo = Math.round(age / 3_600_000);
    console.log(`auto-sync: last run ${hoursAgo}h ago (stale), will run after startup`);
    setTimeout(() => void runOnce(), STARTUP_DELAY_MS).unref();
  } else {
    schedule(intervalMs - age);
  }
}
