import React, { useEffect, useState } from "react";
import type {
  ReviewMode,
  HistoryResponse,
} from "../../../../packages/shared/src/index.js";
import { api } from "../api.js";
export default function HistoryPanel({
  repositoryId,
  reviewId,
  onSelect,
}: {
  repositoryId: string;
  reviewId: string;
  onSelect: (base: string, mode: ReviewMode, historyId?: string) => void;
}) {
  const [history, setHistory] = useState<HistoryResponse | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setHistory(null);
    setError("");
    void api<HistoryResponse>(
      `/repositories/${encodeURIComponent(repositoryId)}/history`,
    )
      .then((h) => {
        if (current) setHistory(h);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [repositoryId, reviewId]);
  return (
    <section className="agent-panel" aria-label="Review history">
      <strong>History</strong>
      <p>
        Branch history opens read-only retained Git endpoints. Mutable history
        reopens current endpoints; historic mutable content is not
        reconstructed.
      </p>
      {(history?.reviews ?? []).map((r) => (
        <div key={r.id}>
          <button
            onClick={() =>
              r.mode === "branch"
                ? onSelect(r.base, r.mode, r.id)
                : onSelect(r.base, r.mode)
            }
          >
            {r.mode} · {r.branch || "detached"} · {r.head.slice(0, 8)} ·{" "}
            {r.acceptedAt}
          </button>
          <small>
            {r.historicalContent === "unavailable"
              ? "Historical content unavailable"
              : "Historic Git objects only; availability depends on retained objects"}
          </small>
        </div>
      ))}
      {(history?.runs ?? []).map((r) => (
        <p key={r.id}>
          {r.adapter} · {r.status} · {r.createdAt}
          {r.error ? ` · ${r.error}` : ""}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
