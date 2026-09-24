import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AdvocacyEvidence,
  AdvocacyEthicalFinding,
  AdvocacySkillAssessment,
  AdvocacySkillRating,
  ExamMode,
  Matter,
  Persona,
  SessionRecord,
  SessionReport,
  TranscriptLine,
} from "../types.js";
import {
  allAdvocacySkillIds,
  buildAdvocacyAnalysis,
  formatAdvocacyDiagnosticsForPrompt,
} from "./advocacy.js";
import { sessionsDir } from "../paths.js";
import { publicErrorMessage, writeFileAtomic, writeJson } from "./fsutil.js";
import {
  assertTrustedSessionsDirectory,
  findTrustedSessionsDirectory,
  getMatter,
  listPersonas,
} from "./matters.js";
import { reportSystemPrompt } from "./prompts.js";
import { loadSettings } from "./settings.js";

const REPORT_MODEL = "grok-4.7";
const REPORT_TIMEOUT_MS = 120_000;

/** Keep remote report work bounded so bursts cannot exhaust sockets or memory. */
export const REPORT_GENERATION_LIMITS = Object.freeze({
  maxConcurrent: 2,
  maxQueued: 24,
});

/** Hard resource ceilings for untrusted disk and remote model data. */
export const REPORT_LIMITS = Object.freeze({
  maxSessionJsonBytes: 16 * 1024 * 1024,
  maxReportJsonBytes: 2 * 1024 * 1024,
  maxTranscriptLines: 20_000,
  maxTranscriptLineChars: 200_000,
  maxTranscriptTotalChars: 8_000_000,
  maxTimestampChars: 100,
  maxReportSummaryChars: 50_000,
  maxReportListItems: 100,
  maxReportItemChars: 2_000,
  maxScorecardFieldChars: 10_000,
  maxSkillAssessments: 24,
  maxSkillEvidenceItems: 6,
  maxAdvocacyTextChars: 4_000,
  maxEvidenceExcerptChars: 600,
  maxEthicalFlags: 20,
  maxReportPromptChars: 250_000,
  maxSuccessResponseBytes: 2 * 1024 * 1024,
  maxErrorResponseBytes: 8 * 1024,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionListItem = {
  id: string;
  personaId: string;
  mode: ExamMode;
  startedAt: string;
  endedAt?: string;
  /** True for a crash-recovery checkpoint that never reached normal finalization. */
  unfinished: boolean;
  lineCount: number;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
};

export type ListSessionsResult = {
  sessions: SessionListItem[];
  /** Saved records that could not be trusted, including available recovery copies. */
  dataErrors: string[];
};

export type SessionArtifactKind = "transcript" | "report";

export type RestoreSessionResult = {
  ok: boolean;
  error?: string;
  restoredFrom?: string;
};

export type SessionReview = {
  session: Omit<SessionRecord, "reportPath">;
  /** Derived from missing endedAt so older and checkpoint records behave uniformly. */
  unfinished: boolean;
  report: SessionReport | null;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
  dataErrors: string[];
};

export type GeneratedSessionReportResult = {
  session: Readonly<Pick<SessionRecord, "id" | "matterId">>;
  report: SessionReport;
  canOpenReport: boolean;
  /** Report-only diagnostics; the renderer preserves existing transcript warnings. */
  reportDataErrors: string[];
};

type TranscriptNormalization = {
  lines: TranscriptLine[];
  adjusted: boolean;
};

type SessionReadResult = {
  session: SessionRecord;
  transcriptAdjusted: boolean;
};

/** Keep main-process filesystem capabilities out of renderer-facing records. */
function toPublicSession(session: SessionRecord): Omit<SessionRecord, "reportPath"> {
  const publicSession = { ...session };
  delete publicSession.reportPath;
  return publicSession;
}

function coerceScalarString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** Keep damaged or oversized optional rows from exhausting review/report memory. */
function normalizeTranscript(raw: unknown, fallbackAt = ""): TranscriptNormalization {
  if (!Array.isArray(raw)) return { lines: [], adjusted: true };
  const lines: TranscriptLine[] = [];
  let adjusted = false;
  let totalChars = 0;
  for (const item of raw) {
    if (lines.length >= REPORT_LIMITS.maxTranscriptLines) {
      adjusted = true;
      break;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      adjusted = true;
      continue;
    }
    const row = item as Record<string, unknown>;
    const rawText = coerceScalarString(row.text).trim();
    if (!rawText) {
      adjusted = true;
      continue;
    }
    if (typeof row.text !== "string") adjusted = true;

    const remaining = REPORT_LIMITS.maxTranscriptTotalChars - totalChars;
    if (remaining <= 0) {
      adjusted = true;
      break;
    }
    const allowed = Math.min(REPORT_LIMITS.maxTranscriptLineChars, remaining);
    const text = rawText.slice(0, allowed);
    if (text.length !== rawText.length) adjusted = true;

    const role =
      row.role === "user" || row.role === "assistant" || row.role === "system"
        ? row.role
        : "system";
    if (role !== row.role) adjusted = true;
    const rawAt = coerceScalarString(row.at, fallbackAt);
    const at = rawAt.slice(0, REPORT_LIMITS.maxTimestampChars);
    if (at.length !== rawAt.length || typeof row.at !== "string") adjusted = true;
    lines.push({ role, text, at });
    totalChars += text.length;
  }
  return { lines, adjusted };
}

/** Public compatibility helper used by review/UI tests. */
export function normalizeTranscriptLines(raw: unknown, fallbackAt = ""): TranscriptLine[] {
  return normalizeTranscript(raw, fallbackAt).lines;
}

const EXAM_MODES = new Set<ExamMode>(["cross", "deposition", "hearing"]);

/**
 * Treat saved session metadata as untrusted disk input. Transcript rows are
 * normalized separately so one damaged optional row does not hide the record.
 */
function validateSessionRecord(
  raw: unknown,
  matterId: string,
  sessionId: string
): SessionReadResult {
  if (!UUID_RE.test(matterId)) throw new Error("Invalid matter id");
  if (!UUID_RE.test(sessionId)) throw new Error("Invalid session id");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("session JSON is not an object");
  }

  const row = raw as Record<string, unknown>;
  if (row.id !== sessionId) throw new Error(`contains mismatched id ${String(row.id)}`);
  if (row.matterId !== matterId) {
    throw new Error(`belongs to a different matter (${String(row.matterId)})`);
  }
  if (typeof row.personaId !== "string" || !UUID_RE.test(row.personaId)) {
    throw new Error("has an invalid personaId");
  }
  if (typeof row.mode !== "string" || !EXAM_MODES.has(row.mode as ExamMode)) {
    throw new Error(`has an invalid mode (${String(row.mode)})`);
  }
  if (typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt))) {
    throw new Error("has an invalid startedAt timestamp");
  }
  if (
    row.endedAt !== undefined &&
    (typeof row.endedAt !== "string" || !Number.isFinite(Date.parse(row.endedAt)))
  ) {
    throw new Error("has an invalid endedAt timestamp");
  }
  if (
    typeof row.endedAt === "string" &&
    Date.parse(row.endedAt) < Date.parse(row.startedAt)
  ) {
    throw new Error("ends before it starts");
  }

  const transcript = normalizeTranscript(row.transcript, row.startedAt as string);
  const session: SessionRecord = {
    id: sessionId,
    matterId,
    personaId: row.personaId as string,
    mode: row.mode as ExamMode,
    startedAt: row.startedAt as string,
    transcript: transcript.lines,
  };
  if (typeof row.personaName === "string") {
    const personaName = row.personaName.trim().slice(0, 200);
    if (personaName) session.personaName = personaName;
  }
  if (typeof row.endedAt === "string") session.endedAt = row.endedAt;
  if (typeof row.reportPath === "string" && row.reportPath.length <= 4_096) {
    session.reportPath = row.reportPath;
  }
  return { session, transcriptAdjusted: transcript.adjusted };
}

function isPathOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Session files are untrusted disk input. Reject links/devices/directories and
 * verify the canonical leaf remains beneath the already-trusted session root.
 */
function trustedRegularSessionFile(dir: string, file: string, label: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(file);
  if (resolvedDir === resolvedFile || isPathOutside(resolvedDir, resolvedFile)) {
    throw new Error(`${label} is outside the session directory`);
  }

  const stat = fs.lstatSync(resolvedFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }

  const realDir = fs.realpathSync.native(resolvedDir);
  const realFile = fs.realpathSync.native(resolvedFile);
  if (realDir === realFile || isPathOutside(realDir, realFile)) {
    throw new Error(`${label} resolves outside the session directory`);
  }
  // Return the lexical leaf. Native realpath expands Windows 8.3 names
  // (`RUNNER~1` → `runneradmin`) and would make persisted paths disagree with
  // the workspace root even when the file never left the directory.
  return resolvedFile;
}

