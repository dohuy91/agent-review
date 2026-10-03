import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const supplied = process.argv[2];
if (!supplied || process.argv.length !== 3) {
  console.error("Usage: pnpm demo <new-directory>");
  process.exit(1);
}
const root = resolve(supplied);
try {
  await mkdir(root); // Exclusive creation: never modify an existing directory.
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Review Demo");
  git("config", "user.email", "demo@example.invalid");
  await writeFile(
    join(root, "review.ts"),
    "export function total(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n",
  );
  await writeFile(
    join(root, "deleted.txt"),
    "Legacy workflow\nNeeds migration\nKeep this note\n",
  );
  await writeFile(join(root, "styles.css"), "body { color: #26324a; }\n");
  git("add", ".");
  git("commit", "-qm", "Synthetic base");
  git("branch", "demo-base");
  git("switch", "-qc", "feature/demo");
  await writeFile(
    join(root, "review.ts"),
    "export function total(values: number[]): number {\n  // Review: should negative values be allowed?\n  return values.reduce((sum, value) => sum + value, 0);\n}\n",
  );
  git("add", "review.ts");
  git("commit", "-qm", "Add review question");
  await rm(join(root, "deleted.txt"));
  git("add", "deleted.txt");
  await writeFile(
    join(root, "styles.css"),
    "body { color: #26324a; background: #eef5ff; }\n",
  );
  git("add", "styles.css");
  await writeFile(
    join(root, "review.ts"),
    "export function total(values: number[]): number {\n  // Review: empty input and rounding\n  return Math.round(values.reduce((sum, value) => sum + value, 0));\n}\n",
  );
  console.log(
    `Created ${root}\nReview with --base demo-base --mode full; keep REVIEW_DATA_DIR outside this directory.`,
  );
} catch (error) {
  console.error(`Demo creation failed: ${error.message}`);
  process.exitCode = 1;
}
