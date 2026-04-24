// Node 16 has no global fetch. Install undici's fetch — the same
// implementation Node 18+ uses natively — so the rest of the codebase can
// just call `fetch(...)` without per-file imports or runtime branching.
import { fetch } from "undici";

if (typeof globalThis.fetch === "undefined") {
  // @ts-expect-error — undici's fetch types differ slightly from the DOM
  // fetch types; the runtime contract is identical.
  globalThis.fetch = fetch;
}
