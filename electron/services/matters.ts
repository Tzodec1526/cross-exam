import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { matterDir, mattersRoot } from "../paths.js";
import type { Attitude, Matter, Persona } from "../types.js";
import {
  ensureDir,
  publicErrorMessage,
  readJson,
  readUtf8Bounded,
  writeJson,
} from "./fsutil.js";

export function ensureWorkspace(): void {
  assertTrustedMattersRoot(true);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Hard ceilings for local metadata that is parsed synchronously on the main thread. */
export const MATTER_STORAGE_LIMITS = Object.freeze({
  maxMatterJsonBytes: 64 * 1024,
  maxPersonasJsonBytes: 16 * 1024 * 1024,
  maxPersonas: 1_000,
  maxCaptionChars: 500,
  maxCourtChars: 300,
  maxNotesChars: 10_000,
  maxNameChars: 200,
  maxRoleChars: 200,
  maxKeyterms: 50,
  maxKeytermChars: 80,
  maxVoiceChars: 80,
  maxTimestampChars: 100,
});

export type ListMattersResult = {
  matters: Matter[];
  /** Corrupt / unreadable matter metadata (paths preserved as .corrupt-* or .bak). */
  dataErrors: string[];
};

function validateMatterValue(value: unknown, file: string, expectedId: string): Matter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} is not a matter object.`);
  }

  const record = value as Record<string, unknown>;
  const requiredStrings = ["id", "caption", "court", "notes", "createdAt", "updatedAt"];
  const missing = requiredStrings.filter((key) => typeof record[key] !== "string");
  if (missing.length) {
    throw new Error(
      `Matter ${expectedId}: ${path.basename(file)} has invalid fields: ${missing.join(", ")}.`
    );
  }
  if (record.id !== expectedId) {
    throw new Error(
      `Matter ${expectedId}: ${path.basename(file)} contains mismatched id ${String(record.id)}.`
    );
  }
  const caption = record.caption as string;
  const court = record.court as string;
  const notes = record.notes as string;
  const createdAt = record.createdAt as string;
  const updatedAt = record.updatedAt as string;
  if (!caption.trim()) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} has an empty caption.`);
  }
  if (caption.length > MATTER_STORAGE_LIMITS.maxCaptionChars) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} caption is too long.`);
  }
  if (court.length > MATTER_STORAGE_LIMITS.maxCourtChars) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} court is too long.`);
  }
  if (notes.length > MATTER_STORAGE_LIMITS.maxNotesChars) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} notes are too long.`);
  }
  if (
    createdAt.length > MATTER_STORAGE_LIMITS.maxTimestampChars ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} has invalid createdAt.`);
  }
  if (
    updatedAt.length > MATTER_STORAGE_LIMITS.maxTimestampChars ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error(`Matter ${expectedId}: ${path.basename(file)} has invalid updatedAt.`);
  }

  // Return a canonical value so unknown persisted fields never cross IPC or get
  // reserialized by a later metadata update.
  return { id: expectedId, caption, court, notes, createdAt, updatedAt };
}

function readMatterFile(file: string, expectedId: string): Matter {
  return validateMatterValue(
    readJson<unknown>(file, null, {
      maxBytes: MATTER_STORAGE_LIMITS.maxMatterJsonBytes,
      label: "Matter metadata",
    }),
    file,
    expectedId
  );
}

/** Read a recovery candidate without renaming or otherwise mutating it on failure. */
function readMatterCandidate(file: string, expectedId: string): Matter {
  const value = JSON.parse(
    readUtf8Bounded(
      file,
      MATTER_STORAGE_LIMITS.maxMatterJsonBytes,
      "Matter metadata recovery candidate"
    )
  ) as unknown;
  return validateMatterValue(value, file, expectedId);
}

type TrustedMatterDirectory = {
  resolvedRoot: string;
  realRoot: string;
  resolvedMatter: string;
  realMatter: string;
};

type TrustedMattersRoot = Pick<TrustedMatterDirectory, "resolvedRoot" | "realRoot">;

function isPathOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Create (when requested) and validate the matters root itself. An existing
 * junction here is just as dangerous as one at an individual matter: every
 * later create/write would otherwise be redirected outside the data root.
 */
function assertTrustedMattersRoot(create: boolean): TrustedMattersRoot {
  const resolvedRoot = path.resolve(mattersRoot());
  const resolvedParent = path.dirname(resolvedRoot);

  if (!fs.existsSync(resolvedParent)) {
    if (!create) throw new Error("Matters directory not found");
    ensureDir(resolvedParent);
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(resolvedRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Matters directory not found");
      }
      throw err;
    }
    // The parent is known to exist. A non-recursive create cannot silently
    // descend through a pre-existing matters junction.
    fs.mkdirSync(resolvedRoot);
    rootStat = fs.lstatSync(resolvedRoot);
  }

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Matters directory is not a trusted directory");
  }

  const realParent = fs.realpathSync.native(resolvedParent);
  const realRoot = fs.realpathSync.native(resolvedRoot);
  if (isPathOutside(realParent, realRoot) || realParent === realRoot) {
    throw new Error("Matters directory resolves outside its data directory");
  }
  return { resolvedRoot, realRoot };
}

