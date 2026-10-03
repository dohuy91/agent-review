import { test, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../packages/review/src/store.js";
import { AgentManager } from "../packages/agents/src/manager.js";

const cases = [
  [
    "permission rejected",
    {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: {
          status: "error",
          error:
            "The user rejected permission to use this specific tool call. PRIVATE_DETAIL",
        },
      },
    },
    "needs-attention",
  ],
  [
    "configuration denied",
    {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: {
          status: "error",
          error:
            "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules PRIVATE_DETAIL",
        },
      },
    },
    "needs-attention",
  ],
  [
    "generic tool error",
    {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "error", error: "PRIVATE_DETAIL disk failure" },
      },
    },
    "failed",
  ],
  [
    "provider error",
    { type: "error", error: "PRIVATE_DETAIL provider failure" },
    "failed",
  ],
  [
    "successful tool",
    {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "completed", output: "PRIVATE_DETAIL success" },
      },
    },
    "completed",
  ],
] as const;

for (const [label, event, expected] of cases)
  for (const chunks of [false, true]) {
    test(`OpenCode ${label} followed by stop is ${expected}, split chunks=${chunks} and final no newline`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "status-fixture-"));
      const store = new ReviewStore(dir);
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const manager = new AgentManager(store, () => child);
      try {
        const context: any = {
          target: { repositoryId: "repo", worktreeRoot: dir },
          profile: { effective: { locator: "fixture", digest: "digest" } },
          comments: [],
        };
        const run = await manager.start(
          { adapter: "opencode", reviewId: "fixture", commentIds: [] } as any,
          async () => context,
          "fixture",
        );
        const output =
          JSON.stringify(event) +
          "\n" +
          JSON.stringify({ type: "step_finish", part: { reason: "stop" } });
        if (chunks) {
          for (let i = 0; i < output.length; i += 13)
            child.stdout.write(Buffer.from(output.slice(i, i + 13)));
        } else child.stdout.write(Buffer.from(output));
        child.emit("close", 0);
        const saved = manager.get("repo", run.id);
        expect(saved.status).toBe(expected);
        expect(saved.exitCode).toBe(0);
        expect(saved.error ?? "").not.toContain("PRIVATE_DETAIL");
        expect(
          JSON.stringify(
            store.db.prepare("SELECT metadata FROM agent_runs").all(),
          ),
        ).not.toContain("PRIVATE_DETAIL");
      } finally {
        await manager.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

for (const denied of [true, false])
  for (const chunks of [false, true]) {
    test(`oversized OpenCode record fails closed, denial=${denied}, 8KiB chunks=${chunks}, final no newline`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "oversized-status-"));
      const store = new ReviewStore(dir);
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const manager = new AgentManager(store, () => child);
      try {
        const context: any = {
          target: { repositoryId: "repo", worktreeRoot: dir },
          profile: { effective: { locator: "fixture", digest: "digest" } },
          comments: [],
        };
        const run = await manager.start(
          { adapter: "opencode", reviewId: "fixture", commentIds: [] } as any,
          async () => context,
          "fixture",
        );
        const record = JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "write",
            state: {
              status: denied ? "error" : "completed",
              input: { content: "PRIVATE_LARGE_CONTENT" + "x".repeat(153600) },
              ...(denied
                ? {
                    error:
                      "The user rejected permission to use this specific tool call.",
                  }
                : {}),
            },
          },
        });
        const output =
          record +
          "\n" +
          JSON.stringify({ type: "step_finish", part: { reason: "stop" } });
        if (chunks) {
          for (let i = 0; i < output.length; i += 8192)
            child.stdout.write(Buffer.from(output.slice(i, i + 8192)));
        } else child.stdout.write(Buffer.from(output));
        child.emit("close", 0);
        const saved = manager.get("repo", run.id);
        expect(saved.status).toBe("failed");
        expect(saved.exitCode).toBe(0);
        expect(saved.error).toMatch(/event limit/i);
        expect(
          JSON.stringify(
            store.db.prepare("SELECT metadata FROM agent_runs").all(),
          ),
        ).not.toContain("PRIVATE_LARGE_CONTENT");
      } finally {
        await manager.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
