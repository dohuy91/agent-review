import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/src/app.js";
import { adapterAvailability } from "../packages/agents/src/adapters.js";

for (const change of [
  "upgraded",
  "removed",
  "late-upgrade",
  "unchanged",
] as const) {
  test(`native OpenCode Send rechecks installed version: ${change}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "version-api-"));
    const root = join(dir, "repo"),
      bin = join(dir, "bin"),
      skills = join(dir, "skills"),
      marker = join(dir, "provider-run.json"),
      executable = join(bin, "opencode");
    await mkdir(root);
    await mkdir(bin);
    await mkdir(join(skills, "fixture"), { recursive: true });
    await writeFile(
      join(skills, "fixture", "SKILL.md"),
      "# Fixture\nUse only fixture input.",
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    await writeFile(join(root, "a.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "base");
    await writeFile(join(root, "a.txt"), "new\n");
    async function install(version: string) {
      await writeFile(
        executable,
        `#!${process.execPath}\nif(process.argv.includes('--version')) console.log(${JSON.stringify(version)});else if(process.argv.includes('--help')) console.log('--format --dir');else {require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({version:${JSON.stringify(version)},disabled:process.env.OPENCODE_DISABLE_SHARE,auto:process.env.OPENCODE_AUTO_SHARE,inline:process.env.OPENCODE_CONFIG_CONTENT,auth:process.env.FIXTURE_AUTH_SETTING}));process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}})));}`,
      );
      await chmod(executable, 0o755);
    }
    await install("1.18.31");
    const previous = {
      PATH: process.env.PATH,
      inline: process.env.OPENCODE_CONFIG_CONTENT,
      auth: process.env.FIXTURE_AUTH_SETTING,
    };
    process.env.PATH = bin + ":" + (previous.PATH ?? "");
    process.env.OPENCODE_CONFIG_CONTENT =
      '{"provider":{"fixture":{}},"share":"auto"}';
    process.env.FIXTURE_AUTH_SETTING = "preserved";
    let probes = 0;
    const app = await createApp({
      port: 7373,
      token: "fixture",
      repositoryPath: root,
      dataDir: join(dir, "data"),
      skillRoots: [skills],
      enableWrites: true,
      agentAvailability: async () => ({
        id: "codex",
        available: false,
        version: null,
        error: "Fixture unavailable",
      }),
      adapterAvailability: async (id) => {
        if (id === "claude")
          return {
            id,
            available: false,
            version: null,
            error: "Fixture unavailable",
          };
        probes++;
        if (change === "late-upgrade" && probes === 4) await install("1.18.32");
        return adapterAvailability(id);
      },
    });
    try {
      const headers: any = {
        host: "localhost:7373",
        origin: "http://localhost:7373",
      };
      const session = await app.inject({
        method: "POST",
        url: "/api/session",
        headers,
        payload: { token: "fixture" },
      });
      headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0];
      const id = (
        await app.inject({ url: "/api/repositories", headers })
      ).json().selectedRepositoryId;
      const call = (method: any, url: string, payload?: any) =>
        app.inject({
          method,
          url: url.startsWith("/api/") ? url : `/api/repositories/${id}/${url}`,
          headers,
          payload,
        });
      const observation = (
        await call("GET", "review?base=HEAD&mode=full")
      ).json();
      const skill = (await call("GET", "/api/skills")).json().skills[0];
      await call("PUT", "profiles", {
        reviewId: observation.id,
        scope: "worktree",
        profile: { locator: skill.locator, digest: skill.digest },
      });
      const note = (
        await call("POST", "comments", {
          reviewId: observation.id,
          path: "a.txt",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "Fixture finding",
          severity: "info",
        })
      ).json();
      const exported = (
        await call("GET", `export?reviewId=${observation.id}`)
      ).json();
      const initial = (await call("GET", "/api/agents"))
        .json()
        .agents.find((a: any) => a.id === "opencode");
      expect(initial).toMatchObject({ available: true, version: "1.18.31" });
      if (change === "upgraded") await install("1.18.32");
      if (change === "removed") await rm(executable);
      const response = await call("POST", "agents", {
        adapter: "opencode",
        reviewId: observation.id,
        commentIds: [note.id],
        expected: { target: exported.target, profile: exported.profile },
      });
      if (change === "unchanged") {
        expect(response.statusCode).toBe(201);
        const deadline = Date.now() + 5000;
        while (
          Date.now() < deadline &&
          (await call("GET", "agents/history")).json().runs[0].status ===
            "running"
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(
          (await call("GET", "agents/history")).json().runs[0].status,
        ).toBe("completed");
        expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
          version: "1.18.31",
          disabled: "true",
          auto: "false",
          inline: process.env.OPENCODE_CONFIG_CONTENT,
          auth: "preserved",
        });
      } else {
        expect(response.statusCode).toBe(503);
        await expect(access(marker)).rejects.toThrow();
        expect((await call("GET", "agents/history")).json().runs).toEqual([]);
        const current = (await call("GET", "/api/agents"))
          .json()
          .agents.find((a: any) => a.id === "opencode");
        expect(current.available).toBe(false);
        expect(current.error).toMatch(
          change === "removed" ? /unavailable/i : /sharing.*1\.18\.31/i,
        );
        expect(response.json().error).toBe(current.error);
      }
      expect(probes).toBeGreaterThan(1);
    } finally {
      await app.close();
      for (const [key, value] of [
        ["PATH", previous.PATH],
        ["OPENCODE_CONFIG_CONTENT", previous.inline],
        ["FIXTURE_AUTH_SETTING", previous.auth],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