/**
 * Resolve a matter only through ordinary directories. Junctions/symlinks are
 * rejected before destructive operations or writes can escape the data root.
 */
function assertTrustedMatterDirectory(matterId: string): TrustedMatterDirectory {
  if (!UUID_RE.test(matterId)) throw new Error("Invalid matter id");

  const { resolvedRoot, realRoot } = assertTrustedMattersRoot(false);
  const resolvedMatter = path.resolve(matterDir(matterId));
  if (isPathOutside(resolvedRoot, resolvedMatter) || resolvedRoot === resolvedMatter) {
    throw new Error("Matter path is outside the matters directory");
  }
  if (!fs.existsSync(resolvedMatter)) {
    throw new Error("Matter not found");
  }

  const matterStat = fs.lstatSync(resolvedMatter);
  if (!matterStat.isDirectory() || matterStat.isSymbolicLink()) {
    throw new Error("Matter directory is not a trusted directory");
  }

  const realMatter = fs.realpathSync.native(resolvedMatter);
  if (isPathOutside(realRoot, realMatter) || realRoot === realMatter) {
    throw new Error("Matter directory resolves outside the matters directory");
  }
  return { resolvedRoot, realRoot, resolvedMatter, realMatter };
}

/** Missing matter directories preserve the public read APIs' empty/null behavior. */
function findTrustedMatterDirectory(matterId: string): TrustedMatterDirectory | null {
  if (!UUID_RE.test(matterId)) throw new Error("Invalid matter id");
  const resolvedRoot = path.resolve(mattersRoot());
  const resolvedMatter = path.resolve(matterDir(matterId));
  // A missing or dangling path cannot be read from or written through. Existing
  // paths still go through lstat + realpath validation below.
  if (!fs.existsSync(resolvedRoot) || !fs.existsSync(resolvedMatter)) return null;
  return assertTrustedMatterDirectory(matterId);
}

function matterFile(trustedMatter: TrustedMatterDirectory, name: string): string {
  // Native realpath rewrites Windows 8.3 names. Persistence and identity checks
  // stay on the lexical path that was validated against that real path.
  return path.join(trustedMatter.resolvedMatter, name);
}

/** Canonical case-record path after validating the matters and matter directories. */
export function assertTrustedIndexPath(matterId: string): string {
  return matterFile(assertTrustedMatterDirectory(matterId), "index.json");
}

/** Preserve empty-read semantics for a missing matter while rejecting unsafe existing paths. */
export function findTrustedIndexPath(matterId: string): string | null {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  return trustedMatter ? matterFile(trustedMatter, "index.json") : null;
}

function readTrustedMatter(
  trustedMatter: TrustedMatterDirectory,
  matterId: string
): Matter | null {
  const file = matterFile(trustedMatter, "matter.json");
  if (!fs.existsSync(file)) return null;
  return readMatterFile(file, matterId);
}

function touchTrustedMatter(trustedMatter: TrustedMatterDirectory, matterId: string): void {
  const matter = readTrustedMatter(trustedMatter, matterId);
  if (!matter) return;
  matter.updatedAt = new Date().toISOString();
  writeJson(matterFile(trustedMatter, "matter.json"), matter);
}

function trustedDocumentsDirectory(
  trustedMatter: TrustedMatterDirectory,
  create: boolean
): string {
  const resolvedDocs = path.resolve(trustedMatter.resolvedMatter, "documents");
  if (
    isPathOutside(trustedMatter.resolvedMatter, resolvedDocs) ||
    trustedMatter.resolvedMatter === resolvedDocs
  ) {
    throw new Error("Documents path is outside the matter directory");
  }
  let docsStat: fs.Stats;
  try {
    docsStat = fs.lstatSync(resolvedDocs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Matter documents folder not found");
      }
      throw err;
    }
    // This is a single child of a previously validated matter. Avoid recursive
    // creation, which could follow a concurrently introduced reparse point.
    fs.mkdirSync(resolvedDocs);
    docsStat = fs.lstatSync(resolvedDocs);
  }

  if (!docsStat.isDirectory() || docsStat.isSymbolicLink()) {
    throw new Error("Matter documents folder is not a trusted directory");
  }
  const realDocs = fs.realpathSync.native(resolvedDocs);
  if (
    isPathOutside(trustedMatter.realMatter, realDocs) ||
    trustedMatter.realMatter === realDocs
  ) {
    throw new Error("Matter documents folder resolves outside the matter directory");
  }
  return resolvedDocs;
}

