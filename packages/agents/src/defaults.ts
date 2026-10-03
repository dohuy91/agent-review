import { homedir } from "node:os";
import { join } from "node:path";
export function agentDefaults(container = false) {
  return {
    skillRoots: container
      ? []
      : [
          join(homedir(), ".codex", "skills"),
          join(homedir(), ".agents", "skills"),
        ],
    enableWrites: !container,
  };
}
