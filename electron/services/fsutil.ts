import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export type DataFileSafetyReason = "not_regular" | "too_large" | "changed";

/** A persisted-data leaf failed a check that must happen before allocation/parsing. */
export class DataFileSafetyError extends Error {
  constructor(
    message: string,
    readonly reason: DataFileSafetyReason
  ) {
    super(message);
    this.name = "DataFileSafetyError";
  }
}

/** JSON was malformed; `preservedPath` records whether the live file was moved aside. */
export class CorruptDataFileError extends Error {
  constructor(
    message: string,
    readonly preservedPath: string | null
  ) {
    super(message);
    this.name = "CorruptDataFileError";
  }
}

const PUBLIC_ERROR_MAX_CHARS = 2_000;

/**
 * Renderer diagnostics may describe a failure but must not disclose the local
 * workspace layout. Node filesystem errors usually quote the target path; the
 * remaining patterns cover unquoted Windows, UNC, file-URL, and common POSIX
 * absolute forms before applying a hard message bound.
 */
export function publicErrorMessage(error: unknown): string {
  return String(error)
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/g, "$1[local path]$1")
    .replace(/\bfile:\/\/\/[^\s"'<>]+/gi, "[local path]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n,;)]*/g, "[local path]")
    .replace(/\\\\[^\\\s]+\\[^\r\n,;)]*/g, "[local path]")
    .replace(
      /(^|[\s:(])\/(?:Users|home|tmp|var|private|opt|mnt|Volumes)(?:\/[^\r\n,;)]*)?/g,
      "$1[local path]"
    )
    .slice(0, PUBLIC_ERROR_MAX_CHARS);
}

function nextCorruptPath(file: string): string {
  const base = `${file}.corrupt-${Date.now()}`;
  let candidate = base;
  let suffix = 0;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

type DataFileSnapshot = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
};

type BoundedUtf8Read = {
  raw: string;
  snapshot: DataFileSnapshot;
};

function snapshotDataFile(stat: fs.BigIntStats): DataFileSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  };
}

function sameDataFileIdentity(left: DataFileSnapshot, right: DataFileSnapshot): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0n || right.ino !== 0n) return left.ino === right.ino;
  // Some Windows filesystems do not expose a stable inode. Birth time is the
  // strongest remaining replacement signal and is combined with version data.
  return left.birthtimeNs === right.birthtimeNs;
}

