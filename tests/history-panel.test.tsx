// @vitest-environment jsdom
import React from "react";
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import HistoryPanel from "../apps/web/src/components/HistoryPanel.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("history selects comparison metadata and declares mutable historical content unavailable", async () => {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      reviews: [
        {
          id: "r",
          base: "abc",
          mode: "working",
          head: "123",
          acceptedAt: "now",
          historicalContent: "unavailable",
        },
      ],
      runs: [
        {
          id: "run",
          adapter: "claude",
          status: "interrupted",
          createdAt: "now",
        },
      ],
    }),
  }));
  const choose = vi.fn();
  render(<HistoryPanel repositoryId="repo" reviewId="r" onSelect={choose} />);
  const button = await screen.findByRole("button", { name: /working/ });
  fireEvent.click(button);
  expect(choose).toHaveBeenCalledWith("abc", "working");
  expect(screen.getByText(/historical content unavailable/i)).toBeTruthy();
  expect(screen.getByText(/interrupted/i)).toBeTruthy();
});
test("immutable branch history selects scoped history ID and labels retained Git object availability", async () => {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      reviews: [
        {
          id: "historic",
          base: "base",
          mode: "branch",
          head: "oldhead",
          acceptedAt: "now",
          historicalContent: "git-objects-only",
        },
      ],
      runs: [],
    }),
  }));
  const choose = vi.fn();
  render(<HistoryPanel repositoryId="repo" reviewId="r" onSelect={choose} />);
  fireEvent.click(await screen.findByRole("button", { name: /branch/ }));
  expect(choose).toHaveBeenCalledWith("base", "branch", "historic");
});