/**
 * `assertTrustedSessionsDirectory` returns the native real path so junction
 * checks stay canonical. File operations use the workspace spelling of that
 * same directory; on Windows those strings are not `path.resolve`-equal.
 */
function lexicalSessionsDirectory(matterId: string, canonicalDir: string): string {
  const lexical = path.resolve(sessionsDir(matterId));
  if (fs.realpathSync.native(lexical) !== fs.realpathSync.native(canonicalDir)) {
    throw new Error("Matter sessions folder resolves outside the matter directory");
  }
  return lexical;
}

function sessionDirectory(matterId: string, create: boolean): string {
  return lexicalSessionsDirectory(
    matterId,
    assertTrustedSessionsDirectory(matterId, create)
  );
}

function findSessionDirectory(matterId: string): string | null {
  const canonical = findTrustedSessionsDirectory(matterId);
  if (!canonical) return null;
  return lexicalSessionsDirectory(matterId, canonical);
}

function sameRealDirectory(left: string, right: string): boolean {
  return fs.realpathSync.native(left) === fs.realpathSync.native(right);
}

function optionalTrustedRegularSessionFile(
  dir: string,
  file: string,
  label: string
): string | null {
  try {
    fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return trustedRegularSessionFile(dir, file, label);
}

function readUtf8Bounded(file: string, maxBytes: number, label: string): string {
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readStoredJson(
  file: string,
  maxBytes: number,
  label: string,
  preserveMalformed: boolean
): unknown {
  const raw = readUtf8Bounded(file, maxBytes, label);
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (!preserveMalformed) throw err;

    const corrupt = nextCorruptPath(file);
    let preserved = false;
    try {
      fs.renameSync(file, corrupt);
      preserved = true;
      console.error(`[report] Corrupt JSON preserved as ${corrupt}`, err);
    } catch (renameErr) {
      console.error(`[report] Corrupt JSON at ${file}; rename failed`, err, renameErr);
    }
    throw new Error(
      `Corrupt data file ${path.basename(file)}${
        preserved
          ? ` (preserved as ${path.basename(corrupt)})`
          : " (could not be moved; original left in place)"
      }: ${String(err)}`
    );
  }
}

function readSessionFile(
  file: string,
  dir: string,
  matterId: string,
  sessionId: string,
  preserveMalformed = false
): SessionReadResult {
  const trustedFile = trustedRegularSessionFile(dir, file, "Session JSON");
  const raw = readStoredJson(
    trustedFile,
    REPORT_LIMITS.maxSessionJsonBytes,
    "Session JSON",
    preserveMalformed
  );
  return validateSessionRecord(raw, matterId, sessionId);
}

function recoveryCandidates(dir: string, sessionId: string): string[] {
  const live = path.join(dir, `${sessionId}.json`);
  const candidates: string[] = [];
  const backup = `${live}.bak`;
  try {
    fs.lstatSync(backup);
    candidates.push(backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const corruptPattern = new RegExp(
    `^${sessionId}\\.json\\.corrupt-\\d+(?:-\\d+)?$`,
    "i"
  );
  const corrupt = fs
    .readdirSync(dir)
    .filter((name) => corruptPattern.test(name))
    .sort((a, b) => b.localeCompare(a));
  candidates.push(...corrupt.map((name) => path.join(dir, name)));
  return candidates;
}

function recoveryDescription(dir: string, sessionId: string): string {
  try {
    const names = recoveryCandidates(dir, sessionId).map((candidate) => path.basename(candidate));
    return names.length
      ? `Recovery candidates: ${names.join(", ")}.`
      : "No .bak or .corrupt-* recovery candidate is available.";
  } catch (err) {
    return `Recovery candidates could not be inspected: ${publicErrorMessage(err)}.`;
  }
}

function discoverSessionIds(dir: string, knownNames?: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const ids = new Set<string>();
  for (const name of knownNames ?? fs.readdirSync(dir)) {
    const match = name.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json(?:\.bak|\.corrupt-\d+(?:-\d+)?)?$/i
    );
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}

/** Summaries of past exams for the matter workspace (newest first). */
export function listSessions(matterId: string): ListSessionsResult {
  const dir = findSessionDirectory(matterId);
  if (!dir) return { sessions: [], dataErrors: [] };

  const items: SessionListItem[] = [];
  let directoryNames: string[];
  try {
    directoryNames = fs.readdirSync(dir);
  } catch (err) {
    return {
      sessions: [],
      dataErrors: [`Saved sessions could not be inspected: ${publicErrorMessage(err)}`],
    };
  }
  const hasDeletionTransactions = directoryNames.some((name) =>
    DELETE_TRANSACTION_RE.test(name)
  );
  const dataErrors = hasDeletionTransactions
    ? maintainDeletionTransactions(matterId, dir, directoryNames).map(
        (issue) => issue.message
      )
    : [];
  let sessionIds: string[];
  try {
    // A pending transaction may have restored the live JSON, so refresh only
    // when transaction maintenance actually ran. The common list path keeps a
    // single directory enumeration.
    if (hasDeletionTransactions) directoryNames = fs.readdirSync(dir);
    sessionIds = discoverSessionIds(dir, directoryNames);
  } catch (err) {
    return {
      sessions: [],
      dataErrors: [`Saved sessions could not be inspected: ${publicErrorMessage(err)}`],
    };
  }

  for (const id of sessionIds) {
    const file = path.join(dir, `${id}.json`);
    let trustedLive: string | null;
    try {
      trustedLive = optionalTrustedRegularSessionFile(dir, file, "Session JSON");
    } catch (err) {
      dataErrors.push(
        `Session ${id}: ${publicErrorMessage(err)}. ${recoveryDescription(dir, id)} Use Restore to recover it.`
      );
      continue;
    }
    if (!trustedLive) {
      dataErrors.push(
        `Session ${id}: saved session JSON is missing. ${recoveryDescription(dir, id)} Use Restore to recover it.`
      );
      continue;
    }
    try {
      // Malformed JSON is preserved as .corrupt-* before throwing.
      const read = readSessionFile(trustedLive, dir, matterId, id, true);
      const session = read.session;
      if (read.transcriptAdjusted) {
        dataErrors.push(
          `Session ${id}: malformed or oversized transcript rows were omitted or capped.`
        );
      }
      const transcriptPath = path.join(dir, `${id}-transcript.md`);
      const reportMarkdownPath = path.join(dir, `${id}-report.md`);
      let trustedTranscript: string | null = null;
      let trustedReportMarkdown: string | null = null;
      try {
        trustedTranscript = optionalTrustedRegularSessionFile(
          dir,
          transcriptPath,
          "Session transcript"
        );
      } catch (err) {
        dataErrors.push(
          `Session ${id}: saved transcript artifact was unsafe and was not exposed: ${publicErrorMessage(err)}`
        );
      }
      try {
        trustedReportMarkdown = optionalTrustedRegularSessionFile(
          dir,
          reportMarkdownPath,
          "Session report Markdown"
        );
      } catch (err) {
        dataErrors.push(
          `Session ${id}: saved report artifact was unsafe and was not exposed: ${publicErrorMessage(err)}`
        );
      }
      items.push({
        id,
        personaId: session.personaId,
        mode: session.mode,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        unfinished: !session.endedAt,
        lineCount: session.transcript.length,
        canOpenTranscript: trustedTranscript !== null,
        canOpenReport: trustedReportMarkdown !== null,
      });
    } catch (err) {
      dataErrors.push(
        `Session ${id}: ${publicErrorMessage(err)}. ${recoveryDescription(dir, id)} Use Restore to recover it.`
      );
    }
  }

  items.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return { sessions: items, dataErrors };
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

/**
 * Restore a missing/corrupt live session from a validated backup. The candidate
 * is parsed and ownership-checked before the current file is moved or replaced.
 */
export function restoreSession(matterId: string, sessionId: string): RestoreSessionResult {
  if (!UUID_RE.test(matterId)) return { ok: false, error: "Invalid matter id" };
  if (!UUID_RE.test(sessionId)) return { ok: false, error: "Invalid session id" };

  let dir: string | null;
  try {
    dir = findSessionDirectory(matterId);
  } catch (err) {
    return { ok: false, error: publicErrorMessage(err) };
  }
  if (!dir) {
    return {
      ok: false,
      error: "No .bak or .corrupt-* recovery candidate found for this session.",
    };
  }

  const live = path.join(dir, `${sessionId}.json`);
  const failures: string[] = [];
  let trustedLive: string | null;
  try {
    trustedLive = optionalTrustedRegularSessionFile(dir, live, "Session JSON");
  } catch (err) {
    return { ok: false, error: publicErrorMessage(err) };
  }

  if (trustedLive) {
    try {
      readSessionFile(trustedLive, dir, matterId, sessionId);
      return { ok: false, error: "The live session record is valid; restore is not needed." };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code) {
        return {
          ok: false,
          error: `Could not read the live session record; it was not modified: ${publicErrorMessage(err)}`,
        };
      }
      // A candidate is validated below before this damaged file is moved.
    }
  }

  let candidates: string[];
  try {
    candidates = recoveryCandidates(dir, sessionId);
  } catch (err) {
    return {
      ok: false,
      error: `Could not inspect session recovery candidates: ${publicErrorMessage(err)}`,
    };
  }

  for (const source of candidates) {
    let session: SessionRecord;
    try {
      session = normalizeRuntimeSession(readSessionFile(source, dir, matterId, sessionId).session);
    } catch (err) {
      failures.push(`${path.basename(source)}: ${publicErrorMessage(err)}`);
      continue;
    }

    const tmp = `${live}.restore-tmp-${process.pid}-${randomUUID()}`;
    const preserved = trustedLive ? nextCorruptPath(live) : null;
    let movedLive = false;
    let fd: number | null = null;
    let tempCreated = false;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      tempCreated = true;
      fs.writeFileSync(fd, JSON.stringify(session, null, 2), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      const currentDir = assertTrustedSessionsDirectory(matterId, false);
      if (!sameRealDirectory(currentDir, dir)) {
        throw new Error("Session directory changed during restore");
      }
      if (preserved) {
        // Revalidate the live leaf immediately before moving it. A link swapped
        // in during candidate validation must never become a restore input.
        const currentLive = trustedRegularSessionFile(dir, live, "Session JSON");
        fs.renameSync(currentLive, preserved);
        movedLive = true;
      } else if (optionalTrustedRegularSessionFile(dir, live, "Session JSON")) {
        throw new Error("A live session record appeared during restore");
      }
      fs.renameSync(tmp, live);
      return {
        ok: true,
        restoredFrom: path.basename(source),
      };
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* preserve the original restore failure */
        }
      }
      try {
        if (tempCreated && fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
      if (movedLive && preserved && !fs.existsSync(live)) {
        try {
          fs.renameSync(preserved, live);
        } catch (rollbackErr) {
          return {
            ok: false,
            error: `Restore failed and the damaged live record remains at ${path.basename(preserved)}: ${publicErrorMessage(err)}; rollback failed: ${publicErrorMessage(rollbackErr)}`,
          };
        }
      }
      return { ok: false, error: `Could not restore session: ${publicErrorMessage(err)}` };
    }
  }

  return {
    ok: false,
    error: failures.length
      ? `No valid session recovery candidate found. ${failures.join(" ")}`
      : "No .bak or .corrupt-* recovery candidate found for this session.",
  };
}

/**
 * Resolve only app-generated Markdown artifacts. The renderer supplies identity,
 * never a filesystem path, and every filesystem hop is revalidated in main.
 */
export function resolveSessionArtifact(
  matterId: string,
  sessionId: string,
  kind: SessionArtifactKind
): string {
  if (!UUID_RE.test(matterId)) throw new Error("Invalid matter id");
  if (!UUID_RE.test(sessionId)) throw new Error("Invalid session id");
  if (kind !== "transcript" && kind !== "report") throw new Error("Invalid session artifact");

  const dir = sessionDirectory(matterId, false);
  const sessionPath = path.join(dir, `${sessionId}.json`);
  const trustedSession = optionalTrustedRegularSessionFile(
    dir,
    sessionPath,
    "Session JSON"
  );
  if (!trustedSession) throw new Error("Session not found");
  readSessionFile(trustedSession, dir, matterId, sessionId);

  const artifact = path.join(
    dir,
    kind === "transcript" ? `${sessionId}-transcript.md` : `${sessionId}-report.md`
  );
  const trustedArtifact = optionalTrustedRegularSessionFile(
    dir,
    artifact,
    "Session artifact"
  );
  if (!trustedArtifact) throw new Error("Session artifact not found");
  return fs.realpathSync.native(trustedArtifact);
}

/** Load one saved exam for the in-app review workspace. */
export function getSessionReview(matterId: string, sessionId: string): SessionReview {
  if (!UUID_RE.test(sessionId)) throw new Error("Invalid session id");

  const dir = sessionDirectory(matterId, false);
  const sessionPath = path.join(dir, `${sessionId}.json`);
  const trustedSession = optionalTrustedRegularSessionFile(
    dir,
    sessionPath,
    "Session JSON"
  );
  if (!trustedSession) throw new Error("Session not found");
  const read = readSessionFile(trustedSession, dir, matterId, sessionId, true);
  const session = read.session;
  const dataErrors: string[] = [];
  if (read.transcriptAdjusted) {
    dataErrors.push(
      "Some malformed or oversized transcript lines were omitted or capped in this review."
    );
  }

  const reportPath = path.join(dir, `${sessionId}-report.json`);
  const transcriptPath = path.join(dir, `${sessionId}-transcript.md`);
  const reportMarkdownPath = path.join(dir, `${sessionId}-report.md`);
  let storedReport: SessionReport | null = null;
  try {
    const trustedReport = optionalTrustedRegularSessionFile(
      dir,
      reportPath,
      "Session report JSON"
    );
    if (trustedReport) {
      const rawReport = readStoredJson(
        trustedReport,
        REPORT_LIMITS.maxReportJsonBytes,
        "Session report JSON",
        true
      );
      storedReport = rawReport && typeof rawReport === "object" && !Array.isArray(rawReport)
        ? (rawReport as SessionReport)
        : null;
    }
  } catch (err) {
    // The report is optional. Malformed JSON is preserved; unsafe or oversized
    // filesystem objects are rejected without touching their targets.
    console.error(`[report] Could not load report for session ${sessionId}`, err);
    dataErrors.push(
      "The saved performance report was unreadable or unsafe and was not used. The transcript is still available."
    );
  }
  if (storedReport && storedReport.sessionId !== sessionId) {
    dataErrors.push(
      "The saved performance report belongs to a different session and was not used."
    );
  }
  const normalized = storedReport?.sessionId === sessionId
    ? normalizeReportPayload(storedReport, {
        mode: session.mode,
        transcript: session.transcript,
        allowLegacyUnreferencedEvidence: true,
      })
    : null;
  const report = normalized && storedReport
    ? {
        sessionId,
        matterCaption: asString(storedReport.matterCaption),
        personaName: asString(storedReport.personaName),
        mode: session.mode,
        generatedAt: asString(storedReport.generatedAt),
        summary: normalized.summary ?? "",
        admissions: normalized.admissions ?? [],
        hedges: normalized.hedges ?? [],
        inconsistencies: normalized.inconsistencies ?? [],
        missedFollowUps: normalized.missedFollowUps ?? [],
        scorecard: normalized.scorecard ?? asScorecard(null),
        advocacy:
          normalized.advocacy ??
          buildAdvocacyAnalysis(session.mode, session.transcript, [], []),
      }
    : null;

  let trustedTranscript: string | null = null;
  let trustedReportMarkdown: string | null = null;
  try {
    trustedTranscript = optionalTrustedRegularSessionFile(
      dir,
      transcriptPath,
      "Session transcript"
    );
  } catch {
    dataErrors.push("The saved transcript artifact was unsafe and was not exposed.");
  }
  try {
    trustedReportMarkdown = optionalTrustedRegularSessionFile(
      dir,
      reportMarkdownPath,
      "Session report Markdown"
    );
  } catch {
    dataErrors.push("The saved report artifact was unsafe and was not exposed.");
  }

  return {
    session: toPublicSession(session),
    unfinished: !session.endedAt,
    report,
    canOpenTranscript: trustedTranscript !== null,
    canOpenReport: trustedReportMarkdown !== null,
    dataErrors,
  };
}

function normalizeRuntimeSession(session: SessionRecord): SessionRecord {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("Invalid session record");
  }
  const row = session as unknown as Record<string, unknown>;
  const matterId = typeof row.matterId === "string" ? row.matterId : "";
  const sessionId = typeof row.id === "string" ? row.id : "";
  const normalized = validateSessionRecord(session, matterId, sessionId).session;
  if (
    Buffer.byteLength(JSON.stringify(normalized, null, 2), "utf8") >
    REPORT_LIMITS.maxSessionJsonBytes
  ) {
    throw new Error(
      `Session JSON exceeds the ${REPORT_LIMITS.maxSessionJsonBytes}-byte safety limit`
    );
  }
  return normalized;
}

type TrustedReportContext = {
  session: SessionRecord;
  matter: Matter;
  persona: Persona;
};

/** Resolve caller-supplied identities back to the canonical matter workspace. */
function trustedReportContext(
  session: SessionRecord,
  matter: Matter,
  persona: Persona
): TrustedReportContext {
  const normalizedSession = normalizeRuntimeSession(session);
  if (
    !matter ||
    typeof matter !== "object" ||
    typeof matter.id !== "string" ||
    !UUID_RE.test(matter.id)
  ) {
    throw new Error("Invalid matter id");
  }
  if (matter.id !== normalizedSession.matterId) {
    throw new Error("Session belongs to a different matter");
  }
  if (
    !persona ||
    typeof persona !== "object" ||
    typeof persona.id !== "string" ||
    !UUID_RE.test(persona.id)
  ) {
    throw new Error("Invalid persona id");
  }
  if (
    persona.id !== normalizedSession.personaId ||
    persona.matterId !== normalizedSession.matterId
  ) {
    throw new Error("Session belongs to a different persona");
  }

  const currentMatter = getMatter(normalizedSession.matterId);
  if (!currentMatter || currentMatter.id !== normalizedSession.matterId) {
    throw new Error("Matter not found");
  }
  const currentPersona = listPersonas(normalizedSession.matterId).find(
    (candidate) =>
      candidate.id === normalizedSession.personaId &&
      candidate.matterId === normalizedSession.matterId
  );
  if (!currentPersona) {
    throw new Error("Persona does not belong to this matter");
  }
  return { session: normalizedSession, matter: currentMatter, persona: currentPersona };
}

export function saveSession(session: SessionRecord): string {
  const normalized = normalizeRuntimeSession(session);
  const dir = sessionDirectory(normalized.matterId, true);
  const file = path.join(dir, `${normalized.id}.json`);
  writeJson(file, normalized, {
    maxBytes: REPORT_LIMITS.maxSessionJsonBytes,
    label: "Session JSON",
  });
  return file;
}

export function writeTranscriptMarkdown(session: SessionRecord, matter: Matter, persona: Persona): string {
  const trusted = trustedReportContext(session, matter, persona);
  session = trusted.session;
  matter = trusted.matter;
  persona = trusted.persona;
  const dir = sessionDirectory(session.matterId, true);
  const file = path.join(dir, `${session.id}-transcript.md`);
  const isHearing = session.mode === "hearing";
  const lines = [
    `# Mock ${isHearing ? "hearing" : "exam"} transcript`,
    ``,
    `> AI-generated trial-preparation simulation — verify against the source record`,
    ``,
    `- **Matter:** ${matter.caption}`,
    `- **${isHearing ? "Court" : "Person"}:** ${persona.fullName} (${persona.role})`,
    `- **Mode:** ${session.mode}`,
    `- **Started:** ${session.startedAt}`,
    `- **Ended:** ${session.endedAt ?? ""}`,
    ``,
    `---`,
    ``,
  ];
  for (const t of session.transcript) {
    const who =
      t.role === "user"
        ? "Counsel"
        : t.role === "assistant"
          ? isHearing
            ? `Court (${persona.fullName})`
            : persona.fullName
          : "System";
    lines.push(`**${who}:** ${t.text}`, ``);
  }
  writeFileAtomic(file, lines.join("\n"));
  return file;
}

function asString(
  value: unknown,
  fallback = "",
  maxChars: number = REPORT_LIMITS.maxReportItemChars
): string {
  const scalar = coerceScalarString(value, fallback);
  return scalar.slice(0, maxChars);
}

function asStringArray(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .slice(0, REPORT_LIMITS.maxReportListItems)
    .map((item) => asString(item).trim())
    .filter(Boolean);
}

function asScorecard(value: unknown): SessionReport["scorecard"] {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    control: asString(o.control, "", REPORT_LIMITS.maxScorecardFieldChars),
    oneFactQuestions: asString(
      o.oneFactQuestions,
      "",
      REPORT_LIMITS.maxScorecardFieldChars
    ),
    impeachment: asString(o.impeachment, "", REPORT_LIMITS.maxScorecardFieldChars),
    form: asString(o.form, "", REPORT_LIMITS.maxScorecardFieldChars),
    notes: asString(o.notes, "", REPORT_LIMITS.maxScorecardFieldChars),
  };
}

const ADVOCACY_RATINGS = new Set<AdvocacySkillRating>([
  "strong",
  "developing",
  "needs-work",
  "not-observed",
]);

function asAdvocacyRating(value: unknown): AdvocacySkillRating {
  return typeof value === "string" && ADVOCACY_RATINGS.has(value as AdvocacySkillRating)
    ? (value as AdvocacySkillRating)
    : "not-observed";
}

type ReportNormalizationContext = {
  mode: ExamMode;
  transcript: TranscriptLine[];
  /** New model output may cite only lines actually included in its bounded prompt. */
  allowedEvidenceLines?: ReadonlySet<number>;
  /** Preserve pre-2026.2 string evidence when reading an existing saved report. */
  allowLegacyUnreferencedEvidence?: boolean;
};

function speechLineNumbers(transcript: TranscriptLine[]): Set<number> {
  const result = new Set<number>();
  transcript.forEach((line, index) => {
    if (line.role === "user" || line.role === "assistant") result.add(index + 1);
  });
  return result;
}

function trustedEvidenceExcerpt(transcript: TranscriptLine[], lineNumber: number): string {
  const line = transcript[lineNumber - 1];
  if (!line || (line.role !== "user" && line.role !== "assistant")) return "";
  return asString(line.text, "", REPORT_LIMITS.maxEvidenceExcerptChars).trim();
}

function asEvidenceLine(value: unknown, allowed: ReadonlySet<number>): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && allowed.has(value)
    ? value
    : null;
}

