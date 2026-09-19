/** Page entry for scripts/calibrate.ts: the verification harness plus scored queries. */
import { scoredQuery } from "./harness";

declare global {
  interface Window {
    __kavachScored: typeof scoredQuery;
  }
}

window.__kavachScored = scoredQuery;
