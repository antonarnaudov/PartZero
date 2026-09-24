/**
 * The only filesystem access an external client gets (ARCHITECTURE §9: "no file access beyond the
 * export directory"): new files inside one directory the host chose.
 *
 * - The directory is resolved once (`realpath`) and must be an existing directory.
 * - Names are bare file names: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no `..`, no separators; the
 *   extension is set by the export format.
 * - Files are created exclusively (`wx`, mode 0644): an existing file (or symlink) is never
 *   overwritten or followed.
 * - Content is capped (16 MiB).
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportDir {
  /** The resolved directory. */
  readonly path: string;
  /** Create `<name><ext>` with `content`; returns the file name written. Throws {@link ExportError}. */
  write(name: string, ext: string, content: string): Promise<string>;
}

/** Validate a client-supplied file name stem (an extension equal to `ext` is dropped). */
export function exportFileName(name: string, ext: string): string {
  let stem = name.trim();
  if (stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length);
  if (!NAME.test(stem) || stem.includes("..")) {
    throw new ExportError(`Invalid file name "${name.slice(0, 80)}": use letters, digits, ".", "_" or "-" (at most 64, no directories).`);
  }
  return stem + ext;
}

export async function openExportDir(dir: string): Promise<ExportDir> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw new ExportError(`export directory ${dir} does not exist`);
  }
  const st = await lstat(real);
  if (!st.isDirectory()) throw new ExportError(`export directory ${dir} is not a directory`);
  return {
    path: real,
    async write(name, ext, content) {
      const file = exportFileName(name, ext);
      const target = join(real, file);
      if (dirname(target) !== real || basename(target) !== file) throw new ExportError("Invalid file name.");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_EXPORT_BYTES) throw new ExportError(`The export is ${bytes} bytes; the limit is ${MAX_EXPORT_BYTES}.`);
      let fh;
      try {
        // O_EXCL with O_CREAT never follows a symlink at the final component.
        fh = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw new ExportError(`${file} already exists in the export directory; choose another name.`);
        throw new ExportError(`Could not create ${file} (${code ?? "error"}).`);
      }
      try {
        await fh.writeFile(content, "utf8");
      } finally {
        await fh.close();
      }
      return file;
    },
  };
}
