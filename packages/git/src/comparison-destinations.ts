import type { Repository } from "../../shared/src/index.js";
import type { ComparisonPushDestination } from "../../shared/src/push.js";
import { gitText } from "./git.js";

interface Mapping {
  source: string;
  tracking: string;
}
function validPattern(ref: string, prefix: string) {
  return (
    ref.startsWith(prefix) &&
    ref.length > prefix.length &&
    !/[\x00-\x20\x7f~^:?[\]\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    ref.split("*").length <= 2 &&
    ref
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
function matchPattern(pattern: string, ref: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === ref ? "" : null;
  const start = pattern.slice(0, star),
    end = pattern.slice(star + 1);
  return ref.startsWith(start) &&
    ref.endsWith(end) &&
    ref.length >= start.length + end.length
    ? ref.slice(start.length, ref.length - end.length)
    : null;
}
function parseSpecs(specs: string[]) {
  const positive: Mapping[] = [],
    negative: string[] = [];
  if (!specs.length) return null;
  for (const spec of specs) {
    if (spec.startsWith("^")) {
      const source = spec.slice(1);
      if (!validPattern(source, "refs/heads/")) return null;
      negative.push(source);
      continue;
    }
    const parts = /^\+?([^:]+):([^:]+)$/.exec(spec);
    if (!parts) return null;
    const source = parts[1]!,
      tracking = parts[2]!;
    if (
      !validPattern(source, "refs/heads/") ||
      !validPattern(tracking, "refs/remotes/") ||
      source.includes("*") !== tracking.includes("*")
    )
      return null;
    positive.push({ source, tracking });
  }
  return positive.length ? { positive, negative } : null;
}
/** Local config and refs only: no remote inspection or authentication is performed. */
export async function getComparisonDestinations(
  repo: Repository,
  values: Map<string, string[]>,
): Promise<ComparisonPushDestination[]> {
  const refs = (
    await gitText(repo.root, [
      "for-each-ref",
      "--format=%(refname)%00%(symref)",
      "refs/remotes/",
    ])
  )
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, symref] = line.split("\0");
      return ref && !symref && !ref.endsWith("/HEAD") ? [ref] : [];
    });
  const candidates = new Map<string, Map<string, ComparisonPushDestination>>();
  const blocked = new Set<string>();
  const remotes = new Set(
    [...values.keys()].flatMap((key) => {
      const remote = /^remote\.(.+)\.(url|fetch)$/.exec(key)?.[1];
      return remote ? [remote] : [];
    }),
  );
  for (const remote of remotes) {
    const rawSpecs = values.get(`remote.${remote}.fetch`) ?? [];
    const specs = parseSpecs(rawSpecs);
    if (
      !specs ||
      !values.has(`remote.${remote}.url`) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote) ||
      remote.includes("..") ||
      remote.endsWith(".lock")
    ) {
      // An unsupported source/helper must not make a competing valid mapping look
      // unique. Account for targets outside this remote's conventional namespace too.
      const targets = rawSpecs.flatMap((spec) => {
        const target = /^\+?[^:]+:([^:]+)$/.exec(spec)?.[1];
        return target?.startsWith("refs/remotes/") ? [target] : [];
      });
      for (const ref of refs)
        if (
          ref.startsWith(`refs/remotes/${remote}/`) ||
          targets.some(
            (target) =>
              !validPattern(target, "refs/remotes/") ||
              matchPattern(target, ref) !== null,
          )
        )
          blocked.add(ref);
      continue;
    }
    for (const trackingRef of refs) {
      for (const mapping of specs.positive) {
        const captured = matchPattern(mapping.tracking, trackingRef);
        if (captured === null) continue;
        const destinationRef = mapping.source.replace("*", () => captured);
        if (
          !validPattern(destinationRef, "refs/heads/") ||
          destinationRef.includes("*") ||
          specs.negative.some(
            (pattern) => matchPattern(pattern, destinationRef) !== null,
          )
        )
          continue;
        const options = candidates.get(trackingRef) ?? new Map();
        options.set(`${remote}\0${destinationRef}`, {
          trackingRef,
          remote,
          destinationRef,
        });
        candidates.set(trackingRef, options);
      }
    }
  }
  return [...candidates.values()]
    .flatMap((options) =>
      options.size === 1
        ? [...options.values()].filter((item) => !blocked.has(item.trackingRef))
        : [],
    )
    .sort((a, b) => a.trackingRef.localeCompare(b.trackingRef));
}