/**
 * Return the canonical documents directory after rejecting a replaced matters,
 * matter, or documents directory. Callers that only read should keep `create`
 * false; imports may request creation for a known, trusted matter.
 */
export function assertTrustedDocumentsDirectory(
  matterId: string,
  create = false
): string {
  return trustedDocumentsDirectory(assertTrustedMatterDirectory(matterId), create);
}

function trustedSessionsDirectory(
  trustedMatter: TrustedMatterDirectory,
  create: boolean
): string {
  const resolvedSessions = path.resolve(trustedMatter.resolvedMatter, "sessions");
  if (
    isPathOutside(trustedMatter.resolvedMatter, resolvedSessions) ||
    trustedMatter.resolvedMatter === resolvedSessions
  ) {
    throw new Error("Sessions path is outside the matter directory");
  }

  let sessionsStat: fs.Stats;
  try {
    sessionsStat = fs.lstatSync(resolvedSessions);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Matter sessions folder not found");
      }
      throw err;
    }
    // Only create this single child after the entire parent chain has passed
    // lstat/realpath validation. Recursive creation could follow a reparse point.
    fs.mkdirSync(resolvedSessions);
    sessionsStat = fs.lstatSync(resolvedSessions);
  }

  if (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink()) {
    throw new Error("Matter sessions folder is not a trusted directory");
  }
  const realSessions = fs.realpathSync.native(resolvedSessions);
  if (
    isPathOutside(trustedMatter.realMatter, realSessions) ||
    trustedMatter.realMatter === realSessions
  ) {
    throw new Error("Matter sessions folder resolves outside the matter directory");
  }
  return realSessions;
}

/** Return the canonical session store after validating every parent directory. */
export function assertTrustedSessionsDirectory(
  matterId: string,
  create = false
): string {
  return trustedSessionsDirectory(assertTrustedMatterDirectory(matterId), create);
}

/**
 * Read-side variant that preserves the historical empty-list behavior for an
 * absent matter/session store while still rejecting an existing reparse point.
 */
export function findTrustedSessionsDirectory(matterId: string): string | null {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter) return null;

  const resolvedSessions = path.resolve(trustedMatter.resolvedMatter, "sessions");
  try {
    fs.lstatSync(resolvedSessions);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return trustedSessionsDirectory(trustedMatter, false);
}

export function listMatters(): ListMattersResult {
  const root = assertTrustedMattersRoot(true).resolvedRoot;

  const matters: Matter[] = [];
  const dataErrors: string[] = [];

  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!UUID_RE.test(d.name)) continue;
    if (!d.isDirectory() || d.isSymbolicLink()) {
      // A junction/symlink (or stray file) where a matter directory belongs is
      // invisible to the directory scan but fails every direct access. Surface
      // it instead of silently hiding the matter.
      dataErrors.push(
        `Matter ${d.name}: entry is not a trusted matter directory and was skipped.`
      );
      continue;
    }
    try {
      const trustedMatter = assertTrustedMatterDirectory(d.name);
      const metaPath = matterFile(trustedMatter, "matter.json");
      const bakPath = `${metaPath}.bak`;
      if (!fs.existsSync(metaPath)) {
        if (fs.existsSync(bakPath)) {
          dataErrors.push(
            `Matter ${d.name}: matter.json missing; backup at matter.json.bak (use Restore).`
          );
        } else {
          const corrupt = findLatestCorrupt(metaPath);
          if (corrupt) {
            dataErrors.push(
              `Matter ${d.name}: matter.json missing; corrupt copy at ${path.basename(corrupt)}.`
            );
          } else {
            dataErrors.push(
              `Matter ${d.name}: matter.json missing; no backup or corrupt copy is available.`
            );
          }
        }
        continue;
      }
      matters.push(readMatterFile(metaPath, d.name));
    } catch (err) {
      // Renderer-facing: never disclose local filesystem paths.
      const detail = publicErrorMessage(err);
      dataErrors.push(
        detail.includes(`Matter ${d.name}:`) ? detail : `Matter ${d.name}: ${detail}`
      );
    }
  }

  matters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { matters, dataErrors };
}

