import { BrowserWindow } from "electron";
import { v4 as uuid } from "uuid";
import WebSocket from "ws";
import type { ExamMode, Matter, Persona, SessionRecord, TranscriptLine } from "../types.js";
import { buildSessionDossier, retrieveForQuestion } from "./caseContext.js";
import {
  getDocumentExcerpt,
  getPriorTestimony,
  loadIndex,
  SEARCH_INPUT_LIMITS,
  searchCaseRecord,
} from "./indexer.js";
import { getMatter, listPersonas } from "./matters.js";
import {
  buildSessionInstructions,
  DOSSIER_BEGIN,
  DOSSIER_END,
  isHearingMode,
  sessionOpeningSpoken,
  sessionOpeningTranscript,
} from "./prompts.js";
import {
  generateSessionReport,
  REPORT_LIMITS,
  saveSession,
  writeTranscriptMarkdown,
} from "./report.js";
import { loadSettings } from "./settings.js";
import { publicErrorMessage } from "./fsutil.js";

type ServerEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: {
    type?: string;
    role?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string; transcript?: string }>;
  };
  response?: { output?: unknown; status?: string };
  error?: { message?: string; code?: string; type?: string };
};

export type VoiceSessionTerminalResult = Readonly<{
  session: Readonly<Pick<SessionRecord, "id" | "matterId">> | null;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
  needsSaveRetry: boolean;
}>;

/**
 * Terminal events cross the privileged main/renderer boundary. Keep the durable
 * record and artifact paths main-side; the renderer only needs stable identity
 * plus enough capability state to decide which open actions to show.
 */
function terminalResult(
  session: SessionRecord | null,
  state: Partial<
    Pick<
      VoiceSessionTerminalResult,
      "canOpenTranscript" | "canOpenReport" | "needsSaveRetry"
    >
  > = {}
): VoiceSessionTerminalResult {
  return {
    session: session ? { id: session.id, matterId: session.matterId } : null,
    canOpenTranscript: state.canOpenTranscript ?? false,
    canOpenReport: state.canOpenReport ?? false,
    needsSaveRetry: state.needsSaveRetry ?? false,
  };
}

type ConnectAttempt = {
  epoch: number;
  ws: WebSocket;
  cancel: (reason?: Error) => void;
};

/** Retired ws transports can still emit asynchronous errors while closing. */
function retireSocketListeners(ws: WebSocket): void {
  ws.removeAllListeners();
  // In particular, terminate() during CONNECTING schedules an error on the
  // next tick. Keep it contained after the original start failure is reported.
  ws.on("error", () => undefined);
}

const VOICE_TRANSPORT_LIMITS = Object.freeze({
  maxPayloadBytes: 2 * 1024 * 1024,
  maxBufferedSendBytes: 4 * 1024 * 1024,
  maxAudioDeltaChars: 512_000,
  maxTranscriptBufferChars: 200_000,
  maxTranscriptLineChars: 12_000,
  maxHandshakeErrorBytes: 4_096,
  maxToolArgumentsBytes: 16_384,
  maxToolCallIdChars: 256,
  maxToolOutputBytes: 12 * 1024,
});

const TRANSCRIPT_TRUNCATION_MARKER = " … [transcript event truncated]";

/**
 * Final transcript rows are checkpointed together so normal speech does not turn
 * into a synchronous disk write for every completed event.
 */
export const SESSION_CHECKPOINT_DEBOUNCE_MS = 750;

/**
 * Live sessions stop below the disk normalizer's 20k-row / 8m-character ceiling,
 * leaving room for a visible terminal row instead of silently losing the tail.
 */
export const VOICE_LIVE_TRANSCRIPT_LIMITS = Object.freeze({
  maxLines: 10_000,
  maxTotalChars: 4_000_000,
});

export const VOICE_PING_INTERVAL_MS = 20_000;
export const VOICE_PONG_TIMEOUT_MS = 10_000;
// xAI recommends a versioned voice model for production stability. Review this
// deliberately during releases instead of inheriting behavioral changes from
// the floating grok-voice-latest alias. Flagship as of 2026-07 is
// grok-voice-think-fast-2.0; grok-voice-latest aliases think-fast 2.0.
export const VOICE_MODEL = "grok-voice-think-fast-2.0";

const TRANSCRIPT_LIMIT_TERMINAL_TEXT =
  "[Session ended] Transcript safety limit reached. The session ended before additional testimony could be silently dropped.";

function isSafePcmBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > VOICE_TRANSPORT_LIMITS.maxAudioDeltaChars ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes % 2 === 0;
}

function truncateWithMarker(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return value.slice(0, maxChars - marker.length).trimEnd() + marker;
}

/**
 * Keep both dossier markers. Notes and then the lowest-priority excerpts are
 * what shrink. A tail cut of the whole prompt used to delete the closer and
 * leave the retrieval block inside an unclosed dossier.
 */
function fitDossierInstructions(base: string, budget: number, marker: string): string {
  const begin = base.indexOf(DOSSIER_BEGIN);
  const end = base.indexOf(DOSSIER_END);
  if (begin === -1 || end < begin) return truncateWithMarker(base, budget, marker);
  const prefix = base.slice(0, begin);
  const body = base.slice(begin + DOSSIER_BEGIN.length, end);
  const suffix = base.slice(end);
  const reserved = prefix.length + DOSSIER_BEGIN.length + suffix.length;
  if (reserved >= budget) {
    const headBudget = Math.max(0, budget - DOSSIER_BEGIN.length - suffix.length);
    const head = truncateWithMarker(prefix, headBudget, marker);
    return `${head}${DOSSIER_BEGIN}\n${suffix}`;
  }
  const bodyBudget = budget - reserved;
  const boundedBody =
    body.length > bodyBudget
      ? truncateWithMarker(
          body,
          bodyBudget,
          "\n[Dossier excerpts truncated to keep both case-file markers.]"
        )
      : body;
  return `${prefix}${DOSSIER_BEGIN}${boundedBody}${suffix}`;
}

function boundedTranscriptText(value: unknown): string {
  if (typeof value !== "string") return "";
  return truncateWithMarker(
    value.trim(),
    VOICE_TRANSPORT_LIMITS.maxTranscriptLineChars,
    TRANSCRIPT_TRUNCATION_MARKER
  );
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Tool arguments must be JSON text");
  if (Buffer.byteLength(value, "utf8") > VOICE_TRANSPORT_LIMITS.maxToolArgumentsBytes) {
    throw new Error("Tool arguments exceed the size limit");
  }
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Tool arguments must be a plain JSON object");
  }
  return parsed as Record<string, unknown>;
}

function boundedToolActivity(args: Record<string, unknown>): Record<string, string | number> {
  const entries: Array<[string, string | number]> = [];
  for (const [key, value] of Object.entries(args)) {
    if (entries.length >= 8) break;
    const boundedKey = key.slice(0, 80);
    if (!boundedKey) continue;
    if (typeof value === "string") entries.push([boundedKey, value.slice(0, 256)]);
    else if (typeof value === "number" && Number.isFinite(value)) {
      entries.push([boundedKey, value]);
    }
  }
  return Object.fromEntries(entries) as Record<string, string | number>;
}

const TOOL_DOCUMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TOOL_DOCUMENT_TYPES = new Set([
  "deposition",
  "exhibit",
  "pleading",
  "affidavit",
  "timeline",
  "transcript",
  "other",
]);

function assertToolKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(args).find((key) => !permitted.has(key));
  if (unexpected) throw new Error(`Unexpected tool argument: ${unexpected.slice(0, 80)}`);
}

