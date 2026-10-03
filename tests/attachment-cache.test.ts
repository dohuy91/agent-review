import { test, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/src/app.js";
import { ReviewStore } from "../packages/review/src/store.js";
import { makeAnchor } from "../packages/review/src/anchors.js";
import * as diff from "../packages/git/src/diff.js";
import * as review from "../packages/git/src/review.js";
import * as gitModule from "../packages/git/src/git.js";

afterEach(() => vi.restoreAllMocks());
for (const endpoint of ["comments", "export", "bounded-files"])
  test(`${endpoint} shares in-flight diff/object work and bounds distinct-file concurrency`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-cache-"));
    const root = join(dir, "repo"),
      dataDir = join(dir, "data");
    await mkdir(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    await writeFile(join(root, "a.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "base");
    await writeFile(join(root, "a.txt"), "new\n");
    if (endpoint === "bounded-files") {
      for (let i = 0; i < 8; i++)
        await writeFile(join(root, `other${i}.txt`), "old\n");
      git("add", ".");
      git("commit", "-qm", "other files");
      await writeFile(join(root, "a.txt"), "newer\n");
      for (let i = 0; i < 8; i++)
        await writeFile(join(root, `other${i}.txt`), "new\n");
    }
    const app = await createApp({
      port: 7373,
      token: "fixture",
      repositoryPath: root,
      dataDir,
      processFactory: () => {
        throw Error("no provider");
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
      const prefix = `/api/repositories/${id}`;
      const observation = (
        await app.inject({
          url: `${prefix}/review?base=HEAD&mode=full`,
          headers,
        })
      ).json();
      const note = (
        await app.inject({
          method: "POST",
          url: `${prefix}/comments`,
          headers,
          payload: {
            reviewId: observation.id,
            path: "a.txt",
            side: "old",
            startLine: 1,
            endLine: 1,
            body: "Fixture note",
            severity: "info",
          },
        })
      ).json();
      const store = new ReviewStore(dataDir);
      try {
        if (endpoint === "bounded-files") {
          for (let i = 0; i < 8; i++) {
            const path = `other${i}.txt`,
              file = observation.files.find((f: any) => f.path === path);
            store.db
              .prepare("INSERT INTO comments VALUES(?,?,?)")
              .run(
                "note" + i,
                id,
                JSON.stringify({
                  ...note,
                  id: "note" + i,
                  path,
                  fileFingerprint: file.fingerprint,
                  sourceOid: file.oldOid,
                  anchor: makeAnchor("old\n", 1, 1),
                }),
              );
          }
        } else
          for (let i = 1; i < 12; i++)
            store.db
              .prepare("INSERT INTO comments VALUES(?,?,?)")
              .run("note" + i, id, JSON.stringify({ ...note, id: "note" + i }));
      } finally {
        store.close();
      }
      let inFlight = 0,
        peak = 0;
      const originalDiff = diff.getFileDiff;
      const diffSpy = vi
        .spyOn(diff, "getFileDiff")
        .mockImplementation(async (...args) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          try {
            return await originalDiff(...args);
          } finally {
            inFlight--;
          }
        });
      const validationSpy = vi.spyOn(review, "validateObservation");
      const objectSpy = vi.spyOn(gitModule, "git");
      const url = `${prefix}/${endpoint === "bounded-files" ? "comments" : endpoint}?reviewId=${observation.id}`;
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().comments).toHaveLength(
        endpoint === "bounded-files" ? 9 : 12,
      );
      expect(
        response
          .json()
          .comments.every(
            (c: any) =>
              c.attachment === "current" && c.historicalContent === "available",
          ),
      ).toBe(true);
      expect(peak).toBeLessThanOrEqual(4);
      expect(diffSpy).toHaveBeenCalledTimes(
        endpoint === "bounded-files" ? 9 : 1,
      );
      if (endpoint !== "bounded-files")
        expect(validationSpy).toHaveBeenCalledTimes(
          endpoint === "export" ? 6 : 4,
        );
      expect(
        objectSpy.mock.calls.filter(
          ([, args]) => args[0] === "cat-file" && args[1] === "-e",
        ),
      ).toHaveLength(endpoint === "bounded-files" ? 2 : 1);
      diffSpy.mockClear();
      const second = await app.inject({ url, headers });
      expect(second.statusCode).toBe(200);
      expect(diffSpy).toHaveBeenCalledTimes(
        endpoint === "bounded-files" ? 9 : 1,
      ); // New request must never reuse cached mutable content.
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
