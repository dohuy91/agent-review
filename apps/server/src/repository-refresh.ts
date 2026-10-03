import type { Repository } from "../../../packages/shared/src/index.js";
import type { RegistrationStore } from "./registration.js";

/** Recheck only saved canonical identities; never discover or authorize a new root. */
export async function refreshRegisteredRepositories(
  registration: RegistrationStore,
  repositories: Map<string, Repository>,
  validate: (repository: Repository) => void,
  admit: (repository: Repository) => void = () => {},
) {
  const restored = await registration.restore((repository) => {
    validate(repository);
    if (!repositories.has(repository.id)) {
      // Capture authority at the physical-identity-checked admission, before
      // restore awaits another root and before any scheduler can use this one.
      admit(repository);
      repositories.set(repository.id, repository);
    }
  });
  // Existing admitted objects stay stable across refresh; only an explicit
  // registration may replace one and authorize a new physical identity.
  // Previously available roots stay registered when unavailable, so the UI and
  // synchronization status can explain the missing worktree without forgetting it.
  return restored.errors;
}
