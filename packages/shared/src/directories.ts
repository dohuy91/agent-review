/** Directory names only. Browsing does not register a repository or grant file access. */
export interface DirectoryRoot {
  id: string;
  label: string;
  path: string;
}
export interface DirectoryRootsResponse {
  nativePickerAvailable?: boolean;
  roots: DirectoryRoot[];
  message?: string;
}
export interface DirectoryEntry {
  name: string;
  relativePath: string;
}
export interface DirectoryListing {
  rootId: string;
  relativePath: string;
  path: string;
  entries: DirectoryEntry[];
  nextCursor: string | null;
  truncated: boolean;
  message?: string;
}
