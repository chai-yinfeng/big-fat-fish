import { FileJournal } from "../../core/src/journal.js";

/** Production uses the Host's prebuilt kernel lock, never a stale-PID heuristic. */
export async function openCompanionJournal(file) {
  let lockExclusive;
  try {
    ({ tryLockExclusive: lockExclusive } = await import("@deepseek-ai/node-addon-system/flock"));
  } catch {
    throw new Error("native journal locking is unavailable; install the matching DSH system addon before starting companion");
  }
  return FileJournal.open(file, { lockExclusive });
}
