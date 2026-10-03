// Native HTTP smoke. Creates and removes only its own synthetic repository/state.
// Run after pnpm install --frozen-lockfile and pnpm build. No provider or remote network calls.
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  realpath,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";

const source = fileURLToPath(new URL("../", import.meta.url));
const checkSavedContext = true;
const checkWorkspaceUX = true;
const owned = await realpath(
  await mkdtemp(join(tmpdir(), "agent-review-native-smoke-")),
);
const repository = join(owned, "repository");
const data = join(owned, "state");
const template = join(owned, "empty-git-template");
await mkdir(template);
// Every fixture Git command stays independent of inherited repository-routing settings.
const fixtureEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TEMPLATE_DIR: template,
  GIT_TERMINAL_PROMPT: "0",
};
const listener = createServer();
await new Promise((done, reject) =>
  listener.once("error", reject).listen(0, "127.0.0.1", done),
);
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const origin = `http://127.0.0.1:${port}`;
const git = (...args) =>
  execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: fixtureEnv,
  }).trim();
let directoryCheck = "not-run";
function localFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
}
let child;
let cookie;

async function start(explicitComparison = true) {
  let stdout = "";
  let stderr = "";
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(source, "apps/server/src/cli.ts"),
      repository,
      ...(explicitComparison ? ["--base", "demo-base", "--mode", "full"] : []),
      "--port",
      String(port),
      "--no-open",
    ],
    {
      cwd: source,
      env: { ...fixtureEnv, REVIEW_DATA_DIR: data },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const token = await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Native startup timed out")),
      20000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/#token=([a-f0-9]{64})/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Native startup exited ${code}: ${stderr}`));
    });
  });
  const session = await localFetch(origin + "/api/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(session.status, 200);
  assert.match(session.headers.get("set-cookie"), /HttpOnly/i);
  cookie = session.headers.get("set-cookie").split(";")[0];
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const ownedChild = child;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      ownedChild.kill("SIGKILL");
      reject(new Error("Native shutdown timed out"));
    }, 10000);
    ownedChild.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : reject(new Error(`Native shutdown exited ${code}`));
    });
    ownedChild.kill("SIGTERM");
  });
  child = undefined;
}

