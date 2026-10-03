#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";
const { main } = await tsImport("../apps/server/src/cli.ts", import.meta.url);
try {
  await main();
} catch (error) {
  console.error(`Unable to run: ${error.message}`);
  process.exitCode = 1;
}