function asAdvocacyEvidence(
  value: unknown,
  context: ReportNormalizationContext
): AdvocacyEvidence[] {
  const items = Array.isArray(value) ? value : [value];
  const allowed = context.allowedEvidenceLines ?? speechLineNumbers(context.transcript);
  const result: AdvocacyEvidence[] = [];
  for (const raw of items.slice(0, REPORT_LIMITS.maxSkillEvidenceItems)) {
    if (typeof raw === "string" && context.allowLegacyUnreferencedEvidence) {
      const observation = asString(raw, "", REPORT_LIMITS.maxAdvocacyTextChars).trim();
      if (observation) result.push({ line: null, observation, excerpt: "" });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const line = asEvidenceLine(item.line, allowed);
    const observation = asString(
      item.observation,
      "",
      REPORT_LIMITS.maxAdvocacyTextChars
    ).trim();
    if (line === null || !observation) continue;
    result.push({
      line,
      observation,
      excerpt: trustedEvidenceExcerpt(context.transcript, line),
    });
  }
  return result;
}

function asEthicalFindings(
  value: unknown,
  context: ReportNormalizationContext
): AdvocacyEthicalFinding[] {
  const items = Array.isArray(value) ? value : [value];
  const allowed = context.allowedEvidenceLines ?? speechLineNumbers(context.transcript);
  const result: AdvocacyEthicalFinding[] = [];
  for (const raw of items.slice(0, REPORT_LIMITS.maxEthicalFlags)) {
    if (typeof raw === "string" && context.allowLegacyUnreferencedEvidence) {
      const concern = asString(raw, "", REPORT_LIMITS.maxAdvocacyTextChars).trim();
      if (concern) result.push({ line: null, concern, excerpt: "" });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const line = asEvidenceLine(item.line, allowed);
    const concern = asString(
      item.concern,
      "",
      REPORT_LIMITS.maxAdvocacyTextChars
    ).trim();
    if (line === null || !concern) continue;
    result.push({
      line,
      concern,
      excerpt: trustedEvidenceExcerpt(context.transcript, line),
    });
  }
  return result;
}

function asAdvocacyAnalysis(
  value: unknown,
  context: ReportNormalizationContext
): SessionReport["advocacy"] {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const rawAssessments = Array.isArray(source.skillAssessments)
    ? source.skillAssessments
    : Array.isArray(source.skills)
      ? source.skills
      : [];
  const allowedIds = allAdvocacySkillIds();
  const seen = new Set<string>();
  const assessments: Omit<AdvocacySkillAssessment, "label">[] = [];
  for (const row of rawAssessments.slice(0, REPORT_LIMITS.maxSkillAssessments)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const skillId = asString(item.skillId, "", 100).trim();
    if (!allowedIds.has(skillId) || seen.has(skillId)) continue;
    seen.add(skillId);
    const requestedRating = asAdvocacyRating(item.rating);
    const evidence = requestedRating === "not-observed"
      ? []
      : asAdvocacyEvidence(item.evidence, context);
    const rating = requestedRating !== "not-observed" && !evidence.length
      ? "not-observed"
      : requestedRating;
    const grounded = requestedRating === "not-observed" || evidence.length > 0;
    assessments.push({
      skillId,
      rating,
      evidence,
      coaching: grounded
        ? asString(item.coaching, "", REPORT_LIMITS.maxAdvocacyTextChars).trim()
        : "",
      drill: grounded
        ? asString(item.drill, "", REPORT_LIMITS.maxAdvocacyTextChars).trim()
        : "",
    });
  }
  const ethicalFlags = asEthicalFindings(source.ethicalFlags, context);
  return buildAdvocacyAnalysis(context.mode, context.transcript, assessments, ethicalFlags);
}

/** Normalize model JSON into a safe SessionReport-shaped partial. */
export function normalizeReportPayload(
  raw: unknown,
  context: ReportNormalizationContext = {
    mode: "cross",
    transcript: [],
  }
): Partial<SessionReport> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    summary: asString(o.summary, "", REPORT_LIMITS.maxReportSummaryChars),
    admissions: asStringArray(o.admissions),
    hedges: asStringArray(o.hedges),
    inconsistencies: asStringArray(o.inconsistencies),
    missedFollowUps: asStringArray(o.missedFollowUps),
    scorecard: asScorecard(o.scorecard),
    advocacy: asAdvocacyAnalysis(o.advocacy, context),
  };
}

