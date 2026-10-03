// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
const styles: HTMLStyleElement[] = [];
afterEach(() => {
  for (const style of styles.splice(0)) style.remove();
  delete document.documentElement.dataset.theme;
});
test("actual workspace CSS keeps light and dark accent, hover and muted tokens distinct", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    "apps/web/src/styles.css",
    "utf8",
  );
  document.head.append(style);
  styles.push(style);
  document.documentElement.dataset.theme = "light";
  let tokens = getComputedStyle(document.documentElement);
  expect(tokens.getPropertyValue("--blue").trim()).toBe("#e9f3ff");
  expect(tokens.getPropertyValue("--accent").trim()).toBe("#0664ff");
  expect(tokens.getPropertyValue("--muted").trim()).toBe("#64718a");
  document.documentElement.dataset.theme = "dark";
  tokens = getComputedStyle(document.documentElement);
  expect(tokens.getPropertyValue("--blue").trim()).toBe("#263c5d");
  expect(tokens.getPropertyValue("--accent").trim()).toBe("#79a9f5");
  expect(tokens.getPropertyValue("--muted").trim()).toBe("#8290a3");
  expect(tokens.getPropertyValue("--bg").trim()).toBe("#191d24");
});
