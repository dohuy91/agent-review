// Requires a running Docker engine and Node22.22+. Owns only named synthetic resources.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const suffix = randomBytes(6).toString("hex");
const name = `agent-review-smoke-${suffix}`;
const volume = `${name}-state`,
  image = `${name}:test`;
const temp = await mkdtemp(join(tmpdir(), "agent-review-docker-"));
const repo = join(temp, "repo");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 180000 });
let containerOwned = false,
  volumeCreated = false,
  imageCreated = false;
async function snapshot(path) {
  const h = createHash("sha256");
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      h.update(full.slice(path.length));
      if (entry.isDirectory()) await walk(full);
      else h.update(await readFile(full));
    }
  }
  await walk(path);
  return h.digest("hex");
}
const origin = "http://127.0.0.1:7373";
let cookie, lastToken;
let cleanupFailed = false;
async function request(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  return response;
}
async function boot() {
  let token,
    ready = false;
  for (let i = 0; i < 100; i++) {
    const state = JSON.parse(docker("inspect", name))[0].State;
    if (!state.Running)
      throw new Error(
        "Container exited before launch; inspect its private logs locally",
      );
    const matches = [...docker("logs", name).matchAll(/#token=([a-f0-9]+)/g)];
    token = matches.at(-1)?.[1];
    if (token && token !== lastToken) {
      try {
        if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready && token, "Fresh launch URL not available");
  lastToken = token;
  cookie = undefined;
  const session = await request("/api/session", {
    method: "POST",
    body: { token },
  });
  assert.equal(session.status, 200);
  cookie = session.headers.get("set-cookie").split(";")[0];
  const repos = await (await request("/api/repositories")).json();
  const prefix = `/api/repositories/${repos.selectedRepositoryId}`;
  const response = await request(`${prefix}/review?base=demo-base&mode=full`);
  assert.equal(response.status, 200);
  return { prefix, review: await response.json() };
}
try {
  docker("info");
  execFileSync(process.execPath, ["scripts/create-demo.mjs", repo]);
  await chmod(repo, 0o755);
  const before = await snapshot(repo);
  execFileSync(
    "docker",
    [
      "build",
      "--build-arg",
      "REVIEW_UID=10001",
      "--build-arg",
      "REVIEW_GID=10001",
      "-t",
      image,
      ".",
    ],
    { stdio: "inherit", timeout: 600000 },
  );
  imageCreated = true;
  docker("volume", "create", volume);
  volumeCreated = true;
  // A failed start can still leave a container referencing the volume/image.
  containerOwned = true;
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-p",
    "127.0.0.1:7373:7373",
    "--mount",
    `type=bind,source=${repo},target=${repo},readonly`,
    "--mount",
    `type=volume,source=${volume},target=/state`,
    image,
    repo,
    "--base",
    "demo-base",
  );
  let { prefix, review } = await boot();
  assert.ok(review.files.some((file) => file.path === "deleted.txt"));
  const diffResponse = await request(
    `${prefix}/diff?reviewId=${review.id}&path=deleted.txt`,
  );
  assert.equal(diffResponse.status, 200);
  const diff = await diffResponse.json();
  assert.ok(diff.oldContent.includes("Legacy workflow"));
  const noteResponse = await request(`${prefix}/comments`, {
    method: "POST",
    body: {
      reviewId: review.id,
      path: "deleted.txt",
      side: "old",
      startLine: 1,
      endLine: 2,
      body: "Docker restart fixture",
      severity: "warning",
    },
  });
  assert.equal(noteResponse.status, 201);
  const note = await noteResponse.json();
  assert.equal(
    (
      await request("/api/repositories", {
        headers: { host: "evil.test:7373" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/session", {
        method: "POST",
        body: { token: "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/session", {
        method: "POST",
        body: { token: "wrong" },
        headers: { origin: "http://evil.test" },
      })
    ).status,
    403,
  );
  const inspect = JSON.parse(docker("inspect", name))[0];
  assert.deepEqual(inspect.NetworkSettings.Ports["7373/tcp"], [
    { HostIp: "127.0.0.1", HostPort: "7373" },
  ]);
  assert.equal(inspect.Mounts.find((m) => m.Destination === repo).RW, false);
  const probe = `const fs=require('fs');const assert=require('assert/strict');assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);for(const p of fs.readdirSync('/state')){const s=fs.statSync('/state/'+p);assert.equal(s.uid,10001);assert.equal(s.gid,10001);assert.equal(s.mode&0o077,0);}assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(repo, "forbidden-write"))},'bad'));console.log('nonroot UID/GID, private state permissions and read-only source verified')`;
  console.log(docker("exec", name, "node", "-e", probe).trim());
  docker("stop", "--time", "15", name);
  docker("start", name);
  ({ prefix, review } = await boot());
  const notes = await (
    await request(`${prefix}/comments?reviewId=${review.id}`)
  ).json();
  assert.ok(
    notes.comments.some(
      (c) =>
        c.id === note.id &&
        c.side === "old" &&
        c.startLine === 1 &&
        c.endLine === 2 &&
        c.body === "Docker restart fixture",
    ),
  );
  assert.equal(await snapshot(repo), before, "Source or Git metadata changed");
} finally {
  for (const args of [
    containerOwned && ["rm", "-f", name],
    volumeCreated && ["volume", "rm", volume],
    imageCreated && ["image", "rm", image],
  ].filter(Boolean)) {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 30000,
    });
    if (result.error || result.status !== 0) {
      cleanupFailed = true;
      process.exitCode = 1;
      console.error(
        `Unable to clean up owned Docker resource (${args.join(" ")}): ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
      );
    }
  }
  await rm(temp, { recursive: true, force: true });
}

if (!cleanupFailed)
  console.log(
    "Docker smoke passed: build, diff, security, old-range restart persistence, source integrity, loopback port, UID and private state; owned resources removed.",
  );