function reportTextIsUsable(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const row = parsed as Record<string, unknown>;
  if (typeof row.summary === "string" && row.summary.trim()) return true;
  for (const key of ["admissions", "hedges", "inconsistencies", "missedFollowUps"] as const) {
    if (Array.isArray(row[key]) && row[key].length > 0) return true;
  }
  if (row.scorecard && typeof row.scorecard === "object" && !Array.isArray(row.scorecard)) {
    return true;
  }
  if (row.advocacy && typeof row.advocacy === "object" && !Array.isArray(row.advocacy)) {
    return true;
  }
  return false;
}

function readPreviousRegularFile(file: string, maxBytes: number): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function stripCodeFence(content: string): string {
  return content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\n]*$/i, "")
    .trim();
}

/** Extract assistant text from xAI Responses API body. */
function extractResponsesText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  if (d.error != null) {
    throw new Error("Report generation returned a provider error. Try generating the report again.");
  }
  if (d.status !== undefined && d.status !== "completed") {
    throw new Error("Report generation did not complete. Try generating the report again.");
  }
  if (typeof d.output_text === "string" && d.output_text.trim()) return d.output_text;

  const output = d.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "message" && Array.isArray(row.content)) {
      for (const part of row.content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
          parts.push(p.text);
        }
      }
    }
  }
  return parts.join("");
}

