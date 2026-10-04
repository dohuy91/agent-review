import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";

/** Tests should use Git's canonical identity even when the OS temp path is an alias. */
export async function canonicalMkdtemp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix));
}

/** Probe the mounted filesystem, not the OS name; other IO failures remain failures. */
export async function invalidUtf8FilenameUnsupported(
  root: string,
): Promise<string | null> {
  const path = Buffer.concat([
    Buffer.from(`${root}/`),
    Buffer.from([0xff]),
    Buffer.from(".filename-capability-probe"),
  ]);
  try {
    await writeFile(path, "probe", { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EILSEQ" || code === "ENOTSUP")
      return `Filesystem cannot create invalid UTF-8 filename bytes (${code}); physical filename collision scenario is unsupported.`;
    throw error;
  }
  await rm(path);
  return null;
}