function findCorruptCandidates(metaPath: string): string[] {
  const dir = path.dirname(metaPath);
  const base = path.basename(metaPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.corrupt-`))
    .sort((a, b) => b.localeCompare(a))
    .map((name) => path.join(dir, name));
}

function findLatestCorrupt(metaPath: string): string | null {
  return findCorruptCandidates(metaPath)[0] ?? null;
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

function atomicallyRestoreMatter(
  metaPath: string,
  matter: Matter
): { ok: true } | { ok: false; error: string } {
  const tmp = `${metaPath}.restore-tmp-${process.pid}-${uuid()}`;
  const preserved = fs.existsSync(metaPath) ? nextCorruptPath(metaPath) : null;
  let movedLive = false;
  let fd: number | null = null;

  try {
    ensureDir(path.dirname(metaPath));
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(matter, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (preserved) {
      fs.renameSync(metaPath, preserved);
      movedLive = true;
    }
    fs.renameSync(tmp, metaPath);
    return { ok: true };
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }

    if (movedLive && preserved && !fs.existsSync(metaPath)) {
      try {
        fs.renameSync(preserved, metaPath);
      } catch (rollbackErr) {
        return {
          ok: false,
          error: `Restore failed; damaged metadata remains at ${path.basename(preserved)}. Rollback also failed: ${publicErrorMessage(rollbackErr)}`,
        };
      }
    }
    return { ok: false, error: `Could not restore matter metadata: ${publicErrorMessage(err)}` };
  }
}

/**
 * Restore matter.json from .bak or newest .corrupt-* file.
 * Returns the matter if parse succeeds after restore.
 */
export function restoreMatterMeta(matterId: string): {
  ok: boolean;
  matter?: Matter;
  error?: string;
  restoredFrom?: string;
} {
  if (!UUID_RE.test(matterId)) return { ok: false, error: "Invalid matter id" };
  let trustedMatter: TrustedMatterDirectory;
  try {
    trustedMatter = assertTrustedMatterDirectory(matterId);
  } catch (err) {
    return { ok: false, error: publicErrorMessage(err) };
  }
  const metaPath = path.join(trustedMatter.resolvedMatter, "matter.json");
  const bakPath = `${metaPath}.bak`;

  if (fs.existsSync(metaPath)) {
    try {
      readMatterCandidate(metaPath, matterId);
      return { ok: false, error: "The live matter metadata is valid; restore is not needed." };
    } catch {
      // Validate a recovery candidate before moving the damaged live file.
    }
  }

  const candidates: string[] = [];
  if (fs.existsSync(bakPath)) candidates.push(bakPath);
  candidates.push(...findCorruptCandidates(metaPath));

  if (!candidates.length) {
    return { ok: false, error: "No matter.json.bak or .corrupt-* file found for this matter." };
  }

  // Prefer .bak, but validate every candidate before replacing the live file.
  const failures: string[] = [];
  for (const source of candidates) {
    try {
      const matter = readMatterCandidate(source, matterId);
      const restored = atomicallyRestoreMatter(metaPath, matter);
      if (!restored.ok) return restored;
      return { ok: true, matter, restoredFrom: path.basename(source) };
    } catch (err) {
      failures.push(`${path.basename(source)}: ${publicErrorMessage(err)}`);
    }
  }
  return {
    ok: false,
    error: `No valid matter metadata backup found. ${failures.join(" ")}`,
  };
}

const ATTITUDES = new Set<Attitude>([
  "hostile",
  "evasive",
  "cooperative",
  "neutral",
  "expert",
]);

export function createMatter(input: {
  caption: string;
  court?: string;
  notes?: string;
}): Matter {
  const trustedRoot = assertTrustedMattersRoot(true);
  const caption = (input.caption ?? "").trim();
  if (!caption) throw new Error("Caption is required");
  if (caption.length > MATTER_STORAGE_LIMITS.maxCaptionChars) {
    throw new Error("Caption is too long (max 500 characters)");
  }
  const court = (input.court ?? "").trim();
  const notes = (input.notes ?? "").trim();
  if (court.length > MATTER_STORAGE_LIMITS.maxCourtChars) {
    throw new Error("Court is too long (max 300 characters)");
  }
  if (notes.length > MATTER_STORAGE_LIMITS.maxNotesChars) {
    throw new Error("Notes are too long (max 10,000 characters)");
  }

  const id = uuid();
  const now = new Date().toISOString();
  const matter: Matter = {
    id,
    caption,
    court,
    notes,
    createdAt: now,
    updatedAt: now,
  };
  const createdMatterDir = path.join(trustedRoot.resolvedRoot, id);
  fs.mkdirSync(createdMatterDir);
  try {
    fs.mkdirSync(path.join(createdMatterDir, "documents"));
    fs.mkdirSync(path.join(createdMatterDir, "sessions"));
    writeJson(path.join(createdMatterDir, "matter.json"), matter);
    writeJson(path.join(createdMatterDir, "personas.json"), [] as Persona[]);
  } catch (err) {
    // This directory was created moments ago under a fresh UUID and holds no
    // user data yet. Remove the partial skeleton so every later listing does
    // not report a permanently broken matter.
    try {
      fs.rmSync(createdMatterDir, { recursive: true, force: true });
    } catch {
      /* the partial directory will surface through listMatters dataErrors */
    }
    throw err;
  }
  return matter;
}

export function getMatter(matterId: string): Matter | null {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter) return null;
  return readTrustedMatter(trustedMatter, matterId);
}

/**
 * Permanently remove a matter directory (documents, index, personas, sessions).
 * Only deletes under matters/<uuid>/.
 */
export function deleteMatter(matterId: string): { deleted: string } {
  const trusted = assertTrustedMatterDirectory(matterId);
  fs.rmSync(trusted.resolvedMatter, { recursive: true, force: false });
  return { deleted: matterId };
}

export function touchMatter(matterId: string): void {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter) return;
  touchTrustedMatter(trustedMatter, matterId);
}

export function updateMatter(
  matterId: string,
  patch: { caption?: string; court?: string; notes?: string }
): Matter {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter) throw new Error("Matter not found");
  const m = readTrustedMatter(trustedMatter, matterId);
  if (!m) throw new Error("Matter not found");

  if (patch.caption !== undefined) {
    const caption = patch.caption.trim();
    if (!caption) throw new Error("Caption is required");
    if (caption.length > MATTER_STORAGE_LIMITS.maxCaptionChars) {
      throw new Error("Caption is too long (max 500 characters)");
    }
    m.caption = caption;
  }
  if (patch.court !== undefined) {
    const court = patch.court.trim();
    if (court.length > MATTER_STORAGE_LIMITS.maxCourtChars) {
      throw new Error("Court is too long (max 300 characters)");
    }
    m.court = court;
  }
  if (patch.notes !== undefined) {
    const notes = patch.notes.trim();
    if (notes.length > MATTER_STORAGE_LIMITS.maxNotesChars) {
      throw new Error("Notes are too long (max 10,000 characters)");
    }
    m.notes = notes;
  }

  m.updatedAt = new Date().toISOString();
  writeJson(matterFile(trustedMatter, "matter.json"), m);
  return m;
}

function readTrustedPersonas(
  trustedMatter: TrustedMatterDirectory,
  matterId: string
): Persona[] {
  const file = matterFile(trustedMatter, "personas.json");
  const raw = readJson<unknown>(file, [], {
    maxBytes: MATTER_STORAGE_LIMITS.maxPersonasJsonBytes,
    label: "Saved people metadata",
  });
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid ${path.basename(file)}: expected a list of people. The file was preserved and will not be overwritten.`
    );
  }
  if (raw.length > MATTER_STORAGE_LIMITS.maxPersonas) {
    throw new Error(
      `Invalid ${path.basename(file)}: cannot contain more than ${MATTER_STORAGE_LIMITS.maxPersonas} people.`
    );
  }

  const ids = new Set<string>();
  return raw.map((value, index): Persona => {
    const label = `person ${index + 1}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid ${path.basename(file)}: ${label} is not an object.`);
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !UUID_RE.test(row.id)) {
      throw new Error(`Invalid ${path.basename(file)}: ${label} has an invalid id.`);
    }
    if (ids.has(row.id)) {
      throw new Error(`Invalid ${path.basename(file)}: ${label} has a duplicate id.`);
    }
    ids.add(row.id);
    if (row.matterId !== matterId) {
      throw new Error(
        `Invalid ${path.basename(file)}: ${label} belongs to another matter.`
      );
    }
    const fullName = typeof row.fullName === "string" ? row.fullName.trim() : "";
    if (!fullName) {
      throw new Error(`Invalid ${path.basename(file)}: ${label} has no name.`);
    }
    if (fullName.length > MATTER_STORAGE_LIMITS.maxNameChars) {
      throw new Error(`Invalid ${path.basename(file)}: ${label} name is too long.`);
    }

    const optionalString = (field: string, maxChars: number): string => {
      const candidate = row[field];
      // Older records may omit optional fields, but a present value must retain
      // the same shape and ceiling enforced by savePersona.
      if (candidate === undefined) return "";
      if (typeof candidate !== "string") {
        throw new Error(`Invalid ${path.basename(file)}: ${label} has invalid ${field}.`);
      }
      if (candidate.length > maxChars) {
        throw new Error(`Invalid ${path.basename(file)}: ${label} ${field} is too long.`);
      }
      return candidate;
    };

    const role = optionalString("role", MATTER_STORAGE_LIMITS.maxRoleChars);
    const notes = optionalString("notes", MATTER_STORAGE_LIMITS.maxNotesChars);
    const voice = optionalString("voice", MATTER_STORAGE_LIMITS.maxVoiceChars);
    const createdAt = optionalString("createdAt", MATTER_STORAGE_LIMITS.maxTimestampChars);
    if (createdAt && !Number.isFinite(Date.parse(createdAt))) {
      throw new Error(`Invalid ${path.basename(file)}: ${label} has invalid createdAt.`);
    }

    let attitude: Attitude = "neutral";
    if (row.attitude !== undefined) {
      if (typeof row.attitude !== "string" || !ATTITUDES.has(row.attitude as Attitude)) {
        throw new Error(`Invalid ${path.basename(file)}: ${label} has invalid attitude.`);
      }
      attitude = row.attitude as Attitude;
    }
    let keyterms: string[] = [];
    if (row.keyterms !== undefined) {
      if (!Array.isArray(row.keyterms)) {
        throw new Error(`Invalid ${path.basename(file)}: ${label} has invalid keyterms.`);
      }
      if (row.keyterms.length > MATTER_STORAGE_LIMITS.maxKeyterms) {
        throw new Error(`Invalid ${path.basename(file)}: ${label} has too many keyterms.`);
      }
      keyterms = row.keyterms
        .map((term) => {
          if (typeof term !== "string") {
            throw new Error(`Invalid ${path.basename(file)}: ${label} has a non-text keyterm.`);
          }
          const normalized = term.trim();
          if (normalized.length > MATTER_STORAGE_LIMITS.maxKeytermChars) {
            throw new Error(`Invalid ${path.basename(file)}: ${label} has a keyterm that is too long.`);
          }
          return normalized;
        })
        .filter(Boolean);
    }
    return {
      id: row.id,
      matterId,
      fullName,
      role,
      attitude,
      notes,
      keyterms,
      voice,
      createdAt,
    };
  });
}

