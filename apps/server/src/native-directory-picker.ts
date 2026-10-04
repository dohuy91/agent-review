import {
  execFile,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DirectoryBrowseError } from "./directory-browser.js";

// Standard Additions only: no Finder automation, shell commands, or request data.
const CHOOSE_FOLDER_SCRIPT = `try
  set chosenFolder to choose folder with prompt "Choose a folder for Agent Review"
  return POSIX path of chosenFolder
on error number -128
  return ""
end try`;
export type NativePickerProcess = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
) => ChildProcess;
interface ActivePicker {
  id: string;
  child: ChildProcess | null;
  cancelled: boolean;
}
export class NativeDirectoryPicker {
  private active: ActivePicker | null = null;
  constructor(private run: NativePickerProcess = execFile) {}
  async choose(id = "legacy"): Promise<{ path: string | null }> {
    if (this.active)
      throw new DirectoryBrowseError(
        429,
        "A folder dialog is already open on the Mac running Agent Review. Choose a folder or cancel that dialog first.",
      );
    const active: ActivePicker = { id, child: null, cancelled: false };
    this.active = active;
    return new Promise((resolve, reject) => {
      const finish = async (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => {
        if (this.active === active) this.active = null;
        if (active.cancelled || (error && /\(-128\)\s*$/.test(stderr))) {
          resolve({ path: null });
          return;
        }
        if (error) {
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            reject(
              new DirectoryBrowseError(
                502,
                "The folder dialog returned too much data. Choose a folder with a shorter path.",
              ),
            );
          else if (error.killed || error.signal === "SIGKILL")
            reject(
              new DirectoryBrowseError(
                504,
                "The folder dialog timed out. Choose folder again to reopen it.",
              ),
            );
          else if (
            /\(-1743\)|not authorized|not permitted|permission denied/i.test(
              stderr,
            )
          )
            reject(
              new DirectoryBrowseError(
                403,
                "macOS blocked the folder dialog. Review the system prompt or folder permissions, then try again.",
              ),
            );
          else
            reject(
              new DirectoryBrowseError(
                503,
                "The macOS folder dialog could not open. Run Agent Review in a signed-in Mac desktop session and try again.",
              ),
            );
          return;
        }
        const path = stdout.replace(/\r?\n$/, "");
        if (!path) {
          resolve({ path: null });
          return;
        }
        if (
          !isAbsolute(path) ||
          path.length > 4096 ||
          /[\u0000-\u001f\u007f]/u.test(path)
        ) {
          reject(
            new DirectoryBrowseError(
              502,
              "The folder dialog returned an invalid path. Choose another folder.",
            ),
          );
          return;
        }
        try {
          const canonical = await realpath(path);
          if (!(await lstat(canonical)).isDirectory())
            throw new Error("Not a directory");
          resolve({ path: canonical });
        } catch {
          reject(
            new DirectoryBrowseError(
              400,
              "The selected folder is no longer available. Choose it again.",
            ),
          );
        }
      };
      try {
        active.child = this.run(
          "/usr/bin/osascript",
          ["-e", CHOOSE_FOLDER_SCRIPT],
          {
            shell: false,
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 16 * 1024,
            killSignal: "SIGKILL",
          },
          (error, stdout, stderr) => {
            void finish(error, stdout, stderr);
          },
        );
      } catch {
        if (this.active === active) this.active = null;
        reject(
          new DirectoryBrowseError(
            503,
            "The macOS folder dialog could not start. Run Agent Review in a signed-in Mac desktop session and try again.",
          ),
        );
      }
    });
  }
  cancel(id?: string) {
    if (
      !this.active ||
      this.active.cancelled ||
      (id !== undefined && this.active.id !== id)
    )
      return;
    this.active.cancelled = true;
    // This process only displays our fixed chooser; no user command is executed.
    try {
      this.active.child?.kill("SIGKILL");
    } catch {
      /* The fixed execution timeout still bounds the owned chooser. */
    }
  }
}

export const nativeDirectoryPicker = new NativeDirectoryPicker();