function renderReportTranscriptLine(
  line: TranscriptLine,
  lineNumber: number,
  isHearing: boolean,
  personaName: string
): string {
  const who =
    line.role === "user"
      ? "Counsel"
      : isHearing
        ? `Court (${personaName})`
        : personaName;
  return `[L${String(lineNumber).padStart(5, "0")}] ${who}: ${line.text}`;
}

type BoundedReportTranscript = {
  text: string;
  includedLineNumbers: number[];
};

function truncateNumberedTranscriptLine(
  rendered: string,
  maxChars: number,
  keepEnd: boolean
): string {
  if (rendered.length <= maxChars) return rendered;
  const separator = rendered.indexOf(": ");
  const prefix = separator >= 0 ? rendered.slice(0, separator + 2) : "";
  if (maxChars <= prefix.length + 24) return rendered.slice(0, maxChars);
  const marker = keepEnd ? "[…line opening omitted…] " : " …[line remainder omitted]";
  const textBudget = maxChars - prefix.length - marker.length;
  return keepEnd
    ? `${prefix}${marker}${rendered.slice(-textBudget)}`
    : `${prefix}${rendered.slice(prefix.length, prefix.length + textBudget)}${marker}`;
}

/** Keep numbered whole lines from the start and conclusion within the model budget. */
function boundedReportTranscript(
  session: SessionRecord,
  personaName: string,
  maxChars: number
): BoundedReportTranscript {
  if (maxChars <= 0) return { text: "", includedLineNumbers: [] };
  const isHearing = session.mode === "hearing";
  const lines = session.transcript
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.role === "user" || line.role === "assistant")
    .map(({ line, lineNumber }) => ({
      lineNumber,
      rendered: renderReportTranscriptLine(line, lineNumber, isHearing, personaName),
    }));
  const fullLength = lines.reduce(
    (total, line, index) => total + line.rendered.length + (index > 0 ? 1 : 0),
    0
  );
  if (fullLength <= maxChars) {
    return {
      text: lines.map((line) => line.rendered).join("\n"),
      includedLineNumbers: lines.map((line) => line.lineNumber),
    };
  }

  const marker = "\n[Transcript truncated to the report safety limit; middle lines omitted.]\n";
  if (marker.length >= maxChars) {
    return { text: marker.slice(0, maxChars), includedLineNumbers: [] };
  }
  const contentBudget = maxChars - marker.length;
  const headBudget = Math.floor(contentBudget * 0.6);
  const tailBudget = contentBudget - headBudget;
  const included = new Set<number>();
  const fullyIncludedInHead = new Set<number>();

  let head = "";
  for (const line of lines) {
    const separator = head ? "\n" : "";
    const remaining = headBudget - head.length;
    if (remaining <= separator.length) break;
    const available = remaining - separator.length;
    head += separator + truncateNumberedTranscriptLine(line.rendered, available, false);
    included.add(line.lineNumber);
    if (line.rendered.length > available) break;
    fullyIncludedInHead.add(line.lineNumber);
  }

  let tail = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (fullyIncludedInHead.has(line.lineNumber)) continue;
    const separator = tail ? "\n" : "";
    const remaining = tailBudget - tail.length;
    if (remaining <= separator.length) break;
    const available = remaining - separator.length;
    const rendered = truncateNumberedTranscriptLine(line.rendered, available, true);
    tail = rendered + separator + tail;
    included.add(line.lineNumber);
    if (line.rendered.length > available) break;
  }
  return {
    text: `${head}${marker}${tail}`.slice(0, maxChars),
    includedLineNumbers: [...included].sort((a, b) => a - b),
  };
}

export function buildGroundedReportPrompt(
  session: SessionRecord,
  matter: Matter,
  persona: Persona
): { prompt: string; evidenceLineNumbers: number[] } {
  const isHearing = session.mode === "hearing";
  const prefix = `Matter: ${matter.caption}
Court: ${matter.court}
${isHearing ? "Presiding" : "Witness/person"}: ${persona.fullName} — ${persona.role}
Mode: ${session.mode}

LOCAL TRANSCRIPT SIGNALS (deterministic heuristics; verify against the transcript):
${formatAdvocacyDiagnosticsForPrompt(session.mode, session.transcript)}

TRANSCRIPT:
`;
  if (prefix.length >= REPORT_LIMITS.maxReportPromptChars) {
    return {
      prompt: prefix.slice(0, REPORT_LIMITS.maxReportPromptChars),
      evidenceLineNumbers: [],
    };
  }
  const transcript = boundedReportTranscript(
    session,
    persona.fullName,
    REPORT_LIMITS.maxReportPromptChars - prefix.length
  );
  return {
    prompt: prefix + transcript.text,
    evidenceLineNumbers: transcript.includedLineNumbers,
  };
}

export function buildReportPrompt(
  session: SessionRecord,
  matter: Matter,
  persona: Persona
): string {
  return buildGroundedReportPrompt(session, matter, persona).prompt;
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  label: string,
  truncate: boolean
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let wasTruncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (!truncate) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`);
        }
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        wasTruncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total === maxBytes) {
        const next = await reader.read();
        if (!next.done) {
          if (!truncate) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`);
          }
          wasTruncated = true;
          await reader.cancel().catch(() => undefined);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"),
    truncated: wasTruncated,
  };
}

