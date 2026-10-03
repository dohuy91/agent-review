import type { DatabaseSync } from "node:sqlite";
import type {
  ReviewObservation,
  ReviewHistoryEntry,
} from "../../shared/src/index.js";
export function saveReviewHistory(
  db: DatabaseSync,
  observation: ReviewObservation,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS review_history(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,metadata TEXT NOT NULL)",
  );
  const { id, repositoryId, fingerprint, base, mergeBase, head, branch, mode } =
    observation;
  const entry: ReviewHistoryEntry = {
    id,
    repositoryId,
    fingerprint,
    base,
    mergeBase,
    head,
    branch,
    mode,
    acceptedAt: new Date().toISOString(),
    fileCount: observation.files.length,
    historicalContent: mode === "branch" ? "git-objects-only" : "unavailable",
  };
  db.prepare("INSERT OR IGNORE INTO review_history VALUES(?,?,?)").run(
    id,
    repositoryId,
    JSON.stringify(entry),
  );
  db.prepare(
    "DELETE FROM review_history WHERE repository_id=? AND id NOT IN (SELECT id FROM review_history WHERE repository_id=? ORDER BY rowid DESC LIMIT 1000)",
  ).run(repositoryId, repositoryId);
}
export function reviewHistory(
  db: DatabaseSync,
  repositoryId: string,
): ReviewHistoryEntry[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS review_history(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,metadata TEXT NOT NULL)",
  );
  return (
    db
      .prepare(
        "SELECT metadata FROM review_history WHERE repository_id=? ORDER BY rowid DESC LIMIT 1000",
      )
      .all(repositoryId) as { metadata: string }[]
  ).map((r) => JSON.parse(r.metadata));
}
