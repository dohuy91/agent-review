// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import RepositoryPicker from "../apps/web/src/components/RepositoryPicker.js";
import Modal from "../apps/web/src/components/Modal.js";
import type {
  DirectoryListing,
  DirectoryRootsResponse,
} from "../packages/shared/src/directories.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const roots: DirectoryRootsResponse = {
  roots: [
    { id: "projects", label: "Projects", path: "/projects" },
    { id: "work", label: "Work", path: "/work" },
  ],
};
const listing = (path = "", rootId = "projects"): DirectoryListing => ({
  rootId,
  relativePath: path,
  path:
    (rootId === "projects" ? "/projects" : "/work") + (path ? `/${path}` : ""),
  entries: path
    ? []
    : [
        { name: "repo", relativePath: "repo" },
        { name: "second", relativePath: "second" },
      ],
  nextCursor: null,
  truncated: false,
});
function respond(value: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => value };
}
function setup(handler?: (url: string) => unknown | Promise<unknown>) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (handler) {
      const response = await handler(url);
      if (response !== undefined) return response;
    }
    if (url === "/api/directory-roots") return respond(roots);
    const query = new URL(url, "http://fixture").searchParams;
    return respond(
      listing(query.get("path") ?? "", query.get("rootId") ?? "projects"),
    );
  });
  return requested;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("folder navigation never selects a repository until Select this folder is clicked", async () => {
  const requested = setup(),
    select = vi.fn(),
    cancel = vi.fn();
  render(<RepositoryPicker onSelect={select} onCancel={cancel} />);
  await screen.findByRole("button", { name: "Open folder repo" });
  expect(screen.getByRole("heading", { name: "Open repository" })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText(/server running Agent Review/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open folder repo" }));
  await screen.findByText("/projects/repo");
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("/projects/repo");
  expect(requested.every((url) => url.startsWith("/api/directory-"))).toBe(
    true,
  );
});
test("Back to parent and configured root selection stay inside returned roots", async () => {
  setup();
  render(<RepositoryPicker onSelect={() => {}} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Open folder repo" });
  expect(
    (screen.getByRole("button", { name: "Up one folder" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open folder repo" }));
  await screen.findByText("/projects/repo");
  fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
  await screen.findByRole("button", { name: "Open folder second" });
  fireEvent.change(screen.getByLabelText("Browse location"), {
    target: { value: "work" },
  });
  await screen.findByText("/work");
  expect(
    (screen.getByRole("button", { name: "Up one folder" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
test("Cancel and Escape dismiss the picker without changing the parent's selected repository", async () => {
  setup();
  const select = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <p>Current repository: original</p>
        {open && (
          <Modal label="Open repository" onClose={() => setOpen(false)}>
            <RepositoryPicker
              onSelect={select}
              onCancel={() => setOpen(false)}
            />
          </Modal>
        )}
      </>
    );
  }
  const first = render(<Harness />);
  await screen.findByRole("button", { name: "Open folder repo" });
  fireEvent.click(screen.getByRole("button", { name: "Open folder repo" }));
  await screen.findByText("/projects/repo");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByText("Current repository: original")).toBeTruthy();
  first.unmount();
  render(<Harness />);
  await screen.findByRole("button", { name: "Open folder repo" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(select).not.toHaveBeenCalled();
});
test("failed folder navigation preserves the last good location and exposes retry", async () => {
  let fail = true;
  setup((url) =>
    url.includes("path=repo") && fail
      ? respond({ error: "Folder cannot be read. Check permissions." }, 403)
      : undefined,
  );
  const select = vi.fn();
  render(<RepositoryPicker onSelect={select} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Open folder repo" });
  fireEvent.click(screen.getByRole("button", { name: "Open folder repo" }));
  await screen.findByRole("alert");
  expect(screen.getByText("/projects")).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Check permissions");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("/projects/repo");
  expect(screen.queryByRole("alert")).toBeNull();
});
test("a newer root selection wins over a delayed directory response", async () => {
  const delayed = deferred<ReturnType<typeof respond>>();
  setup((url) => (url.includes("path=repo") ? delayed.promise : undefined));
  const select = vi.fn();
  render(<RepositoryPicker onSelect={select} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Open folder repo" });
  fireEvent.click(screen.getByRole("button", { name: "Open folder repo" }));
  expect(
    (
      screen.getByRole("button", {
        name: "Select this folder",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Browse location"), {
    target: { value: "work" },
  });
  await screen.findByText("/work");
  await act(async () => {
    delayed.resolve(respond(listing("repo")));
    await delayed.promise;
  });
  expect(screen.queryByText("/projects/repo")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("/work");
});
test("empty configuration gives actionable mount and flag instructions", async () => {
  setup((url) =>
    url === "/api/directory-roots"
      ? respond({
          roots: [],
          message:
            "Mount the project folder and launch with --browse-root followed by its mounted path.",
        })
      : undefined,
  );
  render(<RepositoryPicker onSelect={() => {}} onCancel={() => {}} />);
  await screen.findByText(/Mount the project folder/);
  expect(
    (
      screen.getByRole("button", {
        name: "Select this folder",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
test("pagination appends folders and exposes bounded listing feedback", async () => {
  setup((url) =>
    url.includes("directory-listing")
      ? respond(
          url.includes("cursor=100")
            ? {
                ...listing(),
                entries: [{ name: "later", relativePath: "later" }],
              }
            : {
                ...listing(),
                nextCursor: "100",
                truncated: true,
                message:
                  "Some folders are omitted; use a narrower --browse-root.",
              },
        )
      : undefined,
  );
  render(<RepositoryPicker onSelect={() => {}} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Load more folders" });
  expect(screen.getByText(/Some folders are omitted/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more folders" }));
  await screen.findByRole("button", { name: "Open folder later" });
  expect(screen.getByRole("button", { name: "Open folder repo" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Load more folders" }),
  ).toBeNull();
});
test("busy registration disables repeat selection, displays parent errors and keeps Cancel available", async () => {
  setup();
  const select = vi.fn();
  const { rerender } = render(
    <RepositoryPicker onSelect={select} onCancel={() => {}} />,
  );
  await screen.findByRole("button", { name: "Open folder repo" });
  rerender(
    <RepositoryPicker
      onSelect={select}
      onCancel={() => {}}
      busy
      error="Choose a Git worktree with a commit"
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("Git worktree");
  expect(
    (
      screen.getByRole("button", {
        name: "Opening repository…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Opening repository…" }));
  expect(select).not.toHaveBeenCalled();
});
test("pending selection and late requests cannot select twice or update a dismissed picker", async () => {
  const selected = deferred<void>();
  setup();
  const select = vi.fn(() => selected.promise),
    cancel = vi.fn();
  const { unmount } = render(
    <RepositoryPicker onSelect={select} onCancel={cancel} />,
  );
  await screen.findByRole("button", { name: "Open folder repo" });
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  fireEvent.click(screen.getByRole("button", { name: "Opening repository…" }));
  expect(select).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
  unmount();
  await act(async () => {
    selected.resolve();
    await selected.promise;
  });
});

test("a failed root request can be retried without changing parent context", async () => {
  let failed = true;
  setup((url) =>
    url === "/api/directory-roots" && failed
      ? respond(
          { error: "Configured folder changed. Restart the server." },
          403,
        )
      : undefined,
  );
  const select = vi.fn();
  render(<RepositoryPicker onSelect={select} onCancel={() => {}} />);
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "Configured folder changed",
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Select this folder",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Open folder repo" });
  expect(select).not.toHaveBeenCalled();
});

function nativeFixture(
  choose: () =>
    Promise<ReturnType<typeof respond>> | ReturnType<typeof respond>,
) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, options?: RequestInit) => {
    const url = String(input),
      method = options?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url === "/api/directory-roots")
      return respond({ roots: [], nativePickerAvailable: true });
    if (url === "/api/native-directory-picker" && method === "POST")
      return choose();
    if (url === "/api/native-directory-picker" && method === "DELETE")
      return { ok: true, status: 204, json: async () => ({}) };
    throw new Error(`Unexpected fixture request: ${method} ${url}`);
  });
  return requests;
}
test("native macOS chooser opens only after an explicit click and registers only its selected folder", async () => {
  const requests = nativeFixture(() => respond({ path: "/projects/native" })),
    select = vi.fn();
  render(<RepositoryPicker onSelect={select} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Choose folder" });
  expect(requests).toEqual(["GET /api/directory-roots"]);
  expect(
    screen.queryByRole("button", { name: "Select this folder" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
  await waitFor(() =>
    expect(select).toHaveBeenCalledExactlyOnceWith("/projects/native"),
  );
  expect(requests).toEqual([
    "GET /api/directory-roots",
    "POST /api/native-directory-picker",
  ]);
});
test("canceling the native macOS dialog leaves the current parent context unchanged", async () => {
  nativeFixture(() => respond({ path: null }));
  const select = vi.fn();
  render(<RepositoryPicker onSelect={select} onCancel={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));
  await screen.findByRole("button", { name: "Choose folder" });
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});
test("dismissing the picker cancels its owned native dialog and ignores a delayed choice", async () => {
  const delayed = deferred<ReturnType<typeof respond>>(),
    requests = nativeFixture(() => delayed.promise),
    select = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <RepositoryPicker onSelect={select} onCancel={() => setOpen(false)} />
    ) : (
      <p>Current repository unchanged</p>
    );
  }
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(requests).toContain("DELETE /api/native-directory-picker");
  await act(async () => {
    delayed.resolve(respond({ path: "/projects/late" }));
    await delayed.promise;
  });
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByText("Current repository unchanged")).toBeTruthy();
});
test("native chooser failures expose retry without opening another dialog automatically", async () => {
  let fails = true;
  const requests = nativeFixture(() =>
    fails
      ? respond({ error: "macOS blocked the folder dialog." }, 403)
      : respond({ path: null }),
  );
  render(<RepositoryPicker onSelect={() => {}} onCancel={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("macOS blocked");
  expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(
    1,
  );
  fails = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Choose folder" });
  expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(
    2,
  );
});