async function generateSessionReportNow(
  session: SessionRecord,
  matter: Matter,
  persona: Persona
): Promise<{ report: SessionReport; reportPath: string; markdownPath: string }> {
  const trusted = trustedReportContext(session, matter, persona);
  session = trusted.session;
  matter = trusted.matter;
  persona = trusted.persona;
  // Fail before the remote request if the eventual persistence boundary has
  // already been replaced. It is revalidated again immediately before commit.
  assertTrustedSessionsDirectory(session.matterId, true);
  const settings = loadSettings();
  if (!settings.xaiApiKey) {
    throw new Error("Set your xAI API key in Settings before generating a report.");
  }

  // Speech only — procedural system lines are excluded from the bounded prompt.
  const reportInput = buildGroundedReportPrompt(session, matter, persona);
  const userPrompt = reportInput.prompt;
  const allowedEvidenceLines = new Set(reportInput.evidenceLineNumbers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

  let content = "{}";
  try {
    const res = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${settings.xaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REPORT_MODEL,
        temperature: 0.2,
        store: false,
        instructions: reportSystemPrompt(session.mode),
        input: userPrompt,
        text: {
          format: { type: "json_object" },
        },
      }),
    });

    if (!res.ok) {
      const body = await readResponseTextBounded(
        res,
        REPORT_LIMITS.maxErrorResponseBytes,
        "Report error response",
        true
      );
      throw new Error(
        `Report generation failed (${res.status}): ${body.text}${
          body.truncated ? " …[truncated]" : ""
        }`
      );
    }

    const responseBody = await readResponseTextBounded(
      res,
      REPORT_LIMITS.maxSuccessResponseBytes,
      "Report response",
      false
    );
    let data: unknown;
    try {
      data = JSON.parse(responseBody.text) as unknown;
    } catch {
      throw new Error("Report generation returned invalid JSON");
    }
    content = extractResponsesText(data);
    if (!reportTextIsUsable(content)) {
      throw new Error(
        "Report generation returned no usable report. Try generating the report again."
      );
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Report generation timed out after ${REPORT_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const jsonText = stripCodeFence(content);
  let parsed: Partial<SessionReport>;
  try {
    parsed = normalizeReportPayload(JSON.parse(jsonText), {
      mode: session.mode,
      transcript: session.transcript,
      allowedEvidenceLines,
    });
  } catch {
    throw new Error("Report generation returned no usable report. Try generating the report again.");
  }

  const report: SessionReport = {
    sessionId: session.id,
    matterCaption: asString(matter.caption),
    personaName: asString(persona.fullName),
    mode: session.mode as ExamMode,
    generatedAt: new Date().toISOString(),
    summary: parsed.summary ?? "",
    admissions: parsed.admissions ?? [],
    hedges: parsed.hedges ?? [],
    inconsistencies: parsed.inconsistencies ?? [],
    missedFollowUps: parsed.missedFollowUps ?? [],
    scorecard: parsed.scorecard ?? {
      control: "",
      oneFactQuestions: "",
      impeachment: "",
      form: "",
      notes: "",
    },
    advocacy:
      parsed.advocacy ?? buildAdvocacyAnalysis(session.mode, session.transcript, [], []),
  };

  const dir = sessionDirectory(session.matterId, true);
  const reportPath = path.join(dir, `${session.id}-report.json`);
  if (
    Buffer.byteLength(JSON.stringify(report, null, 2), "utf8") > REPORT_LIMITS.maxReportJsonBytes
  ) {
    throw new Error(
      `Session report JSON exceeds the ${REPORT_LIMITS.maxReportJsonBytes}-byte safety limit`
    );
  }
  const markdownPath = path.join(dir, `${session.id}-report.md`);
  const previousReport = readPreviousRegularFile(
    reportPath,
    REPORT_LIMITS.maxReportJsonBytes
  );
  writeJson(reportPath, report, {
    maxBytes: REPORT_LIMITS.maxReportJsonBytes,
    label: "Session report JSON",
  });
  const md = [
    `# Session report`,
    ``,
    `> AI-generated trial-preparation simulation — verify against the source record`,
    ``,
    `- **Matter:** ${report.matterCaption}`,
    `- **Person:** ${report.personaName}`,
    `- **Mode:** ${report.mode}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Model:** ${REPORT_MODEL}`,
    ``,
    `## Summary`,
    report.summary,
    ``,
    `## Admissions`,
    ...report.admissions.map((a) => `- ${a}`),
    ``,
    `## Hedges`,
    ...report.hedges.map((a) => `- ${a}`),
    ``,
    `## Inconsistencies / impeachment hooks`,
    ...report.inconsistencies.map((a) => `- ${a}`),
    ``,
    `## Missed follow-ups`,
    ...report.missedFollowUps.map((a) => `- ${a}`),
    ``,
    `## Scorecard`,
    `- **Control:** ${report.scorecard.control}`,
    `- **One-fact questions:** ${report.scorecard.oneFactQuestions}`,
    `- **Impeachment:** ${report.scorecard.impeachment}`,
    `- **Form:** ${report.scorecard.form}`,
    `- **Notes:** ${report.scorecard.notes}`,
    ``,
    `## Advocacy method ${report.advocacy.frameworkVersion}`,
    ``,
    `> ${report.advocacy.diagnostics.caveat}`,
    ``,
    `### Local transcript signals`,
    ...report.advocacy.diagnostics.metrics.map((metric) =>
      `- **${metric.label}:** ${metric.value}${
        metric.denominator === undefined ? "" : ` / ${metric.denominator}`
      }${metric.unit === "words" ? " words" : ""} — ${metric.note}`
    ),
    ``,
    `### Skill coaching`,
    ...report.advocacy.skills.flatMap((skill) => [
      `#### ${skill.label} — ${skill.rating}`,
      ...skill.evidence.flatMap((evidence) => [
        `- Evidence${evidence.line === null ? " (legacy, unreferenced)" : ` at line ${evidence.line}`}: ${evidence.observation}`,
        ...(evidence.excerpt ? [`  - Transcript: ${evidence.excerpt}`] : []),
      ]),
      `- Coaching: ${skill.coaching}`,
      `- Drill: ${skill.drill}`,
      ``,
    ]),
    `### Ethical flags`,
    ...(report.advocacy.ethicalFlags.length
      ? report.advocacy.ethicalFlags.flatMap((flag) => [
          `- ${flag.line === null ? "Legacy, unreferenced" : `Line ${flag.line}`}: ${flag.concern}`,
          ...(flag.excerpt ? [`  - Transcript: ${flag.excerpt}`] : []),
        ])
      : ["- None identified."]),
    ``,
  ].join("\n");
  try {
    writeFileAtomic(markdownPath, md);
  } catch (err) {
    if (previousReport === null) fs.rmSync(reportPath, { force: true });
    else writeFileAtomic(reportPath, previousReport);
    throw err;
  }

  return { report, reportPath, markdownPath };
}

type QueuedReportGeneration = {
  start: () => void;
};

let activeReportGenerations = 0;
const queuedReportGenerations: QueuedReportGeneration[] = [];

function drainReportGenerationQueue(): void {
  while (
    activeReportGenerations < REPORT_GENERATION_LIMITS.maxConcurrent &&
    queuedReportGenerations.length
  ) {
    queuedReportGenerations.shift()!.start();
  }
}

function enqueueReportGeneration<T>(operation: () => Promise<T>): Promise<T> {
  if (
    activeReportGenerations >= REPORT_GENERATION_LIMITS.maxConcurrent &&
    queuedReportGenerations.length >= REPORT_GENERATION_LIMITS.maxQueued
  ) {
    return Promise.reject(
      new Error(
        `Report generation queue is full (${REPORT_GENERATION_LIMITS.maxConcurrent} active, ${REPORT_GENERATION_LIMITS.maxQueued} waiting). Wait for an existing report to finish and try again.`
      )
    );
  }

  return new Promise<T>((resolve, reject) => {
    queuedReportGenerations.push({
      start: () => {
        activeReportGenerations += 1;
        let outcome: Promise<T>;
        try {
          outcome = Promise.resolve(operation());
        } catch (err) {
          outcome = Promise.reject(err);
        }
        void outcome.then(resolve, reject).finally(() => {
          activeReportGenerations -= 1;
          drainReportGenerationQueue();
        });
      },
    });
    drainReportGenerationQueue();
  });
}

/**
 * All report entry points share this queue, including live-session finalization
 * and saved-session regeneration.
 */
export function generateSessionReport(
  session: SessionRecord,
  matter: Matter,
  persona: Persona
): Promise<{ report: SessionReport; reportPath: string; markdownPath: string }> {
  return enqueueReportGeneration(() => generateSessionReportNow(session, matter, persona));
}

const savedReportGenerations = new Map<string, Promise<GeneratedSessionReportResult>>();

const DELETE_TRANSACTION_LIMIT = 20;
const DELETE_FILE_LIMIT = 2_000;
const DELETE_TRANSACTION_RE = new RegExp(
  `^\\.session-delete-(pending|committed)-(${UUID_RE.source.slice(1, -1)})-(${UUID_RE.source.slice(1, -1)})$`,
  "i"
);

type DeletionMaintenanceIssue = {
  sessionId: string;
  message: string;
};

type DeletionTransaction = {
  mode: "pending" | "committed";
  sessionId: string;
  path: string;
};

function deletionSessionKey(matterId: string, sessionId: string): string {
  return `${matterId.toLowerCase()}:${sessionId.toLowerCase()}`;
}

function deletionExactNames(sessionId: string): Set<string> {
  return new Set([
    `${sessionId}.json`,
    `${sessionId}.json.bak`,
    `${sessionId}-transcript.md`,
    `${sessionId}-report.json`,
    `${sessionId}-report.json.bak`,
    `${sessionId}-report.md`,
  ]);
}

function isDeletionLeafName(name: string, sessionId: string): boolean {
  if (deletionExactNames(sessionId).has(name)) return true;
  return new RegExp(
    `^(?:${sessionId}\\.json|${sessionId}-report\\.json)\\.corrupt-\\d+(?:-\\d+)?$`,
    "i"
  ).test(name);
}

function deletionLeafNames(dir: string, sessionId: string): string[] {
  const names = fs.readdirSync(dir).filter((name) => isDeletionLeafName(name, sessionId));
  if (names.length > DELETE_FILE_LIMIT) {
    throw new Error(
      `Session ${sessionId} has too many deletion artifacts (limit ${DELETE_FILE_LIMIT})`
    );
  }
  const live = `${sessionId}.json`;
  return [...names.filter((name) => name !== live).sort(), live];
}

function assertSameSessionsDirectory(matterId: string, expected: string): void {
  const current = assertTrustedSessionsDirectory(matterId, false);
  if (!sameRealDirectory(current, expected)) {
    throw new Error("Session directory changed during deletion");
  }
}

function trustedDeletionTransactionDirectory(dir: string, candidate: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedCandidate = path.resolve(candidate);
  if (isPathOutside(resolvedDir, resolvedCandidate) || resolvedCandidate === resolvedDir) {
    throw new Error("Deletion tombstone is outside the session directory");
  }
  const stat = fs.lstatSync(resolvedCandidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Deletion tombstone is not a trusted directory");
  }
  const realDir = fs.realpathSync.native(resolvedDir);
  const realCandidate = fs.realpathSync.native(resolvedCandidate);
  if (isPathOutside(realDir, realCandidate) || realCandidate === realDir) {
    throw new Error("Deletion tombstone resolves outside the session directory");
  }
  return resolvedCandidate;
}

function readDeletionTransaction(
  dir: string,
  name: string
): DeletionTransaction | null {
  const match = name.match(DELETE_TRANSACTION_RE);
  if (!match?.[1] || !match[2]) return null;
  return {
    mode: match[1].toLowerCase() as "pending" | "committed",
    sessionId: match[2],
    path: trustedDeletionTransactionDirectory(dir, path.join(dir, name)),
  };
}

function validatedTransactionLeaves(
  matterId: string,
  dir: string,
  transaction: DeletionTransaction
): string[] {
  assertSameSessionsDirectory(matterId, dir);
  const names = fs.readdirSync(transaction.path);
  if (names.length > DELETE_FILE_LIMIT) {
    throw new Error(`Deletion tombstone contains too many files (limit ${DELETE_FILE_LIMIT})`);
  }
  for (const name of names) {
    if (!isDeletionLeafName(name, transaction.sessionId)) {
      throw new Error(`Deletion tombstone contains unexpected file ${name}`);
    }
    trustedRegularSessionFile(
      transaction.path,
      path.join(transaction.path, name),
      "Session deletion tombstone"
    );
  }
  return names.sort();
}

function validateDeletionTransactionAnchor(
  matterId: string,
  dir: string,
  transaction: DeletionTransaction,
  names: string[]
): void {
  const liveName = `${transaction.sessionId}.json`;
  if (names.includes(liveName)) {
    readSessionFile(
      path.join(transaction.path, liveName),
      transaction.path,
      matterId,
      transaction.sessionId
    );
    return;
  }
  if (transaction.mode === "committed" && names.length === 0) return;

  const live = optionalTrustedRegularSessionFile(
    dir,
    path.join(dir, liveName),
    "Session JSON"
  );
  if (!live) throw new Error("Deletion tombstone has no valid session ownership anchor");
  readSessionFile(live, dir, matterId, transaction.sessionId);
}

function rollbackPendingDeletion(
  matterId: string,
  dir: string,
  transaction: DeletionTransaction
): void {
  const names = validatedTransactionLeaves(matterId, dir, transaction);
  validateDeletionTransactionAnchor(matterId, dir, transaction, names);
  for (const name of names) {
    if (optionalTrustedRegularSessionFile(dir, path.join(dir, name), "Session deletion rollback")) {
      throw new Error(`cannot restore ${name} because its destination already exists`);
    }
  }

  const restored: Array<{ source: string; destination: string }> = [];
  try {
    for (const name of names) {
      assertSameSessionsDirectory(matterId, dir);
      const source = trustedRegularSessionFile(
        transaction.path,
        path.join(transaction.path, name),
        "Session deletion tombstone"
      );
      const destination = path.join(dir, name);
      fs.renameSync(source, destination);
      restored.push({ source, destination });
    }
    fs.rmdirSync(transaction.path);
  } catch (err) {
    const rollbackFailures: string[] = [];
    for (const item of restored.reverse()) {
      try {
        if (fs.existsSync(item.source)) continue;
        const restoredFile = trustedRegularSessionFile(
          dir,
          item.destination,
          "Session deletion rollback"
        );
        fs.renameSync(restoredFile, item.source);
      } catch (rollbackErr) {
        rollbackFailures.push(String(rollbackErr));
      }
    }
    throw new Error(
      `pending deletion rollback failed: ${String(err)}${
        rollbackFailures.length ? `; rollback errors: ${rollbackFailures.join("; ")}` : ""
      }`
    );
  }
}

function cleanupCommittedDeletion(
  matterId: string,
  dir: string,
  transaction: DeletionTransaction
): void {
  const names = validatedTransactionLeaves(matterId, dir, transaction);
  validateDeletionTransactionAnchor(matterId, dir, transaction, names);
  const liveName = `${transaction.sessionId}.json`;
  const optionalNames = names.filter((name) => name !== liveName);
  const failures: string[] = [];
  for (const name of optionalNames) {
    try {
      const file = trustedRegularSessionFile(
        transaction.path,
        path.join(transaction.path, name),
        "Committed session tombstone"
      );
      fs.unlinkSync(file);
    } catch (err) {
      failures.push(`${name}: ${String(err)}`);
    }
  }
  if (failures.length) {
    throw new Error(`committed deletion cleanup deferred: ${failures.join("; ")}`);
  }
  if (names.includes(liveName)) {
    const live = trustedRegularSessionFile(
      transaction.path,
      path.join(transaction.path, liveName),
      "Committed session tombstone"
    );
    fs.unlinkSync(live);
  }
  fs.rmdirSync(transaction.path);
}

function maintainDeletionTransactions(
  matterId: string,
  dir: string,
  knownNames?: string[],
  onlySessionId?: string
): DeletionMaintenanceIssue[] {
  const issues: DeletionMaintenanceIssue[] = [];
  let transactionNames: string[];
  try {
    transactionNames = (knownNames ?? fs.readdirSync(dir))
      .filter((name) => DELETE_TRANSACTION_RE.test(name))
      .filter(
        (name) =>
          !onlySessionId ||
          name.match(DELETE_TRANSACTION_RE)?.[2]?.toLowerCase() ===
            onlySessionId.toLowerCase()
      )
      .sort();
  } catch (err) {
    return [
      {
        sessionId: "",
        message: `Session deletion recovery failed: ${publicErrorMessage(err)}`,
      },
    ];
  }
  if (transactionNames.length > DELETE_TRANSACTION_LIMIT) {
    issues.push({
      sessionId: "",
      message: `Session deletion cleanup is bounded to ${DELETE_TRANSACTION_LIMIT} transactions per pass; additional tombstones remain for a later pass.`,
    });
  }
  for (const name of transactionNames.slice(0, DELETE_TRANSACTION_LIMIT)) {
    let transaction: DeletionTransaction | null = null;
    try {
      transaction = readDeletionTransaction(dir, name);
      if (!transaction) continue;
      if (transaction.mode === "pending") {
        rollbackPendingDeletion(matterId, dir, transaction);
      } else {
        cleanupCommittedDeletion(matterId, dir, transaction);
      }
    } catch (err) {
      const matchedId = name.match(DELETE_TRANSACTION_RE)?.[2] ?? "";
      const sessionId = transaction?.sessionId ?? matchedId;
      const id = sessionId || name;
      issues.push({
        sessionId,
        message: `Session ${id}: deletion transaction needs attention: ${publicErrorMessage(err)}`,
      });
    }
  }
  return issues;
}

function rollbackStagedDeletion(
  dir: string,
  pendingDir: string,
  stagedNames: string[]
): string[] {
  const failures: string[] = [];
  for (const name of [...stagedNames].reverse()) {
    const source = path.join(pendingDir, name);
    const destination = path.join(dir, name);
    try {
      try {
        fs.lstatSync(destination);
        throw new Error(`${name} reappeared before rollback`);
      } catch (entryErr) {
        if ((entryErr as NodeJS.ErrnoException).code !== "ENOENT") throw entryErr;
      }
      const tombstone = trustedRegularSessionFile(
        pendingDir,
        source,
        "Session deletion tombstone"
      );
      fs.renameSync(tombstone, destination);
    } catch (err) {
      failures.push(`${name}: ${String(err)}`);
    }
  }
  try {
    fs.rmdirSync(pendingDir);
  } catch (err) {
    failures.push(`tombstone directory: ${String(err)}`);
  }
  return failures;
}

/** Transactionally delete one persisted session and only its app-owned artifacts. */
export function deleteSession(
  matterId: string,
  sessionId: string
): { deleted: string } {
  if (!UUID_RE.test(matterId)) throw new Error("Invalid matter id");
  if (!UUID_RE.test(sessionId)) throw new Error("Invalid session id");
  if (savedReportGenerations.has(deletionSessionKey(matterId, sessionId))) {
    throw new Error("Wait for report generation to finish before deleting this session.");
  }

  const dir = sessionDirectory(matterId, false);
  let trustedLive = optionalTrustedRegularSessionFile(
    dir,
    path.join(dir, `${sessionId}.json`),
    "Session JSON"
  );
  if (trustedLive) {
    // No deletion housekeeping mutates the directory until the requested live
    // record itself has established valid matter/session ownership.
    readSessionFile(trustedLive, dir, matterId, sessionId);
  } else {
    const targetRecoveryIssues = maintainDeletionTransactions(
      matterId,
      dir,
      undefined,
      sessionId
    );
    const targetRecoveryIssue = targetRecoveryIssues.find(
      (issue) => issue.sessionId.toLowerCase() === sessionId.toLowerCase()
    );
    if (targetRecoveryIssue) throw new Error(targetRecoveryIssue.message);
    trustedLive = optionalTrustedRegularSessionFile(
      dir,
      path.join(dir, `${sessionId}.json`),
      "Session JSON"
    );
    if (!trustedLive) throw new Error("Session not found");
    readSessionFile(trustedLive, dir, matterId, sessionId);
  }

  const maintenanceIssues = maintainDeletionTransactions(matterId, dir);
  const targetIssue = maintenanceIssues.find(
    (issue) => issue.sessionId.toLowerCase() === sessionId.toLowerCase()
  );
  if (targetIssue) throw new Error(targetIssue.message);

  const livePath = path.join(dir, `${sessionId}.json`);
  trustedLive = optionalTrustedRegularSessionFile(dir, livePath, "Session JSON");
  if (!trustedLive) throw new Error("Session not found");
  readSessionFile(trustedLive, dir, matterId, sessionId);

  const names = deletionLeafNames(dir, sessionId);
  for (const name of names) {
    trustedRegularSessionFile(dir, path.join(dir, name), "Session deletion artifact");
  }

  const transactionId = randomUUID();
  const pendingDir = path.join(
    dir,
    `.session-delete-pending-${sessionId}-${transactionId}`
  );
  const committedDir = path.join(
    dir,
    `.session-delete-committed-${sessionId}-${transactionId}`
  );
  fs.mkdirSync(pendingDir, { mode: 0o700 });
  const stagedNames: string[] = [];
  try {
    for (const name of names) {
      assertSameSessionsDirectory(matterId, dir);
      const source = trustedRegularSessionFile(
        dir,
        path.join(dir, name),
        "Session deletion artifact"
      );
      fs.renameSync(source, path.join(pendingDir, name));
      stagedNames.push(name);
    }
    assertSameSessionsDirectory(matterId, dir);
    fs.renameSync(pendingDir, committedDir);
  } catch (err) {
    const rollbackFailures = rollbackStagedDeletion(dir, pendingDir, stagedNames);
    throw new Error(
      rollbackFailures.length
        ? `Could not delete session; staging failed and rollback needs attention: ${String(err)}; rollback errors: ${rollbackFailures.join("; ")}`
        : `Could not delete session; all staged files were rolled back: ${String(err)}`
    );
  }

  try {
    cleanupCommittedDeletion(matterId, dir, {
      mode: "committed",
      sessionId,
      path: committedDir,
    });
  } catch (err) {
    // The directory rename above is the commit point. Never resurrect only part
    // of a deleted session; later list/delete passes retry this bounded cleanup.
    console.error(
      `[report] Session ${sessionId} deletion committed; tombstone cleanup deferred`,
      err
    );
  }
  return { deleted: sessionId };
}

async function generateSavedSessionReportOnce(
  matterId: string,
  sessionId: string
): Promise<GeneratedSessionReportResult> {
  const dir = sessionDirectory(matterId, false);
  const sessionPath = path.join(dir, `${sessionId}.json`);
  const trustedSession = optionalTrustedRegularSessionFile(
    dir,
    sessionPath,
    "Session JSON"
  );
  if (!trustedSession) throw new Error("Session not found");
  const session = readSessionFile(
    trustedSession,
    dir,
    matterId,
    sessionId,
    true
  ).session;
  const matter = getMatter(matterId);
  if (!matter) throw new Error("Matter not found");
  const persona = listPersonas(matterId).find(
    (candidate) => candidate.id === session.personaId && candidate.matterId === matterId
  );
  if (!persona) throw new Error("Session persona was not found in this matter");

  const generated = await generateSessionReport(session, matter, persona);
  saveSession({ ...session, reportPath: generated.reportPath });
  const reportDataErrors: string[] = [];
  let canOpenReport = false;
  try {
    canOpenReport = Boolean(
      optionalTrustedRegularSessionFile(
        dir,
        generated.markdownPath,
        "Session report Markdown"
      )
    );
  } catch {
    reportDataErrors.push(
      "The generated report was saved, but its Markdown artifact was unsafe and cannot be opened."
    );
  }
  return {
    session: { id: session.id, matterId: session.matterId },
    report: generated.report,
    canOpenReport,
    reportDataErrors,
  };
}

/**
 * Regenerate from a persisted transcript without reopening voice mode. Calls
 * for the same saved session share one in-flight request so close/reopen UI
 * races cannot double-submit the transcript or overwrite the same artifacts.
 */
export function generateSavedSessionReport(
  matterId: string,
  sessionId: string
): Promise<GeneratedSessionReportResult> {
  if (!UUID_RE.test(matterId)) return Promise.reject(new Error("Invalid matter id"));
  if (!UUID_RE.test(sessionId)) return Promise.reject(new Error("Invalid session id"));
  const key = deletionSessionKey(matterId, sessionId);
  const existing = savedReportGenerations.get(key);
  if (existing) return existing;

  const generation = generateSavedSessionReportOnce(matterId, sessionId);
  savedReportGenerations.set(key, generation);
  generation.then(
    () => {
      if (savedReportGenerations.get(key) === generation) savedReportGenerations.delete(key);
    },
    () => {
      if (savedReportGenerations.get(key) === generation) savedReportGenerations.delete(key);
    }
  );
  return generation;
}