function sameDataFileVersion(left: DataFileSnapshot, right: DataFileSnapshot): boolean {
  return (
    sameDataFileIdentity(left, right) &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function regularDataFileSnapshot(file: string, label: string): DataFileSnapshot {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DataFileSafetyError(`${label} is not a regular file`, "not_regular");
  }
  return snapshotDataFile(stat);
}

function preserveCorruptDataFileOwned(
  file: string,
  expected?: DataFileSnapshot
): string {
  const current = regularDataFileSnapshot(file, path.basename(file));
  if (expected && !sameDataFileVersion(current, expected)) {
    throw new DataFileSafetyError(
      `${path.basename(file)} changed after it was read; the current file was left in place`,
      "changed"
    );
  }
  const corrupt = nextCorruptPath(file);
  fs.renameSync(file, corrupt);
  return corrupt;
}

/** Preserve an invalid ordinary data file without reading its contents again. */
export function preserveCorruptDataFile(file: string): string {
  return preserveCorruptDataFileOwned(file);
}

/**
 * Read one ordinary UTF-8 file with a hard byte ceiling. The descriptor loop
 * catches growth after the initial size check without allocating past the cap.
 */
function readUtf8BoundedOwned(
  file: string,
  maxBytes: number,
  label: string
): BoundedUtf8Read {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }

  const pathSnapshot = regularDataFileSnapshot(file, label);

  const chunks: Buffer[] = [];
  let total = 0;
  let fd: number | null = null;
  let completedSnapshot: DataFileSnapshot | null = null;
  try {
    fd = fs.openSync(file, "r");
    const openedStat = fs.fstatSync(fd, { bigint: true });
    if (!openedStat.isFile()) {
      throw new DataFileSafetyError(`${label} is not a regular file`, "not_regular");
    }
    const openedSnapshot = snapshotDataFile(openedStat);
    // The opened descriptor remains the only read source, but its version must
    // still match the pathname checked immediately before open.
    if (!sameDataFileVersion(pathSnapshot, openedSnapshot)) {
      throw new DataFileSafetyError(`${label} changed while it was being opened`, "changed");
    }
    if (openedStat.size > BigInt(maxBytes)) {
      throw new DataFileSafetyError(
        `${label} exceeds the ${maxBytes}-byte safety limit`,
        "too_large"
      );
    }

    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new DataFileSafetyError(
          `${label} exceeds the ${maxBytes}-byte safety limit`,
          "too_large"
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    completedSnapshot = snapshotDataFile(fs.fstatSync(fd, { bigint: true }));
    if (!sameDataFileVersion(openedSnapshot, completedSnapshot)) {
      throw new DataFileSafetyError(`${label} changed while it was being read`, "changed");
    }
    // A same-size rewrite can land inside the timestamp resolution, so the
    // descriptor version still matches. Re-read the bytes before trusting them.
    if (total > 0) {
      const verify = Buffer.allocUnsafe(total);
      const verified = fs.readSync(fd, verify, 0, total, 0);
      const read = Buffer.concat(chunks, total);
      if (verified !== total || !verify.subarray(0, verified).equals(read)) {
        throw new DataFileSafetyError(`${label} changed while it was being read`, "changed");
      }
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  if (!completedSnapshot) {
    throw new DataFileSafetyError(`${label} could not be read safely`, "changed");
  }
  return {
    raw: Buffer.concat(chunks, total).toString("utf8"),
    snapshot: completedSnapshot,
  };
}

export function readUtf8Bounded(file: string, maxBytes: number, label: string): string {
  return readUtf8BoundedOwned(file, maxBytes, label).raw;
}

export type ReadJsonOptions = {
  maxBytes?: number;
  label?: string;
  /** Reconstructable caches can remain in place for an explicit retry/rebuild. */
  preserveCorrupt?: boolean;
};

/**
 * Read JSON. Missing file → fallback.
 * Corrupt/unparseable file → rename to `*.corrupt-<ts>` and throw (never silently
 * treat as empty, which would invite a later overwrite wipe).
 */
export function readJson<T>(file: string, fallback: T, options: ReadJsonOptions = {}): T {
  try {
    fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Could not read data file ${path.basename(file)}: ${String(err)}`);
  }

  let read: BoundedUtf8Read;
  try {
    read = readUtf8BoundedOwned(
      file,
      options.maxBytes ?? Number.MAX_SAFE_INTEGER,
      options.label ?? path.basename(file)
    );
  } catch (err) {
    if (err instanceof DataFileSafetyError) throw err;
    // EACCES/EBUSY/EIO are availability failures, not proof of corrupt data.
    // Never rename a potentially valid live record merely because a read failed.
    throw new Error(`Could not read data file ${path.basename(file)}: ${String(err)}`);
  }

  try {
    return JSON.parse(read.raw) as T;
  } catch (err) {
    if (options.preserveCorrupt === false) {
      throw new CorruptDataFileError(
        `Corrupt data file ${path.basename(file)} (original left in place): ${String(err)}`,
        null
      );
    }
    let preservedPath: string | null = null;
    try {
      preservedPath = preserveCorruptDataFileOwned(file, read.snapshot);
      console.error(`[fsutil] Corrupt JSON preserved as ${preservedPath}`, err);
    } catch (renameErr) {
      if (renameErr instanceof DataFileSafetyError && renameErr.reason === "changed") {
        throw renameErr;
      }
      console.error(`[fsutil] Corrupt JSON at ${file}; rename failed`, err, renameErr);
    }
    throw new CorruptDataFileError(
      `Corrupt data file ${path.basename(file)}${
        preservedPath
          ? ` (preserved as ${path.basename(preservedPath)})`
          : " (could not be moved; original left in place)"
      }: ${String(err)}`,
      preservedPath
    );
  }
}

/** Reject targets that a direct write would follow outside the intended path. */
function assertAtomicTarget(file: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-regular file ${path.basename(file)}`);
  }
  return true;
}

/**
 * Commit text/binary data through an exclusively-created, fsynced temporary file.
 * Renaming the staged inode replaces a hardlink instead of writing through it,
 * while symbolic-link and non-file targets are rejected explicitly.
 */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file));
  assertAtomicTarget(file);

  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  let tempCreated = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    tempCreated = true;
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // A target introduced while staging must still be an ordinary file. The
    // rename itself never follows a hardlink or symlink target.
    assertAtomicTarget(file);
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* preserve the original write/fsync error */
      }
    }
    try {
      if (tempCreated && fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* preserve the original write/rename error */
    }
  }
}

export type WriteJsonOptions = {
  /** Reconstructable data can skip copying an arbitrarily large stale file. */
  backup?: boolean;
  /** Bound the exact UTF-8 representation before any filesystem mutation. */
  maxBytes?: number;
  label?: string;
};

/** Ceiling for reading an existing file as a backup source when the caller sets no maxBytes. */
const MAX_BACKUP_SOURCE_BYTES = 64 * 1024 * 1024;

/** Atomic JSON write with an independently staged best-effort backup. */
export function writeJson(
  file: string,
  data: unknown,
  options: WriteJsonOptions = {}
): void {
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) throw new Error("JSON value is not serializable");
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
  ) {
    throw new Error("JSON write limit must be a positive safe integer");
  }
  const jsonBytes = Buffer.byteLength(json, "utf8");
  if (options.maxBytes !== undefined && jsonBytes > options.maxBytes) {
    throw new DataFileSafetyError(
      `${options.label ?? path.basename(file)} exceeds the ${options.maxBytes}-byte safety limit`,
      "too_large"
    );
  }
  ensureDir(path.dirname(file));

  if (options.backup !== false && assertAtomicTarget(file)) {
    try {
      // Staging the backup avoids following a pre-created *.bak symlink and
      // prevents a failed copy from truncating the last recovery point. The
      // source read is bounded: a swapped-in giant file must not allocate
      // unbounded memory here — the backup is skipped instead (best-effort),
      // matching every other read in this layer.
      const backupLimit = options.maxBytes ?? MAX_BACKUP_SOURCE_BYTES;
      writeFileAtomic(
        `${file}.bak`,
        readUtf8Bounded(file, backupLimit, `${path.basename(file)} backup source`)
      );
    } catch {
      /* best-effort backup; the live atomic write still has independent safety */
    }
  }
  writeFileAtomic(file, json);
}

export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}
