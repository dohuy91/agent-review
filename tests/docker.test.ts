import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseCLI } from "../apps/server/src/cli.js";
test("container binding is explicit and export rejects it", () => {
  expect(parseCLI(["repo"]).host).toBe("127.0.0.1");
  expect(parseCLI(["repo", "--container"]).host).toBe("0.0.0.0");
  expect(parseCLI(["repo", "--container"]).open).toBe(false);
  expect(() =>
    parseCLI(["repo", "--container", "--export-comments", "out"]),
  ).toThrow("launch");
});
test("Docker isolates readonly repository and persistent state with loopback publishing", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  expect(compose).toContain("127.0.0.1:7373:7373");
  expect(compose).toContain("read_only: true");
  expect(compose).toContain("target: /state");
  expect(compose).toContain("target: ${REVIEW_REPO:?");
  expect(compose).not.toContain("docker.sock");
  const docker = readFileSync("Dockerfile", "utf8");
  expect(docker).toContain("node:22.22.0-trixie-slim");
  expect(docker).toContain("--frozen-lockfile");
  expect(docker).toContain("USER reviewer");
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
test("missing linked-worktree metadata refuses startup and trusts only explicit root", () => {
  const temp = mkdtempSync(join(tmpdir(), "docker-entry-"));
  const root = join(temp, "repo"),
    home = join(temp, "home");
  mkdirSync(root);
  mkdirSync(home);
  writeFileSync(
    join(root, ".git"),
    "gitdir: /unmounted/exact/.git/worktrees/linked\n",
  );
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/docker-entrypoint.mjs", root],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "mount /unmounted/exact/.git/worktrees/linked",
    );
    expect(result.stderr).toContain("original absolute host paths");
    const config = readFileSync(join(home, ".gitconfig"), "utf8");
    // Temporary paths on macOS canonicalize /var to /private/var.
    expect(config).toContain("directory = ");
    expect(config).toContain("/repo");
    expect(config).not.toContain("directory = *");
    expect(readFileSync(join(root, ".git"), "utf8")).toBe(
      "gitdir: /unmounted/exact/.git/worktrees/linked\n",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

import { chmodSync } from "node:fs";
test.each([false, true])(
  "failed Docker start cleans owned container and reports cleanup failure=%s",
  (cleanupFailure) => {
    const temp = mkdtempSync(join(tmpdir(), "docker-cleanup-"));
    const fake = join(temp, "docker"),
      log = join(temp, "calls.jsonl");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_DOCKER_LOG,JSON.stringify(args)+'\\n');if(args[0]==='run'){console.error('synthetic start failed after create');process.exit(125);}if(args[0]==='rm'&&process.env.FAKE_CLEANUP_FAILURE==='1'){console.error('synthetic container removal refused');process.exit(1);}\n`,
    );
    chmodSync(fake, 0o755);
    try {
      const result = spawnSync(process.execPath, ["scripts/docker-smoke.mjs"], {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${temp}:${process.env.PATH}`,
          FAKE_DOCKER_LOG: log,
          FAKE_CLEANUP_FAILURE: cleanupFailure ? "1" : "0",
        },
      });
      expect(result.status).toBe(1);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const run = calls.find((args) => args[0] === "run")!;
      const name = run[run.indexOf("--name") + 1]!;
      expect(
        calls
          .filter((args) => ["rm", "volume", "image"].includes(args[0]!))
          .slice(-3),
      ).toEqual([
        ["rm", "-f", name],
        ["volume", "rm", `${name}-state`],
        ["image", "rm", `${name}:test`],
      ]);
      expect(calls.flat()).not.toContain("prune");
      expect(result.stdout).not.toContain("Docker smoke passed");
      expect(result.stderr).toContain("synthetic start failed after create");
      if (cleanupFailure)
        expect(result.stderr).toContain(
          "Unable to clean up owned Docker resource",
        );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  30_000,
);
