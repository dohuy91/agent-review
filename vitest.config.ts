import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Real Git fixtures are process-heavy; bound concurrency without relaxing timeouts.
    maxWorkers: 4,
    exclude: [...configDefaults.exclude, ".pnpm-store/**"],
  },
});
