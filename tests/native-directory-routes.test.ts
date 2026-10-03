import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createApp } from "../apps/server/src/app.js";
const native = vi.hoisted(() => ({
  platform: "darwin",
  calls: [] as {
    finish: (error: unknown, stdout: string, stderr: string) => void;
    kill: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("node:os", async () => ({
  ...(await vi.importActual<typeof import("node:os")>("node:os")),
  platform: () => native.platform,
}));
vi.mock("node:child_process", async () => {
  const childProcess =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { EventEmitter } = await import("node:events");
  return {
    ...childProcess,
    execFile: (
      file: string,
      _args: unknown,
      _options: unknown,
      finish: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      if (file !== "/usr/bin/osascript")
        throw new Error("No real executable is allowed in this fixture");
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
      });
      native.calls.push({ finish, kill: child.kill });
      return child;
    },
  };
});
const fixtures: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  for (const call of native.calls) call.finish(null, "", "");
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  native.calls = [];
  native.platform = "darwin";
});
async function setup(container = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-routes-")));
  fixtures.push(root);
  const browse = join(root, "projects");
  await mkdir(browse);
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: join(root, "state"),
    browseRoots: [browse],
    container,
  });
  apps.push(app);
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const session = await app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "fixture" },
  });
  return {
    app,
    browse,
    headers: {
      ...headers,
      cookie: `review_session=${session.cookies[0]!.value}`,
    },
  };
}
test("only native macOS advertises the explicit system chooser, without opening a dialog on reads", async () => {
  const { app, headers } = await setup();
  const response = await app.inject({ url: "/api/directory-roots", headers });
  expect(response.json()).toMatchObject({
    nativePickerAvailable: true,
    roots: [],
  });
  expect(native.calls).toHaveLength(0);
  const docker = await setup(true);
  expect(
    (
      await docker.app.inject({
        url: "/api/directory-roots",
        headers: docker.headers,
      })
    ).json().nativePickerAvailable,
  ).toBe(false);
  expect(
    (
      await docker.app.inject({
        method: "POST",
        url: "/api/native-directory-picker",
        headers: docker.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(404);
  native.platform = "linux";
  const linux = await setup();
  expect(
    (
      await linux.app.inject({
        url: "/api/directory-roots",
        headers: linux.headers,
      })
    ).json().nativePickerAvailable,
  ).toBe(false);
  expect(
    (
      await linux.app.inject({
        method: "POST",
        url: "/api/native-directory-picker",
        headers: linux.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(404);
  expect(native.calls).toHaveLength(0);
});
test("native choice requires authenticated same-origin explicit POST with no client script arguments", async () => {
  const { app, browse, headers } = await setup();
  for (const altered of [
    { ...headers, cookie: "" },
    { ...headers, host: "foreign.test:7373" },
    { ...headers, origin: "http://foreign.test" },
  ])
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/native-directory-picker",
          headers: altered,
          payload: {},
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  for (const payload of [{ path: browse }, { script: "ignored" }, [], "text"])
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/native-directory-picker",
          headers: { ...headers, "content-type": "application/json" },
          payload: JSON.stringify(payload),
        })
      ).statusCode,
    ).toBe(400);
  expect(native.calls).toHaveLength(0);
  const chosen = app
    .inject({
      method: "POST",
      url: "/api/native-directory-picker",
      headers,
      payload: {},
    })
    .then((value) => value);
  await vi.waitFor(() => expect(native.calls).toHaveLength(1));
  native.calls[0]!.finish(null, browse + "\n", "");
  const result = await chosen;
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ path: browse });
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(
    (await app.inject({ url: "/api/repositories", headers })).json()
      .repositories,
  ).toEqual([]);
});
test("canceling the dialog kills only its owned process and never registers a repository", async () => {
  const { app, browse, headers } = await setup();
  const chosen = app
    .inject({
      method: "POST",
      url: "/api/native-directory-picker",
      headers,
      payload: {},
    })
    .then((value) => value);
  await vi.waitFor(() => expect(native.calls).toHaveLength(1));
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/native-directory-picker",
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(429);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/native-directory-picker",
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(204);
  expect(native.calls[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  native.calls[0]!.finish(null, browse + "\n", "");
  expect((await chosen).json()).toEqual({ path: null });
  expect(
    (await app.inject({ url: "/api/repositories", headers })).json()
      .repositories,
  ).toEqual([]);
});

test("shutdown cancels a pending native picker before waiting for its HTTP request", async () => {
  const { app, browse, headers } = await setup();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listener missing");
  const response = new Promise<{
    statusCode: number | undefined;
    body: string;
  }>((resolve, reject) => {
    const pending = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/api/native-directory-picker",
        method: "POST",
        agent: false,
        headers: {
          ...headers,
          "content-type": "application/json",
          connection: "close",
        },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () =>
          resolve({ statusCode: incoming.statusCode, body }),
        );
      },
    );
    pending.on("error", reject);
    pending.end("{}");
  });
  await vi.waitFor(() => expect(native.calls).toHaveLength(1));
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  try {
    await vi.waitFor(
      () =>
        expect(native.calls[0]!.kill).toHaveBeenCalledExactlyOnceWith(
          "SIGKILL",
        ),
      { timeout: 500 },
    );
    expect(closed).toBe(false);
    native.calls[0]!.finish(null, browse + "\n", "");
    const result = await response;
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ path: null });
    await closing;
    expect(closed).toBe(true);
  } finally {
    // Release the owned fixture request even when the regression assertion fails.
    native.calls[0]!.finish(null, "", "");
    await Promise.all([response, closing]);
  }
});