function toolText(
  args: Record<string, unknown>,
  key: string,
  maxChars: number,
  options: { required?: boolean } = {}
): string | undefined {
  const value = args[key];
  if (value === undefined) {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be text`);
  if (value.length > maxChars) throw new Error(`${key} exceeds the ${maxChars}-character limit`);
  if (TOOL_CONTROL_RE.test(value)) throw new Error(`${key} contains unsupported control characters`);
  const normalized = value.trim();
  if (!normalized) {
    if (options.required) throw new Error(`${key} is required`);
    return undefined;
  }
  return normalized;
}

function toolMaxResults(args: Record<string, unknown>): number | undefined {
  const value = args.maxResults;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 12) {
    throw new Error("maxResults must be a number from 1 through 12");
  }
  return value;
}

/** Only the documented evidence fields may cross the remote tool boundary. */
function sanitizeToolResults(output: unknown): unknown {
  if (!Array.isArray(output)) {
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const error = (output as Record<string, unknown>).error;
      if (error !== undefined) return { error: publicErrorMessage(error) };
    }
    return { error: "invalid_tool_result" };
  }
  const stringLimits = {
    chunkId: 64,
    fileName: SEARCH_INPUT_LIMITS.fileNameChars,
    docType: SEARCH_INPUT_LIMITS.docTypeChars,
    witnessName: SEARCH_INPUT_LIMITS.witnessNameChars,
    exhibitNo: 512,
    pageHint: 128,
    text: 1_500,
  } as const;
  return output.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const row = value as Record<string, unknown>;
    const safe: Record<string, string | number> = {};
    for (const [key, maxChars] of Object.entries(stringLimits)) {
      const field = row[key];
      if (typeof field === "string") safe[key] = field.slice(0, maxChars);
    }
    if (typeof row.score === "number" && Number.isFinite(row.score)) safe.score = row.score;
    return safe;
  });
}

function serializeToolOutput(output: unknown): string {
  const safeOutput = sanitizeToolResults(output);
  let serialized: string;
  try {
    serialized = JSON.stringify(safeOutput) ?? JSON.stringify({ error: "empty_tool_result" });
  } catch {
    return JSON.stringify({ error: "tool_result_not_serializable" });
  }
  if (Buffer.byteLength(serialized, "utf8") <= VOICE_TRANSPORT_LIMITS.maxToolOutputBytes) {
    return serialized;
  }
  if (!Array.isArray(safeOutput)) {
    return JSON.stringify({
      error: "result_too_large",
      note: "Ask a narrower question or use an exact document selector.",
    });
  }

  const results: unknown[] = [];
  for (const value of safeOutput) {
    let candidate: unknown = value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      candidate = {
        ...row,
        ...(typeof row.text === "string" ? { text: row.text.slice(0, 800) } : {}),
      };
    }
    const next = {
      results: [...results, candidate],
      truncated: true,
      totalResults: safeOutput.length,
    };
    if (
      Buffer.byteLength(JSON.stringify(next), "utf8") >
      VOICE_TRANSPORT_LIMITS.maxToolOutputBytes
    ) {
      break;
    }
    results.push(candidate);
  }
  return JSON.stringify({ results, truncated: true, totalResults: safeOutput.length });
}

function transcriptionKeyterms(persona: Persona, matter: Matter): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    for (const token of value
      .slice(0, 256)
      .split(/[^\p{L}\p{N}.-]+/u)
      .filter((part) => part.length > 1)) {
      const bounded = token.slice(0, 50);
      const key = bounded.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(bounded);
      if (out.length >= 100) return;
    }
  };

  for (const value of [
    persona.fullName,
    matter.caption,
    ...(persona.keyterms || []).slice(0, 24),
    "deposition exhibit motion burden record",
  ]) {
    add(value);
    if (out.length >= 100) break;
  }
  return out;
}

export type VoiceSessionStateSnapshot = Readonly<{
  active: boolean;
  hasSession: boolean;
  hasUnsavedSession: boolean;
  matterId: string | null;
  sessionId: string | null;
}>;

export class VoiceSessionManager {
  private ws: WebSocket | null = null;
  private session: SessionRecord | null = null;
  private matter: Matter | null = null;
  private persona: Persona | null = null;
  private assistantBuffer = "";
  private transcriptChars = 0;
  private transcriptLimitTriggered = false;
  private win: BrowserWindow | null = null;
  /** Base system prompt including dossier (without per-turn retrieval). */
  private baseInstructions = "";
  private lastRetrievedQuestion = "";
  /** Last user ASR text we pushed/updated on the transcript. */
  private lastUserAsrPushed = "";
  /** Index in session.transcript of the current cumulative user utterance (not necessarily last). */
  private currentUserAsrLineIndex: number | null = null;
  /**
   * After speech_started, the next ASR must open a new counsel line even if it shares
   * a prefix with the previous question ("Can you identify…").
   */
  private forceNewUserUtterance = true;
  /** Dedup function-call handlers when xAI emits both event types. */
  private handledCallIds = new Set<string>();
  /**
   * Bumped on every start/stop so late events from a prior socket are ignored.
   * Handlers close over the epoch at attach time.
   */
  private epoch = 0;
  /** True while stop() is tearing down intentionally (not a network drop). */
  private intentionalStop = false;
  private finalizing = false;
  /** True between response.created and response.done — avoid session.update mid-turn. */
  private responseInProgress = false;
  /** Latest counsel question waiting to be injected after the current response ends. */
  private pendingRetrieval: string | null = null;
  /** Short counsel ASR that has not yet been committed to the transcript. */
  private pendingUserPartial = "";
  /** Counsel started speaking while the model still owned the current response. */
  private speechStartedDuringResponse = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimerSocket: WebSocket | null = null;
  /** Pending live-session checkpoint, bound to the lifecycle that scheduled it. */
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointTimerOwnerEpoch: number | null = null;
  /** Spoken opening held until xAI acknowledges session.update. */
  private pendingOpening: { spoken: string; askFirstHearingQuestion: boolean } | null = null;
  /** Current handshake, if start() is waiting for the socket to open. */
  private connectAttempt: ConnectAttempt | null = null;
  /** Owns matter/persona/session slots so stale starts cannot clear newer state. */
  private ownerEpoch: number | null = null;
  /** All callers share one finalization; notably UI stop and before-quit. */
  private stopPromise: Promise<VoiceSessionTerminalResult> | null = null;
  /** True once the current transcript JSON is durably written (report may still run). */
  private sessionPersisted = false;
  /** Cap total instructions size for voice (oversized session.update can drop the socket). */
  private static readonly MAX_INSTRUCTIONS_CHARS = 22000;
  private static readonly MAX_RETRIEVAL_BLOCK_CHARS = 6000;

  private static composeInstructions(base: string, addition = ""): string {
    const limit = VoiceSessionManager.MAX_INSTRUCTIONS_CHARS;
    const baseMarker =
      "\n\n[Case grounding truncated to keep this session.update within the 22,000-character voice transport limit.]";
    const additionMarker =
      "\n[Retrieved case record truncated to keep this session.update within the 22,000-character voice transport limit.]";
    const boundedAddition = truncateWithMarker(
      addition,
      VoiceSessionManager.MAX_RETRIEVAL_BLOCK_CHARS,
      additionMarker
    );
    const fitted = fitDossierInstructions(base, limit - boundedAddition.length, baseMarker);
    return `${fitted}${boundedAddition}`;
  }

  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  private emit(channel: string, payload?: unknown) {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.webContents.send(channel, payload);
    } catch {
      /* window closed mid-session */
    }
  }

  private pushTranscript(
    line: TranscriptLine,
    checkpoint = line.role === "user" || line.role === "assistant"
  ): boolean {
    if (!this.session) return false;
    const boundedLine =
      line.role === "user" || line.role === "assistant"
        ? { ...line, text: boundedTranscriptText(line.text) }
        : line;
    if (!boundedLine.text) return false;
    if (this.formattedTranscriptExceedsDisk([...this.session.transcript, boundedLine])) {
      this.endForTranscriptLimit();
      return false;
    }
    if (
      this.session.transcript.length >= VOICE_LIVE_TRANSCRIPT_LIMITS.maxLines - 1 ||
      this.transcriptChars + boundedLine.text.length >
        VOICE_LIVE_TRANSCRIPT_LIMITS.maxTotalChars - TRANSCRIPT_LIMIT_TERMINAL_TEXT.length
    ) {
      this.endForTranscriptLimit();
      return false;
    }
    this.sessionPersisted = false;
    this.session.transcript.push(boundedLine);
    this.transcriptChars += boundedLine.text.length;
    this.emit("voice:transcript", boundedLine);
    if (checkpoint) this.scheduleCheckpoint();
    return true;
  }

  private formattedTranscriptExceedsDisk(transcript: TranscriptLine[]): boolean {
    if (!this.session) return false;
    const textBytes = transcript.reduce(
      (sum, row) => sum + Buffer.byteLength(row.text, "utf8"),
      0
    );
    const estimate = textBytes + 2048 + transcript.length * 80;
    if (estimate < REPORT_LIMITS.maxSessionJsonBytes) return false;
    const trial: SessionRecord = { ...this.session, transcript };
    return (
      Buffer.byteLength(JSON.stringify(trial, null, 2), "utf8") >
      REPORT_LIMITS.maxSessionJsonBytes
    );
  }

  /** Write speech that was received but not yet copied onto the session record. */
  private commitInFlightSpeech(): void {
    if (!this.session) return;
    const partial = this.pendingUserPartial.trim();
    if (partial && partial !== this.lastUserAsrPushed) {
      this.pushTranscript(
        { role: "user", text: partial, at: new Date().toISOString() },
        false
      );
    }
    this.pendingUserPartial = "";
    const assistant = this.assistantBuffer.trim();
    if (assistant) {
      this.pushTranscript(
        { role: "assistant", text: assistant, at: new Date().toISOString() },
        false
      );
      this.assistantBuffer = "";
    }
  }

  private replaceTranscriptText(index: number, text: string, checkpoint: boolean): boolean {
    if (!this.session) return false;
    const line = this.session.transcript[index];
    if (!line || !text) return false;
    const nextTotal = this.transcriptChars - line.text.length + text.length;
    if (
      nextTotal >
      VOICE_LIVE_TRANSCRIPT_LIMITS.maxTotalChars - TRANSCRIPT_LIMIT_TERMINAL_TEXT.length
    ) {
      this.endForTranscriptLimit();
      return false;
    }
    const nextTranscript = this.session.transcript.map((row, rowIndex) =>
      rowIndex === index ? { ...row, text } : row
    );
    if (this.formattedTranscriptExceedsDisk(nextTranscript)) {
      this.endForTranscriptLimit();
      return false;
    }
    this.sessionPersisted = false;
    this.transcriptChars = nextTotal;
    line.text = text;
    this.emit("voice:transcript", { ...line, replaceIndex: index });
    if (checkpoint) this.scheduleCheckpoint();
    return true;
  }

  private endForTranscriptLimit(): void {
    if (this.transcriptLimitTriggered || !this.session) return;
    this.transcriptLimitTriggered = true;
    const line: TranscriptLine = {
      role: "system",
      text: TRANSCRIPT_LIMIT_TERMINAL_TEXT,
      at: new Date().toISOString(),
    };
    this.sessionPersisted = false;
    this.session.transcript.push(line);
    this.transcriptChars += line.text.length;
    this.emit("voice:transcript", line);
    this.terminateTransport(
      "Transcript safety limit reached. The session was ended before additional testimony could be silently dropped."
    );
  }

  isActive(): boolean {
    // CONNECTING also needs close/delete guards so before-quit can cancel the
    // handshake through stop() instead of letting it linger until timeout.
    return Boolean(
      this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    );
  }

  /** In-memory session present (may or may not still have a live socket). */
  hasSession(): boolean {
    return Boolean(this.session);
  }

  /** Exit guards care about unsaved testimony, not an optional report still finalizing. */
  hasUnsavedSession(): boolean {
    return Boolean(this.session && !this.sessionPersisted);
  }

  /**
   * Minimal renderer-safe lifecycle state. This deliberately excludes mutable
   * transcript content, credentials, socket details, and filesystem paths.
   */
  getStateSnapshot(): VoiceSessionStateSnapshot {
    const session = this.session;
    return Object.freeze({
      active: this.isActive(),
      hasSession: Boolean(session),
      hasUnsavedSession: Boolean(session && !this.sessionPersisted),
      matterId: session?.matterId ?? this.matter?.id ?? null,
      sessionId: session?.id ?? null,
    });
  }

  private clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongDeadline();
  }

  private clearPongDeadline(ws?: WebSocket): void {
    if (ws && this.pongTimerSocket !== ws) return;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.pongTimerSocket = null;
  }

  private clearCheckpointTimer(ownerEpoch?: number): void {
    if (!this.checkpointTimer) return;
    if (ownerEpoch !== undefined && this.checkpointTimerOwnerEpoch !== ownerEpoch) {
      return;
    }
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    this.checkpointTimerOwnerEpoch = null;
  }

  /**
   * Persist only if the same session still owns the manager. A failed live write
   * never discards the in-memory transcript; the next final row or stop retries it.
   */
  private persistCheckpoint(ownerEpoch: number, session: SessionRecord): boolean {
    if (
      this.ownerEpoch !== ownerEpoch ||
      this.epoch !== ownerEpoch ||
      this.session !== session
    ) {
      return false;
    }

    this.clearCheckpointTimer(ownerEpoch);
    this.sessionPersisted = false;
    try {
      saveSession(session);
      if (
        this.ownerEpoch === ownerEpoch &&
        this.epoch === ownerEpoch &&
        this.session === session
      ) {
        this.sessionPersisted = true;
      }
      return true;
    } catch (err) {
      if (
        this.ownerEpoch === ownerEpoch &&
        this.epoch === ownerEpoch &&
        this.session === session
      ) {
        this.sessionPersisted = false;
        this.emit("voice:error", {
          message: `Live session checkpoint failed; testimony remains in memory and will be retried: ${publicErrorMessage(err)}`,
        });
      }
      return false;
    }
  }

  private scheduleCheckpoint(): void {
    const ownerEpoch = this.ownerEpoch;
    const session = this.session;
    if (ownerEpoch === null || !session || this.epoch !== ownerEpoch) return;

    this.sessionPersisted = false;
    this.clearCheckpointTimer(ownerEpoch);
    this.checkpointTimerOwnerEpoch = ownerEpoch;
    const timer = setTimeout(() => {
      // A cleared callback can already be queued. Match both owner and handle so
      // it cannot consume a newer debounce timer from the same live session.
      if (
        this.checkpointTimerOwnerEpoch !== ownerEpoch ||
        this.checkpointTimer !== timer
      ) {
        return;
      }
      this.checkpointTimer = null;
      this.checkpointTimerOwnerEpoch = null;
      if (
        this.ownerEpoch !== ownerEpoch ||
        this.epoch !== ownerEpoch ||
        this.session !== session
      ) {
        return;
      }
      this.persistCheckpoint(ownerEpoch, session);
    }, SESSION_CHECKPOINT_DEBOUNCE_MS);
    this.checkpointTimer = timer;
  }

  private startPing(ws: WebSocket) {
    this.clearPing();
    ws.on("pong", () => {
      if (this.ws === ws) this.clearPongDeadline(ws);
    });
    // Keep the connection warm; some paths idle-close without traffic.
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.clearPing();
        return;
      }
      this.clearPongDeadline();
      this.pongTimerSocket = ws;
      this.pongTimer = setTimeout(() => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.pongTimer = null;
        this.pongTimerSocket = null;
        this.terminateTransport(
          "Voice connection stopped responding to keepalive pings. The session was ended to preserve its accepted transcript."
        );
      }, VOICE_PONG_TIMEOUT_MS);
      try {
        ws.ping();
      } catch (err) {
        this.clearPongDeadline(ws);
        this.terminateTransport(
          `Voice keepalive failed. The session was ended: ${publicErrorMessage(err)}`
        );
      }
    }, VOICE_PING_INTERVAL_MS);
  }

  private detachSocket(ws: WebSocket | null) {
    this.clearPing();
    if (!ws) return;
    try {
      retireSocketListeners(ws);
    } catch {
      /* ignore */
    }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    } catch {
      /* ignore */
    }
  }

  private terminateTransport(reason: string): void {
    void this.handleUnexpectedDisconnect(reason).catch((err) => {
      console.error("[voice] terminal transport cleanup failed", err);
      this.emit("voice:error", {
        message: `Voice transport cleanup failed: ${publicErrorMessage(err)}`,
      });
    });
  }

  private safeSend(payload: unknown, terminalReason?: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if ((this.ws.bufferedAmount || 0) > VOICE_TRANSPORT_LIMITS.maxBufferedSendBytes) {
      console.warn("[voice] dropping send while websocket backpressure is high");
      if (terminalReason) this.terminateTransport(terminalReason);
      return false;
    }
    try {
      this.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error("[voice] send failed", err);
      if (terminalReason) {
        this.terminateTransport(`${terminalReason} ${publicErrorMessage(err)}`);
      }
      return false;
    }
  }

  /** Clear shared session data only when it still belongs to the given lifecycle. */
  private clearOwnedState(ownerEpoch: number | null): void {
    if (ownerEpoch === null || this.ownerEpoch !== ownerEpoch) return;
    this.clearCheckpointTimer(ownerEpoch);
    this.session = null;
    this.matter = null;
    this.persona = null;
    this.baseInstructions = "";
    this.lastRetrievedQuestion = "";
    this.transcriptChars = 0;
    this.transcriptLimitTriggered = false;
    this.sessionPersisted = false;
    this.pendingOpening = null;
    this.ownerEpoch = null;
  }

  async start(setup: {
    matterId: string;
    personaId: string;
    mode: ExamMode;
    voice?: string;
  }): Promise<SessionRecord> {
    // A report finalization may retain the old session for before-quit. Never let a
    // new start reuse those mutable slots until that one shared stop has completed.
    if (this.stopPromise) await this.stopPromise;
    if (this.ws || this.session || this.connectAttempt) await this.stop(false);

    const settings = loadSettings();
    if (!settings.xaiApiKey) {
      throw new Error("Set your xAI API key in Settings (or XAI_API_KEY env).");
    }

    const matter = getMatter(setup.matterId);
    if (!matter) throw new Error("Matter not found");
    const persona = listPersonas(setup.matterId).find((p) => p.id === setup.personaId);
    if (!persona) throw new Error("Persona not found");

    const index = loadIndex(setup.matterId);
    if (!index.documents.length || !index.chunks.length) {
      throw new Error(
        "No indexed case documents for this matter. Import files and click Reindex before examining."
      );
    }

    const { dossier, docCount, chunkCount, excerptCount } = buildSessionDossier(
      setup.matterId,
      persona,
      setup.mode
    );
    const baseInstructions = buildSessionInstructions(matter, persona, setup.mode, dossier);

    const apiKey = settings.xaiApiKey.trim();
    if (!apiKey.startsWith("xai-")) {
      throw new Error(
        "API key looks invalid (expected xai-…). Import it again in Settings or set XAI_API_KEY."
      );
    }

    // Build session record but assign only after the socket opens (avoids phantom empty sessions).
    const pendingSession: SessionRecord = {
      id: uuid(),
      matterId: matter.id,
      personaId: persona.id,
      personaName: persona.fullName.slice(0, 200),
      mode: setup.mode,
      startedAt: new Date().toISOString(),
      transcript: [],
    };

    const epoch = ++this.epoch;
    this.ownerEpoch = epoch;
    this.baseInstructions = baseInstructions;
    this.matter = matter;
    this.persona = persona;
    this.assistantBuffer = "";
    this.pendingUserPartial = "";
    this.speechStartedDuringResponse = false;
    this.lastRetrievedQuestion = "";
    this.lastUserAsrPushed = "";
    this.currentUserAsrLineIndex = null;
    this.forceNewUserUtterance = true;
    this.handledCallIds.clear();
    this.intentionalStop = false;
    this.finalizing = false;
    this.responseInProgress = false;
    this.pendingRetrieval = null;
    this.pendingOpening = null;
    this.clearPing();

    const url = `wss://api.x.ai/v1/realtime?model=${VOICE_MODEL}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      maxPayload: VOICE_TRANSPORT_LIMITS.maxPayloadBytes,
    });
    this.ws = ws;
    const attempt: ConnectAttempt = {
      epoch,
      ws,
      cancel: () => {
        /* assigned synchronously inside the handshake promise */
      },
    };
    this.connectAttempt = attempt;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const t = setTimeout(() => {
          finish(new Error("Voice connection timeout"));
        }, 20000);

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          // Drop listeners before teardown so terminate() does not emit a second
          // "WebSocket was closed before the connection was established" as the user-facing error.
          try {
            retireSocketListeners(ws);
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve();
        };

        // stop() calls this before removing listeners/terminating the socket, so a
        // cancelled start rejects immediately instead of waiting for its 20s timer.
        attempt.cancel = (reason = new Error("Voice connection cancelled")) => finish(reason);

        ws.once("open", () => finish());

        // Prefer HTTP status/body over the generic "closed before established" error
        // that `ws` often emits after a failed upgrade.
        ws.once("unexpected-response", (_req, res) => {
          const chunks: Buffer[] = [];
          let collectedBytes = 0;
          res.on("data", (chunk: Buffer) => {
            if (collectedBytes >= VOICE_TRANSPORT_LIMITS.maxHandshakeErrorBytes) return;
            const remaining = VOICE_TRANSPORT_LIMITS.maxHandshakeErrorBytes - collectedBytes;
            const bounded = chunk.subarray(0, remaining);
            chunks.push(bounded);
            collectedBytes += bounded.length;
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8").slice(0, 500);
            const hint =
              res.statusCode === 401 || res.statusCode === 403
                ? " Check API key in Settings / XAI_API_KEY and that Voice is enabled on the key."
                : res.statusCode === 400
                  ? " Often a bad/expired key, billing hold, or model access issue."
                  : "";
            finish(
              new Error(
                `Voice API rejected connection (HTTP ${res.statusCode}).${hint}${
                  body ? ` Server: ${body}` : ""
                }`
              )
            );
          });
          res.on("error", () => {
            finish(
              new Error(
                `Voice API rejected connection (HTTP ${res.statusCode || "unknown"}). Check API key and billing.`
              )
            );
          });
        });

        ws.once("error", (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          // If unexpected-response is still draining the body, ignore this follow-on.
          if (settled) return;
          if (/closed before the connection was established/i.test(msg)) {
            finish(
              new Error(
                "Voice connection closed during handshake (often bad API key, no voice access, or billing). Re-check Settings / XAI_API_KEY."
              )
            );
            return;
          }
          if (/Unexpected server response:\s*(\d+)/i.test(msg)) {
            const code = msg.match(/Unexpected server response:\s*(\d+)/i)?.[1] ?? "?";
            finish(
              new Error(
                `Voice API rejected connection (HTTP ${code}). Check API key, voice access, and billing at console.x.ai.`
              )
            );
            return;
          }
          finish(err instanceof Error ? err : new Error(msg));
        });
      });
    } catch (err) {
      if (this.ws === ws) this.ws = null;
      // Socket already failed; terminate quietly without re-throwing close races
      try {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.terminate();
        }
      } catch {
        /* ignore */
      }
      this.clearOwnedState(epoch);
      throw err;
    } finally {
      if (this.connectAttempt === attempt) this.connectAttempt = null;
    }

    if (epoch !== this.epoch || this.ownerEpoch !== epoch || this.ws !== ws) {
      // Do not call detachSocket here: a newer session may already own the global
      // ping timer. This stale socket has no post-handshake listeners yet.
      try {
        retireSocketListeners(ws);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        /* ignore */
      }
      if (this.ws === ws) this.ws = null;
      this.clearOwnedState(epoch);
      throw new Error("Voice session superseded during connect");
    }

    this.session = pendingSession;
    this.transcriptChars = pendingSession.transcript.reduce(
      (total, line) => total + line.text.length,
      0
    );
    this.transcriptLimitTriggered = false;
    this.sessionPersisted = false;

    const keyterms = transcriptionKeyterms(persona, matter);

    const sessionConfigured = this.safeSend({
      type: "session.update",
      session: {
        // Prefer: session override → persona voice → app default
        voice:
          setup.voice ||
          persona.voice ||
          settings.defaultVoice ||
          "eve",
        instructions: VoiceSessionManager.composeInstructions(this.baseInstructions),
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 700,
          threshold: 0.8,
        },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: "grok-transcribe",
              keyterms,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
          },
        },
        tools: [
          {
            type: "function",
            name: "search_case_record",
            description:
              "Search the local case file for relevant passages. Use when the dossier does not cover the topic.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query",
                },
                witnessName: {
                  type: "string",
                  description: "Optional witness name filter",
                },
                docType: {
                  type: "string",
                  description: "Optional filter: deposition, exhibit, pleading, affidavit, timeline",
                },
                maxResults: { type: "number", description: "Maximum passages to return" },
              },
              required: ["query"],
            },
          },
          {
            type: "function",
            name: "get_document_excerpt",
            description: "Get excerpts from a document by file name or document id.",
            parameters: {
              type: "object",
              properties: {
                fileName: {
                  type: "string",
                  description: "Document file name",
                },
                documentId: {
                  type: "string",
                  description: "Indexed document id",
                },
                query: { type: "string", description: "Optional topic to focus excerpts" },
              },
              required: ["fileName"],
            },
          },
          {
            type: "function",
            name: "get_prior_testimony",
            description: "Find prior testimony or statements by this witness on a topic.",
            parameters: {
              type: "object",
              properties: {
                witnessName: {
                  type: "string",
                  description: "Witness whose prior statements to search",
                },
                topic: { type: "string", description: "Optional topic filter" },
              },
              required: ["witnessName"],
            },
          },
        ],
      },
    });
    if (!sessionConfigured) {
      this.detachSocket(ws);
      if (this.ws === ws) this.ws = null;
      this.clearOwnedState(epoch);
      throw new Error("Voice socket opened but session configuration could not be sent.");
    }

    // Establish a recoverable record before any testimony is taken. saveSession
    // uses the app's atomic JSON path; failure is surfaced but does not kill the
    // live session, whose in-memory record remains available for a later retry.
    this.persistCheckpoint(epoch, pendingSession);

    const modeLabel = isHearingMode(setup.mode) ? "hearing bench book" : "witness dossier";
    this.pushTranscript({
      role: "system",
      text: `[Case file loaded] ${docCount} documents, ${chunkCount} chunks, ${excerptCount} ${modeLabel} excerpts for ${persona.fullName}.`,
      at: new Date().toISOString(),
    });
    this.emit("voice:tool", {
      name: isHearingMode(setup.mode) ? "hearing_dossier" : "case_dossier",
      args: { docCount, chunkCount, excerptCount, mode: setup.mode },
      resultCount: excerptCount,
    });

    // Handlers close over epoch + ws identity — late events from this socket after
    // stop()/epoch bump are ignored even if listeners somehow still fire.
    ws.on("message", (data) => {
      if (epoch !== this.epoch || this.ws !== ws) return;
      void this.onMessage(data.toString()).catch((err) => {
        console.error("[voice] onMessage failed", err);
        this.emit("voice:error", {
          message: `Voice handler error: ${publicErrorMessage(err)}`,
        });
      });
    });
    ws.on("close", (code, reasonBuf) => {
      if (epoch !== this.epoch) return;
      this.clearPing();
      if (this.intentionalStop) {
        this.emit("voice:status", { status: "closed" });
        return;
      }
      const reasonText = Buffer.isBuffer(reasonBuf)
        ? reasonBuf.toString("utf8")
        : String(reasonBuf || "");
      console.warn("[voice] unexpected close", { code, reason: reasonText });
      const detail =
        code || reasonText
          ? `Connection to voice service lost (code ${code}${reasonText ? `: ${reasonText}` : ""}).`
          : "Connection to voice service lost.";
      void this.handleUnexpectedDisconnect(detail);
    });
    ws.on("error", (err) => {
      if (epoch !== this.epoch || this.ws !== ws) return;
      console.error("[voice] socket error", err);
      this.emit("voice:error", { message: publicErrorMessage(err) });
    });
    this.startPing(ws);

    // Opening: witness oath affirmation OR court calls hearing to order.
    // xAI acknowledges session.update with session.updated; speaking before
    // that (force_message / response.create) can 500 the turn.
    this.pushTranscript({
      role: "system",
      text: sessionOpeningTranscript(setup.mode, matter, persona),
      at: new Date().toISOString(),
    });
    const opening = sessionOpeningSpoken(setup.mode, matter, persona);
    this.pushTranscript({
      role: "assistant",
      text: opening,
      at: new Date().toISOString(),
    });

    if (isHearingMode(setup.mode)) {
      this.pushTranscript({
        role: "system",
        text: `[Record] Hearing practice. The Court will examine counsel. Answer as the attorney; the judge will press you.`,
        at: new Date().toISOString(),
      });
    } else {
      this.pushTranscript({
        role: "system",
        text: `[Record] ${persona.fullName} is sworn. Counsel may proceed with examination.`,
        at: new Date().toISOString(),
      });
    }
    this.pendingOpening = {
      spoken: opening,
      askFirstHearingQuestion: isHearingMode(setup.mode),
    };

    this.emit("voice:status", { status: "open", sessionId: this.session.id });
    return this.session;
  }

  appendAudio(base64Pcm: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (typeof base64Pcm !== "string" || !base64Pcm) return;
    // ScriptProcessor frames are small; reject pathological IPC payloads (DoS / stall).
    // ~120k base64 ≈ 90KB PCM ≈ ~1.9s mono 24kHz 16-bit — well above one audio callback.
    if (base64Pcm.length > 120_000) {
      console.warn("[voice] dropping oversized audio frame", base64Pcm.length);
      return;
    }
    this.safeSend(
      {
        type: "input_audio_buffer.append",
        audio: base64Pcm,
      },
      "Live audio stopped because the outbound voice queue exceeded its safety limit. Check the network connection, then start a new session."
    );
  }

  /** Normalize for comparing cumulative ASR revisions (ignore punct / case / spacing). */
  private normalizeAsr(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** True when b looks like the same spoken turn as a (extension or in-place revision). */
  private isSameUtterance(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = this.normalizeAsr(a);
    const nb = this.normalizeAsr(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // Cumulative extension either direction (ASR may rewrite earlier words)
    if (na.startsWith(nb) || nb.startsWith(na)) return true;
    // Shared prefix — enough to treat as one evolving question
    const minLen = Math.min(na.length, nb.length);
    let shared = 0;
    while (shared < minLen && na[shared] === nb[shared]) shared += 1;
    if (shared >= 16) return true;
    // Word-level: first 3+ content words match
    const wa = na.split(" ").filter((w) => w.length > 1);
    const wb = nb.split(" ").filter((w) => w.length > 1);
    if (wa.length >= 2 && wb.length >= 2) {
      const n = Math.min(3, wa.length, wb.length);
      if (wa.slice(0, n).join(" ") === wb.slice(0, n).join(" ")) return true;
    }
    return false;
  }

  /**
   * Schedule retrieval for counsel's question. Never session.update while a model
   * response is in flight — that is a common cause of mid-exam socket drops.
   */
  private injectRetrieval(question: string) {
    const q = question.trim();
    if (q.length < 8) return;

    if (this.responseInProgress) {
      this.pendingRetrieval = q;
      return;
    }
    this.applyRetrieval(q);
  }

  private flushPendingRetrieval() {
    if (!this.pendingRetrieval || this.responseInProgress) return;
    const q = this.pendingRetrieval;
    this.pendingRetrieval = null;
    this.applyRetrieval(q);
  }

  private applyRetrieval(question: string) {
    if (!this.ws || !this.matter || !this.persona || this.ws.readyState !== WebSocket.OPEN) return;
    const q = question.trim();
    if (q.length < 8) return;

    // Same query, or only a trivial extension of the last retrieval → skip
    if (this.lastRetrievedQuestion) {
      if (this.normalizeAsr(q) === this.normalizeAsr(this.lastRetrievedQuestion)) return;
      if (this.isSameUtterance(this.lastRetrievedQuestion, q)) {
        const prev = this.normalizeAsr(this.lastRetrievedQuestion);
        const next = this.normalizeAsr(q);
        if (next.length - prev.length < 16 && next.startsWith(prev.slice(0, Math.min(12, prev.length)))) {
          return;
        }
      }
    }

    const refreshingSameTurn =
      Boolean(this.lastRetrievedQuestion) && this.isSameUtterance(this.lastRetrievedQuestion, q);
    this.lastRetrievedQuestion = q;

    const { text, hitCount } = retrieveForQuestion(
      this.matter.id,
      this.persona,
      q,
      this.session?.mode ?? "cross"
    );

    const retrievalBlock = `

===== BEGIN RETRIEVED CASE RECORD (current question) =====
${text}
===== END RETRIEVED CASE RECORD =====`;
    const instructions = VoiceSessionManager.composeInstructions(
      this.baseInstructions,
      retrievalBlock
    );

    if (
      !this.safeSend({
        type: "session.update",
        session: { instructions },
      })
    ) {
      return;
    }

    this.emit("voice:tool", {
      name: "auto_retrieve",
      args: { query: q },
      resultCount: hitCount,
    });

    const searchLine = `[Record search] ${hitCount} passage(s) for: "${q.slice(0, 120)}${
      q.length > 120 ? "…" : ""
    }"`;

    // One system line per question: replace prior [Record search] for this turn
    if (refreshingSameTurn && this.session) {
      for (let i = this.session.transcript.length - 1; i >= 0; i--) {
        const line = this.session.transcript[i]!;
        if (line.role === "system" && line.text.startsWith("[Record search]")) {
          this.replaceTranscriptText(i, searchLine, false);
          return;
        }
        if (line.role === "assistant") break;
      }
    }

    this.pushTranscript({
      role: "system",
      text: searchLine,
      at: new Date().toISOString(),
    });
  }

  /** Update or create the single transcript line for the current cumulative user ASR. */
  private upsertUserAsrLine(text: string, finalized: boolean) {
    if (!this.session) return;
    text = boundedTranscriptText(text);
    if (!text) return;
    if (!this.forceNewUserUtterance && text === this.lastUserAsrPushed) {
      // A completed event commonly repeats the last partial verbatim. It still
      // establishes the durability boundary even though no text changed.
      if (finalized) this.scheduleCheckpoint();
      return;
    }
    this.sessionPersisted = false;

    // Same open utterance — replace in place (even if ASR rewrites earlier words)
    if (!this.forceNewUserUtterance && this.currentUserAsrLineIndex !== null) {
      const idx = this.currentUserAsrLineIndex;
      const line = this.session.transcript[idx];
      if (line?.role === "user") {
        if (!this.replaceTranscriptText(idx, text, finalized)) return;
        this.lastUserAsrPushed = text;
        return;
      }
      this.currentUserAsrLineIndex = null;
    }

    // Mid-turn "completed" cleared nothing, but index was lost: re-open last user line
    // only when this is still the same turn (not after speech_started).
    if (
      !this.forceNewUserUtterance &&
      this.lastUserAsrPushed &&
      this.isSameUtterance(this.lastUserAsrPushed, text)
    ) {
      for (let i = this.session.transcript.length - 1; i >= 0; i--) {
        const line = this.session.transcript[i]!;
        if (line.role === "user") {
          if (!this.replaceTranscriptText(i, text, finalized)) return;
          this.currentUserAsrLineIndex = i;
          this.lastUserAsrPushed = text;
          return;
        }
        if (line.role === "assistant") break;
      }
    }

    // New utterance
    const line: TranscriptLine = {
      role: "user",
      text,
      at: new Date().toISOString(),
    };
    if (!this.pushTranscript(line, finalized)) return;
    this.currentUserAsrLineIndex = this.session.transcript.length - 1;
    this.lastUserAsrPushed = text;
    this.forceNewUserUtterance = false;
  }

  private flushOpeningAfterSessionUpdated(): void {
    const pending = this.pendingOpening;
    if (!pending?.spoken) return;
    const spoken = pending.spoken;
    this.pendingOpening = pending.askFirstHearingQuestion
      ? { spoken: "", askFirstHearingQuestion: true }
      : null;
    this.safeSend({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible: false,
        content: [{ type: "output_text", text: spoken }],
      },
    });
  }

  private flushHearingLeadAfterOpening(): void {
    if (!this.pendingOpening?.askFirstHearingQuestion) return;
    this.pendingOpening = null;
    this.safeSend({
      type: "response.create",
      response: {
        instructions:
          "As the presiding judge, ask counsel your first substantive question based on the case file. One clear, hard question. Do not restate the call to order.",
      },
    });
  }

  private async onMessage(raw: string) {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case "session.updated": {
        this.flushOpeningAfterSessionUpdated();
        break;
      }
      case "response.created": {
        // The previous response never delivered transcript.done. Keep what was heard.
        this.commitInFlightSpeech();
        this.assistantBuffer = "";
        this.responseInProgress = true;
        this.speechStartedDuringResponse = false;
        break;
      }
      case "response.done": {
        const status =
          typeof event.response?.status === "string" ? event.response.status : "completed";
        const bargeIn = this.speechStartedDuringResponse;
        this.responseInProgress = false;
        this.speechStartedDuringResponse = false;
        // A finished answer must not leak its late transcript into the next
        // question. A barge-in, or a response that did not complete, still owns
        // the question that was queued during this turn.
        if (status !== "completed" || bargeIn) this.flushPendingRetrieval();
        else this.pendingRetrieval = null;
        this.flushHearingLeadAfterOpening();
        break;
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (isSafePcmBase64(event.delta)) {
          this.emit("voice:audio", { delta: event.delta });
        }
        break;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (typeof event.delta === "string" && event.delta) {
          const remaining =
            VOICE_TRANSPORT_LIMITS.maxTranscriptBufferChars - this.assistantBuffer.length;
          if (remaining > 0) this.assistantBuffer += event.delta.slice(0, remaining);
        }
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const suppliedTranscript =
          typeof event.transcript === "string" ? event.transcript : "";
        const text = boundedTranscriptText(suppliedTranscript || this.assistantBuffer);
        this.assistantBuffer = "";
        // force_message / opening already written — don't duplicate "I do."
        if (text) {
          // Procedural system rows may follow the force_message in our local
          // transcript. Compare the most recent spoken row, not merely the tail.
          let lastSpoken: TranscriptLine | undefined;
          for (let index = (this.session?.transcript.length ?? 0) - 1; index >= 0; index -= 1) {
            const line = this.session?.transcript[index];
            if (line?.role === "system") continue;
            lastSpoken = line;
            break;
          }
          if (lastSpoken?.role === "assistant" && lastSpoken.text === text) break;
          this.pushTranscript({
            role: "assistant",
            text,
            at: new Date().toISOString(),
          });
        }
        // Witness is answering — next counsel ASR is a new question
        this.currentUserAsrLineIndex = null;
        this.forceNewUserUtterance = true;
        break;
      }
      case "input_audio_buffer.speech_started": {
        // New user speech turn — next ASR opens a new counsel line (not a revise of the last Q)
        if (this.responseInProgress) this.speechStartedDuringResponse = true;
        this.currentUserAsrLineIndex = null;
        this.forceNewUserUtterance = true;
        this.emit("voice:barge-in");
        break;
      }
      case "response.cancelled":
      case "response.cancel": {
        this.assistantBuffer = "";
        this.responseInProgress = false;
        this.emit("voice:barge-in");
        this.flushPendingRetrieval();
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.input_audio_transcription.updated": {
        // xAI often emits cumulative "updated" rather than a single "completed"
        const text = boundedTranscriptText(event.transcript);
        if (!text) break;

        const isCompleted = event.type.endsWith("completed");
        this.pendingUserPartial = text;

        // Live transcript: coalesce all partials/revisions into one counsel line.
        // Shorter partials stay in pendingUserPartial until completion or stop.
        if (isCompleted || text.length >= 8) {
          this.upsertUserAsrLine(text, isCompleted);
          this.pendingUserPartial = "";
        }

        // Retrieval only on completed finals — not every partial (avoids spam + bad mid-phrase queries)
        if (isCompleted && text.length >= 8) {
          this.injectRetrieval(text);
        }
        // Do NOT clear currentUserAsrLineIndex on completed — xAI may emit another
        // completed/updated for the same turn ("damages?" → "damages in this?").
        // Index is cleared on speech_started / assistant transcript instead.
        break;
      }
      case "response.function_call_arguments.done": {
        await this.handleFunctionCall(event);
        break;
      }
      case "response.output_item.done": {
        // Some stacks nest function calls here
        const item = event.item;
        if (item && (item.type === "function_call" || item.name)) {
          await this.handleFunctionCall({
            type: "response.function_call_arguments.done",
            name: item.name,
            call_id: item.call_id,
            arguments: item.arguments,
          });
        }
        break;
      }
      case "error": {
        this.assistantBuffer = "";
        this.pendingOpening = null;
        const code = typeof event.error?.code === "string" ? event.error.code : "";
        const type = typeof event.error?.type === "string" ? event.error.type : "";
        const msg =
          typeof event.error?.message === "string"
            ? event.error.message.slice(0, 2_000)
            : raw.slice(0, 2_000);
        const detail = [code && `code=${code}`, type && `type=${type}`].filter(Boolean).join(" ");
        console.error("[voice] server error event", detail, msg);
        this.emit("voice:error", { message: detail ? `${msg} (${detail})` : msg });
        // Some server errors precede a close; keep response state consistent
        this.responseInProgress = false;
        this.pendingRetrieval = null;
        break;
      }
      default:
        break;
    }
  }

  private async handleFunctionCall(event: ServerEvent) {
    if (!this.ws || !this.matter || !this.session) return;
    const rawName = typeof event.name === "string" ? event.name : "";
    const name =
      rawName.length <= 80 && !/[\u0000-\u001f\u007f]/.test(rawName) ? rawName : "";
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    if (
      !callId ||
      callId.length > VOICE_TRANSPORT_LIMITS.maxToolCallIdChars ||
      /[\u0000-\u001f\u007f]/.test(callId)
    ) {
      this.emit("voice:error", { message: "Ignored a malformed voice tool call identifier." });
      return;
    }
    if (this.handledCallIds.has(callId)) return;
    if (this.handledCallIds.size >= 1_024) {
      const oldest = this.handledCallIds.values().next().value as string | undefined;
      if (oldest) this.handledCallIds.delete(oldest);
    }
    this.handledCallIds.add(callId);

    let args: Record<string, unknown> = {};
    let argumentError: string | null = null;
    try {
      args = parseToolArguments(event.arguments ?? "{}");
    } catch (err) {
      argumentError = publicErrorMessage(err);
    }

    let output: unknown = argumentError
      ? { error: `Invalid tool arguments: ${argumentError}` }
      : { error: "unknown tool" };
    try {
      if (argumentError) {
        // Keep the structured parse error above and do not call any service.
      } else if (name === "search_case_record") {
        assertToolKeys(args, ["query", "witnessName", "docType", "maxResults"]);
        const query = toolText(args, "query", SEARCH_INPUT_LIMITS.toolQueryChars, {
          required: true,
        })!;
        const witnessName = toolText(
          args,
          "witnessName",
          SEARCH_INPUT_LIMITS.witnessNameChars
        );
        const docType = toolText(args, "docType", SEARCH_INPUT_LIMITS.docTypeChars);
        if (docType && !TOOL_DOCUMENT_TYPES.has(docType.toLowerCase())) {
          throw new Error("docType is invalid");
        }
        output = searchCaseRecord(this.matter.id, query, {
          maxResults: toolMaxResults(args),
          witnessName,
          docType,
          requireQuery: true,
        });
      } else if (name === "get_document_excerpt") {
        assertToolKeys(args, ["documentId", "fileName", "query"]);
        const documentId = toolText(args, "documentId", 36);
        const fileName = toolText(args, "fileName", SEARCH_INPUT_LIMITS.fileNameChars);
        const query = toolText(args, "query", SEARCH_INPUT_LIMITS.toolQueryChars);
        if (!documentId && !fileName) throw new Error("documentId or fileName is required");
        if (documentId && !TOOL_DOCUMENT_ID_RE.test(documentId)) {
          throw new Error("documentId is invalid");
        }
        output = getDocumentExcerpt(this.matter.id, {
          documentId,
          fileName,
          query,
        });
      } else if (name === "get_prior_testimony") {
        assertToolKeys(args, ["witnessName", "topic"]);
        const witnessName = toolText(
          args,
          "witnessName",
          SEARCH_INPUT_LIMITS.witnessNameChars,
          { required: true }
        )!;
        const topic = toolText(args, "topic", SEARCH_INPUT_LIMITS.toolQueryChars);
        output = getPriorTestimony(this.matter.id, {
          witnessName,
          topic,
        });
      }
    } catch (err) {
      output = { error: publicErrorMessage(err) };
    }

    const resultCount = Array.isArray(output) ? output.length : 1;
    this.emit("voice:tool", { name, args: boundedToolActivity(args), resultCount });
    if (!this.pushTranscript({
      role: "system",
      text: `[Tool] ${name} → ${resultCount} result(s)`,
      at: new Date().toISOString(),
    })) return;

    const outputStr = serializeToolOutput(output);

    if (
      !this.safeSend({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: outputStr,
        },
      })
    ) {
      return;
    }
    this.responseInProgress = true;
    this.safeSend({ type: "response.create" });
  }

  /**
   * Unexpected socket death: synchronously flush what we have (no report), then
   * notify UI so mic cleanup can run. A failed JSON flush deliberately retains
   * ownership and the in-memory record so stop()/shutdown can retry it.
   */
  private async handleUnexpectedDisconnect(reason: string) {
    if (this.finalizing || this.intentionalStop) return;
    this.finalizing = true;
    this.commitInFlightSpeech();
    const ownerEpoch = this.ownerEpoch;
    const disconnectedSession = this.session;
    const disconnectedMatter = this.matter;
    const disconnectedPersona = this.persona;
    this.epoch += 1;
    if (ownerEpoch !== null) this.clearCheckpointTimer(ownerEpoch);

    const ws = this.ws;
    this.ws = null;
    this.detachSocket(ws);

    this.lastUserAsrPushed = "";
    this.currentUserAsrLineIndex = null;
    this.forceNewUserUtterance = true;
    this.handledCallIds.clear();
    this.responseInProgress = false;
    this.pendingRetrieval = null;

    this.emit("voice:error", { message: reason });

    try {
      if (!disconnectedSession || !disconnectedMatter || !disconnectedPersona) {
        this.emit("voice:status", {
          status: "disconnected",
          ...terminalResult(null),
        });
        this.clearOwnedState(ownerEpoch);
        return;
      }

      disconnectedSession.endedAt = new Date().toISOString();
      this.sessionPersisted = false;
      try {
        saveSession(disconnectedSession);
      } catch (err) {
        this.emit("voice:error", {
          message: `Failed to save after disconnect; testimony remains in memory for retry: ${publicErrorMessage(err)}`,
        });
        this.emit("voice:status", {
          status: "disconnected",
          reason,
          ...terminalResult(disconnectedSession, { needsSaveRetry: true }),
        });
        return;
      }
      this.sessionPersisted = true;

      let transcriptPath: string | undefined;
      try {
        transcriptPath = writeTranscriptMarkdown(
          disconnectedSession,
          disconnectedMatter,
          disconnectedPersona
        );
      } catch (err) {
        // The JSON record is already durable and reviewable; Markdown is optional.
        this.emit("voice:error", {
          message: `Session saved, but transcript export failed: ${publicErrorMessage(err)}`,
        });
      }
      const result = terminalResult(disconnectedSession, {
        canOpenTranscript: Boolean(transcriptPath),
      });
      this.emit("voice:status", {
        status: "disconnected",
        reason,
        ...result,
      });
      this.clearOwnedState(ownerEpoch);
    } finally {
      this.finalizing = false;
    }
  }

  stop(generateReport: boolean): Promise<VoiceSessionTerminalResult> {
    if (this.stopPromise) return this.stopPromise;

    const operation = this.stopOwned(generateReport);
    const shared = operation.finally(() => {
      if (this.stopPromise === shared) this.stopPromise = null;
    });
    this.stopPromise = shared;
    return shared;
  }

  private async stopOwned(generateReport: boolean): Promise<VoiceSessionTerminalResult> {
    if (this.finalizing) {
      return terminalResult(null);
    }

    this.intentionalStop = true;
    this.commitInFlightSpeech();
    this.epoch += 1; // invalidate any still-attached handlers immediately

    // Capture every retiring object before any await. Report generation may take
    // two minutes, but it must never read a manager slot that a later start owns.
    const ownerEpoch = this.ownerEpoch;
    const stoppedSession = this.session;
    const stoppedMatter = this.matter;
    const stoppedPersona = this.persona;
    const ws = this.ws;
    const attempt = this.connectAttempt;
    if (ownerEpoch !== null) this.clearCheckpointTimer(ownerEpoch);

    if (attempt) {
      attempt.cancel(new Error("Voice session stopped during connect"));
      if (this.connectAttempt === attempt) this.connectAttempt = null;
    }
    this.ws = null;
    this.detachSocket(ws);

    this.lastUserAsrPushed = "";
    this.currentUserAsrLineIndex = null;
    this.forceNewUserUtterance = true;
    this.handledCallIds.clear();
    this.responseInProgress = false;
    this.pendingRetrieval = null;
    this.clearPing();

    try {
      if (!stoppedSession || !stoppedMatter || !stoppedPersona) {
        this.clearOwnedState(ownerEpoch);
        return terminalResult(null);
      }

      stoppedSession.endedAt = new Date().toISOString();
      this.sessionPersisted = false;
      saveSession(stoppedSession);
      this.sessionPersisted = true;
      let transcriptPath: string | undefined;
      try {
        transcriptPath = writeTranscriptMarkdown(
          stoppedSession,
          stoppedMatter,
          stoppedPersona
        );
      } catch (err) {
        // The bounded JSON record is the durable source of truth. Keep it
        // reviewable when the optional human-readable export cannot be written.
        this.emit("voice:error", {
          message: `Session saved, but transcript export failed: ${publicErrorMessage(err)}`,
        });
      }

      let reportPath: string | undefined;
      let reportMarkdownPath: string | undefined;
      if (generateReport && stoppedSession.transcript.some((t) => t.role !== "system")) {
        try {
          const { reportPath: rp, markdownPath } = await generateSessionReport(
            stoppedSession,
            stoppedMatter,
            stoppedPersona
          );
          reportPath = rp;
          reportMarkdownPath = markdownPath;
          stoppedSession.reportPath = rp;
          saveSession(stoppedSession);
        } catch (err) {
          this.emit("voice:error", {
            message: `Report failed: ${publicErrorMessage(err)}`,
          });
        }
      }

      const result = terminalResult(stoppedSession, {
        canOpenTranscript: Boolean(transcriptPath),
        canOpenReport: Boolean(reportPath && reportMarkdownPath),
      });
      this.emit("voice:status", { status: "ended", ...result });
      this.clearOwnedState(ownerEpoch);
      return result;
    } finally {
      this.intentionalStop = false;
    }
  }
}

export const voiceSessions = new VoiceSessionManager();
