/**
 * Minimal ambient types for the File System Access API's save-file path — TypeScript's bundled DOM
 * lib doesn't carry it yet, and the only caller (ComposePage's timeline download) needs exactly
 * `showSaveFilePicker` and the writable-stream handle it returns, not the wider API surface
 * (directory pickers, permission queries, read handles, …). A few interfaces here beat pulling in
 * a whole `@types/wicg-file-system-access` for one function.
 *
 * No imports/exports in this file on purpose: that keeps it an ambient *script*, so `interface
 * Window` below merges into the real global `Window` type instead of needing `declare global`.
 */

interface FileSystemWritableFileStream {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}

interface Window {
  /** Chromium only (Edge included); absent in Firefox and Safari as of this writing — always
   *  feature-detect before calling. */
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