function writeTrustedPersonas(file: string, personas: Persona[]): void {
  // writeJson persists pretty-printed JSON. Check that exact representation so
  // a compact-size estimate cannot create a file the bounded reader rejects.
  const serialized = JSON.stringify(personas, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MATTER_STORAGE_LIMITS.maxPersonasJsonBytes) {
    throw new Error(
      `Saved people metadata exceeds the ${MATTER_STORAGE_LIMITS.maxPersonasJsonBytes}-byte safety limit`
    );
  }
  writeJson(file, personas);
}

export function listPersonas(matterId: string): Persona[] {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter) return [];
  return readTrustedPersonas(trustedMatter, matterId);
}

export function savePersona(
  matterId: string,
  input: {
    id?: string;
    fullName: string;
    role: string;
    attitude: Attitude;
    notes: string;
    keyterms: string[];
    voice: string;
  }
): Persona {
  if (!UUID_RE.test(matterId)) throw new Error("Invalid matter id");
  if (input.id && !UUID_RE.test(input.id)) throw new Error("Invalid persona id");

  const fullName = (input.fullName ?? "").trim();
  if (!fullName) throw new Error("Full name is required");
  if (fullName.length > MATTER_STORAGE_LIMITS.maxNameChars) {
    throw new Error("Full name is too long (max 200 characters)");
  }

  const role = (input.role ?? "").trim();
  if (role.length > MATTER_STORAGE_LIMITS.maxRoleChars) {
    throw new Error("Role is too long (max 200 characters)");
  }

  const attitude = input.attitude;
  if (!ATTITUDES.has(attitude)) {
    throw new Error("Invalid attitude (use hostile, evasive, cooperative, neutral, or expert)");
  }

  const notes = (input.notes ?? "").trim();
  if (notes.length > MATTER_STORAGE_LIMITS.maxNotesChars) {
    throw new Error("Notes are too long (max 10,000 characters)");
  }

  const voice = (input.voice ?? "").trim();
  if (voice.length > MATTER_STORAGE_LIMITS.maxVoiceChars) {
    throw new Error("Voice id is too long");
  }

  const keyterms = (input.keyterms ?? [])
    .map((k) => String(k ?? "").trim())
    .filter(Boolean)
    .slice(0, MATTER_STORAGE_LIMITS.maxKeyterms);
  if (keyterms.some((k) => k.length > MATTER_STORAGE_LIMITS.maxKeytermChars)) {
    throw new Error("Each key term must be 80 characters or fewer");
  }

  // Keep the validated directory for every read/write in this operation.
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter || !readTrustedMatter(trustedMatter, matterId)) {
    throw new Error("Matter not found");
  }

  const personas = readTrustedPersonas(trustedMatter, matterId);
  if (!input.id && personas.length >= MATTER_STORAGE_LIMITS.maxPersonas) {
    throw new Error(
      `Cannot save more than ${MATTER_STORAGE_LIMITS.maxPersonas} people in one matter`
    );
  }
  const now = new Date().toISOString();
  let persona: Persona;
  if (input.id) {
    const idx = personas.findIndex((p) => p.id === input.id);
    if (idx < 0) throw new Error("Persona not found");
    persona = {
      ...personas[idx]!,
      fullName,
      role,
      attitude,
      notes,
      keyterms,
      voice,
    };
    personas[idx] = persona;
  } else {
    persona = {
      id: uuid(),
      matterId,
      fullName,
      role,
      attitude,
      notes,
      keyterms,
      voice,
      createdAt: now,
    };
    personas.push(persona);
  }
  writeTrustedPersonas(matterFile(trustedMatter, "personas.json"), personas);
  touchTrustedMatter(trustedMatter, matterId);
  return persona;
}

