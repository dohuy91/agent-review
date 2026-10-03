import React, { useEffect, useRef, useState } from "react";
import type {
  DirectoryListing,
  DirectoryRoot,
  DirectoryRootsResponse,
} from "../../../../packages/shared/src/directories.js";
import { api } from "../api.js";
import "./RepositoryPicker.css";

export interface RepositoryPickerProps {
  onSelect: (path: string) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}
/** The parent owns the modal, repository registration and accepted review context. */
export default function RepositoryPicker({
  onSelect,
  onCancel,
  busy = false,
  error,
}: RepositoryPickerProps) {
  const [roots, setRoots] = useState<DirectoryRoot[]>([]);
  const [rootId, setRootId] = useState("");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [nativePickerAvailable, setNativePickerAvailable] = useState(false);
  const [choosingNative, setChoosingNative] = useState(false);
  const nativeRequest = useRef<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [configurationMessage, setConfigurationMessage] = useState<
    string | null
  >(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const selectionLock = useRef(false);
  const retry = useRef<() => void>(() => {});
  const unavailable = busy || selecting;

  function fail(error: unknown) {
    setLocalError(
      error instanceof Error
        ? error.message
        : "The folder could not be opened. Try again.",
    );
  }
  async function browse(id: string, path = "", cursor?: string) {
    const request = ++revision.current;
    retry.current = () => {
      void browse(id, path, cursor);
    };
    setRootId(id);
    setLoading(true);
    setLocalError(null);
    try {
      const query = new URLSearchParams({
        rootId: id,
        path,
        ...(cursor ? { cursor } : {}),
      });
      const result = await api<DirectoryListing>(`/directory-listing?${query}`);
      if (!mounted.current || revision.current !== request) return;
      setListing((previous) => ({
        ...result,
        entries:
          cursor &&
          previous?.rootId === result.rootId &&
          previous.relativePath === result.relativePath
            ? [
                ...new Map(
                  [...previous.entries, ...result.entries].map((entry) => [
                    entry.relativePath,
                    entry,
                  ]),
                ).values(),
              ]
            : result.entries,
      }));
    } catch (error) {
      if (mounted.current && revision.current === request) fail(error);
    } finally {
      if (mounted.current && revision.current === request) setLoading(false);
    }
  }
  async function loadRoots() {
    const request = ++revision.current;
    retry.current = () => {
      void loadRoots();
    };
    setLoading(true);
    setLocalError(null);
    try {
      const result = await api<DirectoryRootsResponse>("/directory-roots");
      if (!mounted.current || revision.current !== request) return;
      setRoots(result.roots);
      setNativePickerAvailable(result.nativePickerAvailable === true);
      setConfigurationMessage(result.message ?? null);
      if (!result.nativePickerAvailable && result.roots[0]) {
        void browse(result.roots[0].id);
        return;
      }
      setLoading(false);
    } catch (error) {
      if (mounted.current && revision.current === request) {
        fail(error);
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void loadRoots();
    return () => {
      mounted.current = false;
      ++revision.current;
      cancelNative();
    };
  }, []);
  async function select() {
    if (
      !listing ||
      loading ||
      unavailable ||
      localError ||
      selectionLock.current
    )
      return;
    selectionLock.current = true;
    setSelecting(true);
    try {
      await onSelect(listing.path);
    } catch (error) {
      if (mounted.current) fail(error);
    } finally {
      selectionLock.current = false;
      if (mounted.current) setSelecting(false);
    }
  }
  function cancelNative() {
    const id = nativeRequest.current;
    if (!id) return;
    nativeRequest.current = null;
    void api(
      "/native-directory-picker",
      "DELETE",
      {},
      { "X-Review-Picker": id },
    ).catch(() => {});
  }
  async function chooseNative() {
    if (unavailable || choosingNative || selectionLock.current) return;
    const request = ++revision.current;
    const id = crypto.randomUUID();
    nativeRequest.current = id;
    selectionLock.current = true;
    setChoosingNative(true);
    setLocalError(null);
    retry.current = () => {
      void chooseNative();
    };
    try {
      const result = await api<{ path: string | null }>(
        "/native-directory-picker",
        "POST",
        {},
        { "X-Review-Picker": id },
      );
      if (nativeRequest.current === id) nativeRequest.current = null;
      if (!mounted.current || request !== revision.current) return;
      if (result.path) {
        setSelecting(true);
        await onSelect(result.path);
      }
    } catch (error) {
      cancelNative();
      if (mounted.current && request === revision.current) fail(error);
    } finally {
      if (nativeRequest.current === id) nativeRequest.current = null;
      selectionLock.current = false;
      if (mounted.current && request === revision.current) {
        setChoosingNative(false);
        setSelecting(false);
      }
    }
  }
  function cancel() {
    ++revision.current;
    cancelNative();
    onCancel();
  }

  return (
    <div className="repository-picker">
      <header>
        <h2>Open repository</h2>
        <p>
          {nativePickerAvailable
            ? "Choose a folder in the macOS dialog on the Mac running Agent Review."
            : "Choose a folder on the server running Agent Review. In Docker, only configured mounted folders are available."}
        </p>
      </header>
      {nativePickerAvailable && (
        <>
          <button
            type="button"
            className="primary"
            disabled={unavailable || choosingNative}
            onClick={() => {
              void chooseNative();
            }}
          >
            {unavailable
              ? "Opening repository…"
              : choosingNative
                ? "Choosing folder…"
                : "Choose folder"}
          </button>
          {choosingNative && !unavailable && (
            <p role="status">
              Choose a folder in the macOS dialog, or cancel it to keep the
              current repository.
            </p>
          )}
        </>
      )}
      {!nativePickerAvailable && roots.length > 0 && (
        <label className="repository-picker-location">
          Browse location
          <select
            value={rootId}
            disabled={unavailable}
            onChange={(event) => {
              void browse(event.target.value);
            }}
          >
            {roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.label} · {root.path}
              </option>
            ))}
          </select>
        </label>
      )}
      {configurationMessage && (
        <p className="repository-picker-notice">{configurationMessage}</p>
      )}
      {listing && (
        <>
          <div className="repository-picker-path">
            <button
              type="button"
              disabled={unavailable || loading || !listing.relativePath}
              onClick={() => {
                void browse(
                  listing.rootId,
                  listing.relativePath.split("/").slice(0, -1).join("/"),
                );
              }}
              aria-label="Up one folder"
            >
              ↑ Up
            </button>
            <output aria-label="Current folder">{listing.path}</output>
          </div>
          <ul
            className="repository-picker-folders"
            aria-label="Folders"
            aria-busy={loading}
          >
            {listing.entries.map((entry) => (
              <li key={entry.relativePath}>
                <button
                  type="button"
                  disabled={unavailable || loading}
                  aria-label={`Open folder ${entry.name}`}
                  onClick={() => {
                    void browse(listing.rootId, entry.relativePath);
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
                  </svg>
                  <span>{entry.name}</span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
            {!listing.entries.length && !loading && (
              <li className="repository-picker-empty">No visible subfolders</li>
            )}
          </ul>
          {listing.message && (
            <p className="repository-picker-notice">{listing.message}</p>
          )}
          {listing.nextCursor && (
            <button
              type="button"
              disabled={unavailable || loading}
              onClick={() => {
                void browse(
                  listing.rootId,
                  listing.relativePath,
                  listing.nextCursor!,
                );
              }}
            >
              Load more folders
            </button>
          )}
        </>
      )}
      {loading && <p role="status">Loading folders…</p>}
      {(localError || error) && (
        <div className="repository-picker-error" role="alert">
          <p>{localError || error}</p>
          {localError && (
            <button
              type="button"
              disabled={unavailable || loading}
              onClick={() => retry.current()}
            >
              Retry
            </button>
          )}
        </div>
      )}
      <footer>
        <button type="button" onClick={cancel}>
          Cancel
        </button>
        {!nativePickerAvailable && (
          <button
            type="button"
            className="primary"
            disabled={!listing || loading || unavailable || !!localError}
            onClick={() => {
              void select();
            }}
          >
            {unavailable ? "Opening repository…" : "Select this folder"}
          </button>
        )}
      </footer>
    </div>
  );
}
