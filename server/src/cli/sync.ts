import { triggerSync, type SyncProgress } from "../sync.js";

async function main(): Promise<void> {
  console.log("Starting sync...");
  const result = await triggerSync((p: SyncProgress) => {
    console.log(`  ${p.provider.padEnd(12)} ${p.mediaType.padEnd(5)} ${p.count} titles`);
  });
  const secs = (result.durationMs / 1000).toFixed(1);
  console.log(
    `\nDone in ${secs}s — ${result.totalTitles} titles, ${result.totalAvailability} availability rows across ${result.providers.length} providers.`,
  );
  for (const p of result.providers) {
    console.log(`  ${p.key.padEnd(12)} -> ${p.name} (id=${p.id})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
