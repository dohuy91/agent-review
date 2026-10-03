import { test, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startAdapter,
  adapterAvailability,
} from "../packages/agents/src/adapters.js";

for (const [label, layers] of [
  ["inherited auto-share", [{}]],
  ["project and global auto-share", [{ share: "auto" }, { share: "auto" }]],
  [
    "inline provider configuration",
    [{ provider: { fixture: { name: "Fixture provider" } }, share: "auto" }],
  ],
  [
    "organization overrides inline disabled",
    [{ share: "disabled" }, { share: "auto" }],
  ],
  [
    "managed overrides inline disabled",
    [{ share: "disabled" }, { share: "auto" }, { share: "auto" }],
  ],
] as const) {
  test(`OpenCode direct no-sharing environment defeats ${label} without changing configuration`, async () => {
    const root = mkdtempSync(join(tmpdir(), "share-fixture-"));
    const config = join(root, "opencode.json");
    const content = JSON.stringify({
      provider: { fixture: { name: "Fixture" } },
      share: "auto",
    });
    writeFileSync(config, content);
    const before = { ...process.env };
    try {
      process.env.OPENCODE_AUTO_SHARE = "true";
      process.env.OPENCODE_DISABLE_SHARE = "false";
      process.env.OPENCODE_CONFIG_CONTENT = content;
      process.env.FIXTURE_AUTH_SETTING = "preserved";
      let options: any;
      const script = `const layers=${JSON.stringify(layers)};const effective=Object.assign({},...layers);const requested=effective.share==='auto'||process.env.OPENCODE_AUTO_SHARE==='true';const disabled=process.env.OPENCODE_DISABLE_SHARE==='true'||process.env.OPENCODE_DISABLE_SHARE==='1';console.log(JSON.stringify({effectiveShare:effective.share,shareCreate:requested&&!disabled,shareSync:requested&&!disabled,disabled,inline:process.env.OPENCODE_CONFIG_CONTENT,auth:process.env.FIXTURE_AUTH_SETTING}));process.stdin.resume()`;
      const child = startAdapter(
        "opencode",
        (_command, _args, opts) => {
          options = opts;
          return spawn(process.execPath, ["-e", script], opts);
        },
        root,
        "fixture prompt",
      );
      let output = "";
      child.stdout.on("data", (data) => (output += data.toString()));
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(Error("fixture exit")),
        );
      });
      const result = JSON.parse(output);
      expect(result.disabled).toBe(true);
      expect(result.shareCreate).toBe(false);
      expect(result.shareSync).toBe(false);
      expect(options.env.OPENCODE_AUTO_SHARE).toBe("false");
      expect(result.inline).toBe(content);
      expect(result.auth).toBe("preserved");
      expect(readFileSync(config, "utf8")).toBe(content);
      expect(process.env.OPENCODE_AUTO_SHARE).toBe("true");
    } finally {
      for (const key of [
        "OPENCODE_AUTO_SHARE",
        "OPENCODE_DISABLE_SHARE",
        "OPENCODE_CONFIG_CONTENT",
        "FIXTURE_AUTH_SETTING",
      ]) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const version of ["1.18.30", "1.18.32", "1.18.31"])
  test(`OpenCode ${version} availability requires the verified no-share contract`, async () => {
    const root = mkdtempSync(join(tmpdir(), "version-fixture-"));
    const binary = join(root, "opencode");
    writeFileSync(
      binary,
      `#!${process.execPath}\nconsole.log(process.argv.includes('--version')?${JSON.stringify(version)}:'--format --dir');`,
    );
    chmodSync(binary, 0o755);
    const previous = process.env.PATH;
    try {
      process.env.PATH = root;
      const available = await adapterAvailability("opencode");
      expect(available.available).toBe(version === "1.18.31");
      if (version !== "1.18.31")
        expect(available.error).toMatch(/sharing.*1\.18\.31/i);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