export function deletePersona(matterId: string, personaId: string): void {
  const trustedMatter = findTrustedMatterDirectory(matterId);
  if (!trustedMatter || !readTrustedMatter(trustedMatter, matterId)) {
    throw new Error("Matter not found");
  }
  const personas = readTrustedPersonas(trustedMatter, matterId);
  const remaining = personas.filter((persona) => persona.id !== personaId);
  // Deletion stays idempotent, but an absent persona must not rewrite the
  // people file or bump the matter timestamp.
  if (remaining.length === personas.length) return;
  writeTrustedPersonas(matterFile(trustedMatter, "personas.json"), remaining);
  touchTrustedMatter(trustedMatter, matterId);
}

/** Win32 device names that map to devices regardless of extension. */
const WINDOWS_RESERVED_STEMS = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Source files from network shares can legally carry names Win32 cannot store:
 * reserved device stems (CON, NUL, COM1…), characters the Win32 layer forbids,
 * and trailing dots/spaces it silently strips (making the on-disk name differ
 * from the recorded one). Normalize before a destination name is claimed.
 */
export function sanitizeImportLeafName(base: string): string {
  let name = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "");
  if (!name) name = "document";
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  if (WINDOWS_RESERVED_STEMS.has(stem.toLowerCase())) {
    name = `_${name}`;
  }
  return name;
}