async function request(path, method = "GET", body, expected = 200) {
  const response = await localFetch(origin + path, {
    method,
    headers: { origin, cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${JSON.stringify(result)}`,
  );
  return result;
}

try {
  execFileSync(
    process.execPath,
    [join(source, "scripts/create-demo.mjs"), repository],
    { stdio: "pipe", env: fixtureEnv },
  );
  await start();
  const page = await localFetch(origin + "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Agent Review/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await localFetch(origin + asset)).status, 200);
  const badHostStatus = await new Promise((done, reject) => {
    const req = httpRequest(
      origin + "/",
      { headers: { host: "untrusted.invalid" } },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("Host check timed out")));
    req.once("error", reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal(
    (
      await localFetch(origin + "/api/session", {
        method: "POST",
        headers: {
          origin: "https://untrusted.invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: "invalid" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await localFetch(origin + "/api/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "invalid" }),
      })
    ).status,
    401,
  );
  const repositories = await request("/api/repositories");
  const id = repositories.selectedRepositoryId;
  const base = `/api/repositories/${id}`;
  const review = (mode) =>
    request(`${base}/review?base=demo-base&mode=${mode}`);
  const originalHead = git("rev-parse", "HEAD");
  const historic = await review("branch");
  const historicEntry = (await request(base + "/history")).reviews.find(
    (entry) => entry.fingerprint === historic.fingerprint,
  );
  assert.ok(historicEntry);
  const full = await review("full");
  assert.ok(full.files.some((file) => file.path === "review.ts"));
  const note = await request(
    base + "/comments",
    "POST",
    {
      reviewId: full.id,
      path: "deleted.txt",
      side: "old",
      startLine: 1,
      endLine: 2,
      body: "Portable native smoke note",
      severity: "warning",
    },
    201,
  );
  assert.ok(note.id);
  const exported = await request(`${base}/export?reviewId=${full.id}`);
  assert.ok(
    exported.comments.some(
      (comment) => comment.body === "Portable native smoke note",
    ),
  );
  assert.ok(!JSON.stringify(exported).includes("Legacy workflow"));
  const capabilities = await request(base + "/capabilities");
  assert.equal(capabilities.writesEnabled, true);
  assert.deepEqual((await request(base + "/remotes")).remotes, []);
  let current = await review("working");
  await request(base + "/git", "POST", {
    reviewId: current.id,
    action: "stage",
    path: "review.ts",
    hunkIndex: 0,
  });
  current = await review("staged");
  await request(base + "/git", "POST", {
    reviewId: current.id,
    action: "unstage",
    path: "review.ts",
    hunkIndex: 0,
  });
  current = await review("working");
  const preview = await request(base + "/discard-preview", "POST", {
    reviewId: current.id,
    path: "review.ts",
  });
  assert.equal(preview.operation, "restore-index");
  await request(base + "/discard", "POST", {
    previewId: preview.previewId,
    confirmed: true,
  });
  assert.equal(
    await readFile(join(repository, "review.ts"), "utf8"),
    git("show", ":review.ts") + "\n",
  );
  await writeFile(join(repository, "temporary.txt"), "Disposable smoke file\n");
  current = await review("working");
  const removal = await request(base + "/discard-preview", "POST", {
    reviewId: current.id,
    path: "temporary.txt",
  });
  assert.equal(removal.operation, "delete-untracked");
  await request(base + "/discard", "POST", {
    previewId: removal.previewId,
    confirmed: true,
  });
  await assert.rejects(readFile(join(repository, "temporary.txt")), {
    code: "ENOENT",
  });
  current = await review("staged");
  const indexBefore = await readFile(join(repository, ".git/index"));
  const sourceBefore = await readFile(join(repository, "review.ts"));
  const committed = await request(base + "/commit", "POST", {
    reviewId: current.id,
    paths: ["styles.css"],
    message: "Verify selected style commit",
  });
  assert.equal(committed.changed, true);
  assert.notEqual(committed.commit, originalHead);
  assert.deepEqual(await readFile(join(repository, ".git/index")), indexBefore);
  assert.deepEqual(await readFile(join(repository, "review.ts")), sourceBefore);
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "styles.css");
  assert.ok(git("diff", "--cached", "--name-only").includes("deleted.txt"));
  const reopened = await request(`${base}/history/${historicEntry.id}/review`);
  assert.equal(reopened.historical, true);
  assert.equal(reopened.head, originalHead);
  if (checkSavedContext) {
    const currentContext = await request("/api/repositories");
    assert.equal(currentContext.base, "demo-base");
    assert.equal(currentContext.mode, "staged");
  }
  const oldCookie = cookie;
  await stop();
  await start(!checkSavedContext);
  assert.equal(
    (
      await localFetch(origin + "/api/repositories", {
        headers: { origin, cookie: oldCookie },
      })
    ).status,
    401,
  );
  if (checkSavedContext) {
    const restored = await request("/api/repositories");
    assert.equal(restored.selectedRepositoryId, id);
    assert.equal(restored.base, "demo-base");
    assert.equal(restored.mode, "staged");
    assert.ok(
      restored.repositories.some(
        (item) => item.id === id && item.root === repository,
      ),
    );
  }
  const refreshed = await review("full");
  const restoredNotes = await request(
    `${base}/comments?reviewId=${refreshed.id}`,
  );
  assert.ok(
    restoredNotes.comments.some(
      (comment) => comment.body === "Portable native smoke note",
    ),
  );
  if (checkWorkspaceUX) {
    const roots = await request("/api/directory-roots");
    if (roots.nativePickerAvailable) {
      directoryCheck = "native-dialog-not-exercised";
    } else {
      assert.ok(roots.roots.some((root) => root.path === owned));
      const browseRoot = roots.roots.find((root) => root.path === owned);
      const folders = await request(
        "/api/directory-listing?rootId=" +
          encodeURIComponent(browseRoot.id) +
          "&path=",
      );
      assert.ok(folders.entries.some((entry) => entry.name === "repository"));
      assert.ok(
        !folders.entries.some((entry) => entry.name === "review.sqlite"),
      );
      directoryCheck = "passed";
    }
    assert.ok(
      refreshed.files.some(
        (file) =>
          typeof file.addedLines === "number" &&
          typeof file.deletedLines === "number",
      ),
    );
    const originalBranch = git("symbolic-ref", "HEAD");
    const targetBranch = "refs/heads/native-smoke-other";
    git("branch", "native-smoke-other");
    const branches = await request(base + "/branches");
    assert.ok(branches.localBranches.includes(targetBranch));
    assert.deepEqual(branches.remoteBranches, []);
    const dirtyReview = await review("full");
    const dirty = await request(base + "/branch-switch-preview", "POST", {
      reviewId: dirtyReview.id,
      targetRef: targetBranch,
    });
    assert.equal(dirty.status, "dirty");
    const refusal = await request(
      base + "/branch-switch",
      "POST",
      { previewId: dirty.previewId, strategy: "clean" },
      409,
    );
    assert.equal(refusal.reason, "dirty");
    assert.equal(git("symbolic-ref", "HEAD"), originalBranch);
    const stashPlan = await request(base + "/branch-switch-preview", "POST", {
      reviewId: (await review("full")).id,
      targetRef: targetBranch,
    });
    const switched = await request(base + "/branch-switch", "POST", {
      previewId: stashPlan.previewId,
      strategy: "stash",
      confirmed: true,
    });
    assert.equal(switched.branch, targetBranch);
    assert.match(switched.stash.oid, /^[a-f0-9]{40,64}$/);
    assert.equal(switched.stash.sourceBranch, originalBranch);
    assert.equal(git("symbolic-ref", "HEAD"), targetBranch);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("cat-file", "-t", switched.stash.oid), "commit");
    const returnPlan = await request(base + "/branch-switch-preview", "POST", {
      reviewId: (await review("full")).id,
      targetRef: originalBranch,
    });
    assert.equal(returnPlan.status, "clean");
    await request(base + "/branch-switch", "POST", {
      previewId: returnPlan.previewId,
      strategy: "clean",
    });
    assert.equal(git("symbolic-ref", "HEAD"), originalBranch);
    assert.equal(git("status", "--porcelain"), "");
    assert.ok(
      git("stash", "list", "--format=%H")
        .split("\n")
        .includes(switched.stash.oid),
    );
    // This explicit fixture-only normal Git action proves recovery; the app never auto-applies or drops it.
    git("stash", "apply", "--index", switched.stash.oid);
    assert.ok(git("diff", "--cached", "--name-only").includes("deleted.txt"));
  }
  await stop();
  console.log(
    JSON.stringify({
      nativeCli: "passed",
      builtAssets: "passed",
      sessionHostOrigin: "passed",
      hunkStageUnstage: "passed",
      explicitDiscard: "passed",
      selectedCommitPreservation: "passed",
      pinnedHistory: "passed",
      restartCommentPersistence: "passed",
      ...(checkSavedContext
        ? {
            currentContextResponse: "passed",
            savedRepositoryAndContext: "passed",
          }
        : {}),
      ...(checkWorkspaceUX
        ? {
            directoryPicker: directoryCheck,
            fileCounts: "passed",
            cleanAndStashBranchSwitch: "passed",
            explicitStashRecovery: "passed",
          }
        : {}),
      providerCalls: 0,
      liveFetchCalls: 0,
    }),
  );
} finally {
  await stop().catch(() => {});
  await rm(owned, { recursive: true, force: true });
}