/**
 * Unique path under destDir when base already exists (or was claimed earlier in this batch).
 * e.g. depo.pdf → depo (1).pdf → depo (2).pdf
 */
function destinationNameTaken(destDir: string, name: string): boolean {
  try {
    fs.lstatSync(path.join(destDir, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function assertImportedRegularFile(destDir: string, dest: string): void {
  const stat = fs.lstatSync(dest);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Import destination is not a regular file.");
  }
  const realDir = fs.realpathSync.native(destDir);
  const realDest = fs.realpathSync.native(dest);
  if (realDir === realDest || isPathOutside(realDir, realDest)) {
    throw new Error("Import destination resolved outside the documents folder.");
  }
}

function uniqueDestName(destDir: string, base: string, claimed: Set<string>): string {
  const rawBase = path.basename(base);
  if (!rawBase || rawBase === "." || rawBase === "..") {
    throw new Error(`Invalid file name: ${base}`);
  }
  const safeBase = sanitizeImportLeafName(rawBase);
  const ext = path.extname(safeBase);
  const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
  let candidate = safeBase;
  let n = 0;
  while (claimed.has(candidate.toLowerCase()) || destinationNameTaken(destDir, candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  claimed.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Import limits mirror the indexer's 500-file and 100 MiB-per-file bounds.
 * The additional 1 GiB batch ceiling is generous for a local evidence import,
 * while keeping one synchronous operation from claiming unbounded disk space.
 */
export const IMPORT_LIMITS = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

/** Import failed after destination state could no longer be proven unchanged. */
export class ImportRollbackUncertainError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "ImportRollbackUncertainError";
  }
}

function importSourceError(source: unknown): Error {
  const label = typeof source === "string" && source ? source : "(empty)";
  return new Error(`Import source is not a readable file: ${label}`);
}

/** Validate every source before the destination directory or a filename is claimed. */
function preflightImportSources(filePaths: string[]): void {
  if (!Array.isArray(filePaths)) {
    throw new Error("Import sources must be a list of files");
  }
  if (filePaths.length > IMPORT_LIMITS.maxFiles) {
    throw new Error(`Cannot import more than ${IMPORT_LIMITS.maxFiles} files at once`);
  }

  let totalBytes = 0;
  for (const src of filePaths) {
    if (typeof src !== "string" || !src) throw importSourceError(src);

    let sourceStat: fs.Stats;
    try {
      sourceStat = fs.lstatSync(src);
    } catch {
      throw importSourceError(src);
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw importSourceError(src);
    }
    try {
      fs.accessSync(src, fs.constants.R_OK);
    } catch {
      throw importSourceError(src);
    }
    if (!Number.isSafeInteger(sourceStat.size) || sourceStat.size < 0) {
      throw importSourceError(src);
    }
    if (sourceStat.size > IMPORT_LIMITS.maxFileBytes) {
      throw new Error(
        `Import source exceeds the ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MiB file limit: ${src}`
      );
    }

    totalBytes += sourceStat.size;
    if (totalBytes > IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(
        `Import batch exceeds the ${IMPORT_LIMITS.maxTotalBytes / 1024 / 1024} MiB total limit`
      );
    }
  }
}

export function importFiles(matterId: string, filePaths: string[]): string[] {
  // Never follow a matter/documents junction or create a tree for an unknown matter.
  const trustedMatter = assertTrustedMatterDirectory(matterId);
  if (!readTrustedMatter(trustedMatter, matterId)) throw new Error("Matter not found");
  preflightImportSources(filePaths);
  const destDir = trustedDocumentsDirectory(trustedMatter, true);
  const claimed = new Set<string>();
  const copied: string[] = [];
  const rollbackTargets: string[] = [];
  try {
    for (const src of filePaths) {
      let copiedName = "";
      while (!copiedName) {
        const destName = uniqueDestName(destDir, path.basename(src), claimed);
        const dest = path.join(destDir, destName);
        try {
          // The destination is claimed atomically. Concurrent imports retry with
          // the next suffix instead of overwriting or rolling back another batch.
          fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
          assertImportedRegularFile(destDir, dest);
          rollbackTargets.push(dest);
          copiedName = destName;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          // A non-EEXIST copy failure may have left a partial destination. It
          // belongs to this exclusive attempt and must be included in rollback.
          rollbackTargets.push(dest);
          throw err;
        }
      }
      copied.push(copiedName);
    }
  } catch (err) {
    // A multi-file import is one operation. Restore the original source set or
    // explicitly report that a rebuild is required; never guess that rollback
    // succeeded after a partial copy or cleanup failure.
    let rollbackVerified = true;
    try {
      const rollbackDir = assertTrustedDocumentsDirectory(matterId);
      if (rollbackDir !== destDir) rollbackVerified = false;
    } catch {
      rollbackVerified = false;
    }
    if (rollbackVerified) {
      for (const destination of [...new Set(rollbackTargets)].reverse()) {
        try {
          const stat = fs.lstatSync(destination);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            rollbackVerified = false;
            continue;
          }
          fs.unlinkSync(destination);
        } catch (cleanupErr) {
          if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
            rollbackVerified = false;
          }
        }
        if (fs.existsSync(destination)) rollbackVerified = false;
      }
    }
    if (!rollbackVerified) {
      throw new ImportRollbackUncertainError(
        "Import failed and its destination cleanup could not be verified. Reindex the case record before practicing.",
        { cause: err }
      );
    }
    throw err;
  }

  // The copies are complete and durable. The matter timestamp is cosmetic
  // maintenance — a locked matter.json or transient metadata failure here must
  // never trigger the rollback path and destroy a finished import. The durable
  // index-invalidation marker committed by the caller already forces a reindex.
  try {
    const finalTrustedMatter = assertTrustedMatterDirectory(matterId);
    touchTrustedMatter(finalTrustedMatter, matterId);
  } catch (err) {
    console.warn(
      `[matters] Import completed for ${matterId} but the matter timestamp update failed`,
      err
    );
  }
  return copied;
}

/**
 * Delete a document under the matter's documents/ tree by relative path
 * (as stored on DocumentMeta.relativePath). Path escape is rejected.
 */
export function deleteDocument(matterId: string, relativePath: string): { deleted: string } {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("Document path is required");
  }
  // Normalize separators; reject absolute / parent segments up front
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((p) => p === ".." || p === "")) {
    throw new Error("Invalid document path");
  }

  const trustedMatter = assertTrustedMatterDirectory(matterId);
  const docsRoot = trustedDocumentsDirectory(trustedMatter, false);
  const resolved = path.resolve(docsRoot, normalized);
  const rel = path.relative(docsRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Document path is outside the matter documents folder");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Document not found: ${normalized}`);
  }

  const targetStat = fs.lstatSync(resolved);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error("Document is not a regular file");
  }

  const realRoot = fs.realpathSync.native(docsRoot);
  const realTarget = fs.realpathSync.native(resolved);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
    throw new Error("Document path resolves outside the matter documents folder");
  }

  // Complete fallible metadata maintenance before the irreversible unlink so
  // callers can truthfully distinguish a rejected delete from a committed one.
  const finalTrustedMatter = assertTrustedMatterDirectory(matterId);
  touchTrustedMatter(finalTrustedMatter, matterId);
  fs.unlinkSync(resolved);
  return { deleted: rel.replace(/\\/g, "/") };
}
