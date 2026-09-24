import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { MicStreamer, PcmPlayer } from "./audio";
import { SessionReviewDrawer, type SessionReviewData } from "./SessionReviewDrawer";
import { voiceLabel, XAI_VOICES } from "./voices";

type View = "matters" | "matter" | "session" | "settings";
type SessionStartPhase = "idle" | "starting" | "cancelling";
type ModalOperation = "create-matter" | "edit-matter" | "persona";

interface Matter {
  id: string;
  caption: string;
  court: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface Persona {
  id: string;
  matterId: string;
  fullName: string;
  role: string;
  attitude: string;
  notes: string;
  keyterms: string[];
  voice: string;
  createdAt: string;
}

interface DocMeta {
  id: string;
  fileName: string;
  docType: string;
  charCount: number;
  pageCount: number;
}

interface SessionListItem {
  id: string;
  personaId: string;
  mode: "cross" | "deposition" | "hearing";
  startedAt: string;
  endedAt?: string;
  unfinished: boolean;
  lineCount: number;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
}

interface ListSessionsResult {
  sessions: SessionListItem[];
  dataErrors: string[];
}

interface VoiceStateSnapshot {
  active: boolean;
  hasSession: boolean;
  hasUnsavedSession: boolean;
  matterId: string | null;
  sessionId: string | null;
}

interface VoiceStopResult {
  session: { id: string; matterId: string } | null;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
  needsSaveRetry: boolean;
}

interface GeneratedSessionReportResult {
  session: { id: string; matterId: string };
  report: NonNullable<SessionReviewData["report"]>;
  canOpenReport: boolean;
  reportDataErrors: string[];
}

type VoiceReconciliationOutcome =
  | { kind: "none"; state: VoiceStateSnapshot }
  | { kind: "saved"; state: VoiceStateSnapshot; result: VoiceStopResult }
  | { kind: "save-failed"; state: VoiceStateSnapshot; error: unknown }
  | { kind: "check-failed"; error: unknown };

interface IndexingIssue {
  fileName: string;
  message: string;
}

interface ReindexResult {
  documents: DocMeta[];
  issues?: IndexingIssue[];
}

interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  packaged: boolean;
}

interface InlineFeedback {
  tone: "success" | "error" | "neutral";
  message: string;
}

type DocumentOperationPhase = "importing" | "indexing" | "cancelling";

interface DocumentOperation {
  request: number;
  matterId: string;
  phase: DocumentOperationPhase;
  importedCount: number;
  removedFileName?: string;
}

interface DocumentRemoval {
  request: number;
  matterId: string;
  documentId: string;
  fileName: string;
}

type DocumentRecovery =
  | {
      matterId: string;
      fileName: string;
      outcome: "removed" | "unknown";
    }
  | {
      matterId: string;
      importedCount: number;
      outcome: "imported";
    }
  | {
      matterId: string;
      outcome: "unavailable";
    };

interface TranscriptLine {
  role: string;
  text: string;
  at: string;
}

type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "cx-theme";
const XAI_PROCESSING_ACK_STORAGE_KEY = "cx-xai-processing-ack-v1";
const MAX_CACHED_GENERATED_REPORTS = 8;
const MATTER_DATA_WARNING_PREFIX =
  "Some matter data could not be refreshed. Available sections remain usable. ";

function documentRecoveryMessage(recovery: DocumentRecovery): string {
  switch (recovery.outcome) {
    case "removed":
      return `“${recovery.fileName}” was removed. Reindex before beginning another practice session.`;
    case "unknown":
      return `The result of removing “${recovery.fileName}” could not be verified. Reindex before beginning another practice session.`;
    case "imported":
      return `${formatFileCount(recovery.importedCount)} ${
        recovery.importedCount === 1 ? "was" : "were"
      } imported, but the refreshed case record could not be verified. Reindex before beginning another practice session.`;
    case "unavailable":
      return "The current case record could not be verified. Reindex before beginning another practice session.";
  }
}

function removeMatterDataWarningSection(
  warning: string | null,
  sectionLabel: string
): string | null {
  if (!warning?.startsWith(MATTER_DATA_WARNING_PREFIX)) return warning;
  const remaining = warning
    .slice(MATTER_DATA_WARNING_PREFIX.length)
    .split(" · ")
    .filter((part) => !part.startsWith(`${sectionLabel}:`));
  return remaining.length ? `${MATTER_DATA_WARNING_PREFIX}${remaining.join(" · ")}` : null;
}

function mergeGeneratedReport(
  review: SessionReviewData,
  generated: GeneratedSessionReportResult
): SessionReviewData {
  const transcriptDataErrors = (review.dataErrors || []).filter(
    (message) => !/report/i.test(message)
  );
  return {
    ...review,
    report: generated.report,
    canOpenReport: generated.canOpenReport,
    dataErrors: [...transcriptDataErrors, ...(generated.reportDataErrors || [])],
  };
}

function readStoredTheme(): ThemeMode {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* private mode / blocked storage */
  }
  return "light";
}

function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

type IconName =
  | "folder"
  | "mic"
  | "settings"
  | "arrow-left"
  | "arrow-right"
  | "upload"
  | "refresh"
  | "user-plus"
  | "play"
  | "document"
  | "sun"
  | "moon";

function AppIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "folder") {
    return <svg {...common}><path d="M3.5 6.5h6l2 2h9v10.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19V6.5Z" /><path d="M3.5 10h17" /></svg>;
  }
  if (name === "mic") {
    return <svg {...common}><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></svg>;
  }
  if (name === "settings") {
    return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4v-4h.09A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.6 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.4h4v.09a1.7 1.7 0 0 0 1 1.71 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.6a1.7 1.7 0 0 0 .6 1c.3.27.7.4 1.1.4h.1v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></svg>;
  }
  if (name === "arrow-left") {
    return <svg {...common}><path d="m14.5 5-7 7 7 7M8 12h12" /></svg>;
  }
  if (name === "arrow-right") {
    return <svg {...common}><path d="m9.5 5 7 7-7 7M16 12H4" /></svg>;
  }
  if (name === "upload") {
    return <svg {...common}><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M4 15v4.5h16V15" /></svg>;
  }
  if (name === "refresh") {
    return <svg {...common}><path d="M19 7V3m0 0h-4M19 3l-3 3a7.5 7.5 0 1 0 2.2 7.8" /></svg>;
  }
  if (name === "user-plus") {
    return <svg {...common}><circle cx="9" cy="8" r="3.5" /><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M18 8v7M14.5 11.5h7" /></svg>;
  }
  if (name === "play") {
    return <svg {...common}><path d="M8 5.5 18 12 8 18.5v-13Z" /></svg>;
  }
  if (name === "sun") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6" />
      </svg>
    );
  }
  if (name === "moon") {
    return <svg {...common}><path d="M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5 7.6 7.6 0 1 0 19.5 14.2Z" /></svg>;
  }
  return <svg {...common}><path d="M6 2.5h8l4 4v15H6v-19Z" /><path d="M14 2.5v4h4M9 12h6M9 16h6" /></svg>;
}

function formatToolActivity(payload: Record<string, unknown>): string {
  const name = String(payload.name || "Case activity");
  const count = Number(payload.resultCount ?? 0);
  const args = payload.args && typeof payload.args === "object"
    ? (payload.args as Record<string, unknown>)
    : {};
  if (name === "case_dossier") return `Witness dossier loaded · ${count} excerpts`;
  if (name === "hearing_dossier") return `Hearing bench book loaded · ${count} excerpts`;
  if (name === "auto_retrieve") {
    const query = String(args.query || "case record");
    return `Record search: “${query}” · ${count} passages`;
  }
  return `${name.replaceAll("_", " ")} · ${count} results`;
}

function hasDesktopApi(): boolean {
  return typeof window !== "undefined" && Boolean(window.api);
}

function readXaiProcessingAcknowledgement(): boolean {
  try {
    return localStorage.getItem(XAI_PROCESSING_ACK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeXaiProcessingAcknowledgement() {
  try {
    localStorage.setItem(XAI_PROCESSING_ACK_STORAGE_KEY, "1");
  } catch {
    /* Keep the acknowledgement for this renderer lifetime when storage is unavailable. */
  }
}

interface ReportGenerationState {
  request: number;
  matterId: string;
  sessionId: string;
  busy: boolean;
  error: string | null;
  status: string | null;
}

function formatIndexingIssues(issues: IndexingIssue[]): string {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issue.fileName}: ${issue.message}`)
    .join(" · ");
  const remaining = issues.length - Math.min(3, issues.length);
  return `Index completed with ${issues.length} warning${issues.length === 1 ? "" : "s"}: ${shown}${
    remaining ? ` · ${remaining} more` : ""
  }`;
}

function formatFileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function formatSessionDate(startedAt: string): string {
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return "Unknown date";
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function sessionOperationKey(matterId: string, sessionId: string): string {
  return `${matterId}:${sessionId}`;
}

/**
 * One transcript line, memoized on primitive props. ASR partials replace a
 * single row object per event; every other row keeps identity, so long live
 * transcripts do not re-render the whole log on each partial.
 */
const TranscriptBubble = memo(function TranscriptBubble({
  role,
  text,
  who,
  lineNo,
  isCurrent,
}: {
  role: string;
  text: string;
  who: string;
  lineNo: number;
  isCurrent: boolean;
}) {
  return (
    <div className={`bubble ${role} ${isCurrent ? "current" : ""}`}>
      <span className="line-no">{lineNo}</span>
      <span className="who">{who}</span>
      <span className="line-copy">{text}</span>
    </div>
  );
});

/** Host slots for live-exam audio resources (owned by startSession). */
type ExamHost = {
  __examCleanup?: () => Promise<void>;
  __examMic?: MicStreamer;
  __examPlayer?: PcmPlayer;
  /** Bumped to invalidate an in-flight start (disconnect / supersede). */
  __examGeneration?: number;
  /** One bootstrap check/stop per renderer document, shared across StrictMode remounts. */
  __examVoiceReconciliation?: Promise<VoiceReconciliationOutcome>;
};

function examHost(): ExamHost {
  return window as unknown as ExamHost;
}

function reconcileRetainedVoiceSession(): Promise<VoiceReconciliationOutcome> {
  const host = examHost();
  if (host.__examVoiceReconciliation) return host.__examVoiceReconciliation;

  const reconciliation = (async (): Promise<VoiceReconciliationOutcome> => {
    let state: VoiceStateSnapshot;
    try {
      state = await window.api.getVoiceState();
    } catch (error) {
      return { kind: "check-failed", error };
    }

    if (!state.active && !state.hasSession && !state.hasUnsavedSession) {
      return { kind: "none", state };
    }

    try {
      const result = (await window.api.stopVoice(false)) as VoiceStopResult;
      return { kind: "saved", state, result };
    } catch (error) {
      return { kind: "save-failed", state, error };
    }
  })();
  host.__examVoiceReconciliation = reconciliation;
  return reconciliation;
}

const MODAL_FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Keep the level meter responsive without committing the full app tree for each PCM frame. */
const MIC_METER_INTERVAL_MS = 120;

interface ModalDialogProps {
  title: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}

/** Own focus and dismissal for the app's editing forms. */
function ModalDialog({
  title,
  submitting,
  error,
  onClose,
  onSubmit,
  children,
}: ModalDialogProps) {
  const titleId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = dialogRef.current?.querySelector<HTMLElement>(
      "[data-dialog-initial-focus]"
    );
    (initial || dialogRef.current?.querySelector<HTMLElement>(MODAL_FOCUSABLE))?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!submitting) onClose();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [onClose, submitting]);

  const trapTab = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE));
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error ? errorId : undefined}
        aria-busy={submitting}
        tabIndex={-1}
        onKeyDown={trapTab}
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitting) onSubmit();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {error && (
          <div id={errorId} className="dialog-error" role="alert">
            {error}
          </div>
        )}
        {children}
      </form>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("matters");
  const [matters, setMatters] = useState<Matter[]>([]);
  const [mattersLoading, setMattersLoading] = useState(() => hasDesktopApi());
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [documentQuery, setDocumentQuery] = useState("");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionReview, setSessionReview] = useState<SessionReviewData | null>(null);
  const [reviewLoadingId, setReviewLoadingId] = useState<string | null>(null);
  const [reportGeneration, setReportGeneration] = useState<ReportGenerationState | null>(null);
  const [sessionArtifactError, setSessionArtifactError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiReady] = useState(() => hasDesktopApi());
  const [busy, setBusy] = useState(false);
  const [documentOperation, setDocumentOperation] = useState<DocumentOperation | null>(null);
  const [documentRemoval, setDocumentRemoval] = useState<DocumentRemoval | null>(null);
  const [documentRecovery, setDocumentRecovery] = useState<DocumentRecovery | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [xaiProcessingAcknowledged, setXaiProcessingAcknowledged] = useState(() =>
    readXaiProcessingAcknowledgement()
  );
  const [showXaiProcessingAcknowledgement, setShowXaiProcessingAcknowledgement] =
    useState(false);
  const [xaiProcessingConsentChecked, setXaiProcessingConsentChecked] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appInfoLoading, setAppInfoLoading] = useState(apiReady);
  const [diagnosticsOpening, setDiagnosticsOpening] = useState(false);
  const [diagnosticsFeedback, setDiagnosticsFeedback] =
    useState<InlineFeedback | null>(null);
  const [keyImporting, setKeyImporting] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [keyImportFeedback, setKeyImportFeedback] = useState<InlineFeedback | null>(null);
  const [keyMeta, setKeyMeta] = useState<{
    hasKey: boolean;
    keyLast4: string;
    keySource: "env" | "stored" | "none";
    encryptionAvailable: boolean;
  }>({ hasKey: false, keyLast4: "", keySource: "none", encryptionAvailable: true });
  const [voice, setVoice] = useState("eve");
  const [showCreateMatter, setShowCreateMatter] = useState(false);
  const [showEditMatter, setShowEditMatter] = useState(false);
  const [showPersona, setShowPersona] = useState(false);
  const [modalOperation, setModalOperation] = useState<ModalOperation | null>(null);
  const [modalError, setModalError] = useState<{
    modal: ModalOperation;
    message: string;
  } | null>(null);
  const [matterDataWarning, setMatterDataWarning] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [court, setCourt] = useState("");
  const [notes, setNotes] = useState("");
  const [personaForm, setPersonaForm] = useState({
    id: "" as string,
    fullName: "",
    role: "",
    attitude: "neutral",
    notes: "",
    keyterms: "",
    voice: "",
  });
  const [sessionPersonaId, setSessionPersonaId] = useState("");
  const [sessionMode, setSessionMode] = useState<"cross" | "deposition" | "hearing">("cross");
  const [sessionVoice, setSessionVoice] = useState("");
  /**
   * Snapshot of the persona/mode the current transcript was actually recorded
   * with. The live practice-form selections may change after a session ends;
   * a saved record must never be relabeled by a later selection.
   */
  const [sessionIdentity, setSessionIdentity] = useState<{
    personaName: string;
    mode: "cross" | "deposition" | "hearing";
  } | null>(null);
  const [live, setLive] = useState(false);
  const [sessionStartPhase, setSessionStartPhase] = useState<SessionStartPhase>("idle");
  const [saveRetryMatterId, setSaveRetryMatterId] = useState<string | null>(null);
  const [retryingRetainedSave, setRetryingRetainedSave] = useState(false);
  const [voiceReconciliationPending, setVoiceReconciliationPending] = useState(apiReady);
  const [voiceReconciliationError, setVoiceReconciliationError] = useState<string | null>(null);
  const [voiceReconciliationAttempt, setVoiceReconciliationAttempt] = useState(0);
  const [activeReportGenerationKeys, setActiveReportGenerationKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [deletingSessionKeys, setDeletingSessionKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [muted, setMuted] = useState(false);
  const [hasMicAudio, setHasMicAudio] = useState(false);
  const [micInfo, setMicInfo] = useState("");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [toolLog, setToolLog] = useState<string[]>([]);
  const [status, setStatus] = useState("idle");
  const [savedArtifacts, setSavedArtifacts] = useState<{
    matterId?: string;
    sessionId?: string;
    canOpenTranscript?: boolean;
    canOpenReport?: boolean;
  }>({});
  const [dataErrors, setDataErrors] = useState<string[]>([]);
  const [sessionDataErrors, setSessionDataErrors] = useState<string[]>([]);
  const documentFilterId = useId();
  const documentFilterStatusId = useId();
  const sessionModeId = useId();
  const sessionPersonaIdControl = useId();
  const sessionVoiceId = useId();
  const appearanceLabelId = useId();
  const defaultVoiceId = useId();
  const pageHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const micMeterRef = useRef<HTMLDivElement | null>(null);
  const micMeterFillRef = useRef<HTMLDivElement | null>(null);
  const hasMicAudioRef = useRef(false);
  /** Event-time mute intent survives the asynchronous microphone permission prompt. */
  const mutedIntentRef = useRef(false);
  /** When true, keep the live transcript pinned to the newest line. */
  const stickTranscriptToBottom = useRef(true);
  /** Latest selected matter, readable from long-lived IPC callbacks without stale closures. */
  const selectedIdRef = useRef<string | null>(null);
  /** Only the newest async collection/settings request may commit renderer state. */
  const mattersRequest = useRef(0);
  const settingsRequest = useRef(0);
  const appInfoRequest = useRef(0);
  const diagnosticsOpeningRef = useRef(false);
  const keyImportingRef = useRef(false);
  /** Only the newest async detail/review request may commit renderer state. */
  const matterDetailRequest = useRef(0);
  const sessionListRequest = useRef(0);
  const sessionReviewRequest = useRef(0);
  /** Report jobs outlive a closed drawer, while UI commits remain target-scoped. */
  const reportGenerationSequence = useRef(0);
  const activeReportGenerations = useRef(new Map<string, number>());
  const generatedReportCache = useRef(new Map<string, GeneratedSessionReportResult>());
  const reportGenerationFailureCache = useRef(new Map<string, ReportGenerationState>());
  /** Synchronous target ownership closes the state-render gap during drawer dismissal. */
  const sessionReviewTargetRef = useRef<string | null>(null);
  /** Exact Review button to restore after the async-loaded drawer closes. */
  const sessionReviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const sessionEndRequest = useRef(0);
  const retainedSaveRetryRequest = useRef(0);
  const retainedSaveRetryInFlight = useRef(false);
  /** A failed stop retains the main-process session until this matter saves successfully. */
  const saveRetryMatterIdRef = useRef<string | null>(null);
  /** Bootstrap ownership prevents a stale reconciliation result from changing current UI. */
  const voiceReconciliationRequest = useRef(0);
  const voiceReconciliationPendingRef = useRef(apiReady);
  /** Matter that owns unscoped voice IPC events such as voice:error. */
  const voiceOwnerMatterRef = useRef<string | null>(null);
  /** Concurrent async operations keep the global busy affordance locked until all owners finish. */
  const busyOperationSequence = useRef(0);
  const busyOperations = useRef(new Set<number>());
  const matterOpenBusyOperationRef = useRef<number | null>(null);
  const voiceBusyOperationRef = useRef<number | null>(null);
  /** Guards async voice startup/cancellation state from an older attempt. */
  const voiceStartRequest = useRef(0);
  const audioDropNoted = useRef(false);
  const sessionStartPhaseRef = useRef<SessionStartPhase>("idle");
  /** Practice selection survives detail reloads while the same person still exists. */
  const sessionPersonaIdRef = useRef("");
  /** Only the newest document mutation may commit its result. */
  const documentMutationRequest = useRef(0);
  /** Closes the same-render double-click gap before the disabled row can render. */
  const documentRemovalRef = useRef<DocumentRemoval | null>(null);
  /** Synchronous ownership lets Cancel invalidate a rebuild before React rerenders. */
  const documentOperationRef = useRef<DocumentOperation | null>(null);
  /** Session deletes are independent, target-owned mutations rather than a global busy state. */
  const sessionDeletionSequence = useRef(0);
  const activeSessionDeletions = useRef(new Map<string, number>());
  const recordHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const sessionsHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const selected = useMemo(
    () => matters.find((m) => m.id === selectedId) ?? null,
    [matters, selectedId]
  );
  const selectedDocumentOperation =
    documentOperation?.matterId === selectedId ? documentOperation : null;
  const selectedDocumentRemoval =
    documentRemoval?.matterId === selectedId ? documentRemoval : null;
  const selectedDocumentRecovery =
    documentRecovery?.matterId === selectedId ? documentRecovery : null;
  const deferredDocumentQuery = useDeferredValue(documentQuery);
  const normalizedDocumentQuery = deferredDocumentQuery.trim().toLocaleLowerCase();
  const documentFilterPending =
    documentQuery.trim().toLocaleLowerCase() !== normalizedDocumentQuery;
  const filteredDocs = useMemo(() => {
    if (!normalizedDocumentQuery) return docs;
    return docs.filter((doc) =>
      `${doc.fileName}\n${doc.docType}`.toLocaleLowerCase().includes(normalizedDocumentQuery)
    );
  }, [docs, normalizedDocumentQuery]);
  const documentFilterFeedback = documentFilterPending
    ? "Updating results…"
    : normalizedDocumentQuery
      ? `${filteredDocs.length} of ${docs.length} ${docs.length === 1 ? "document" : "documents"} match`
      : `${docs.length} total ${docs.length === 1 ? "document" : "documents"}`;

  /**
   * One event-time gate owns every prerequisite for claiming voice or audio resources.
   * Ref-backed checks close the render gap when an operation starts while consent is open.
   */
  function getPracticeSessionStartBlockReason(): string | null {
    const matterId = selectedIdRef.current;
    if (view !== "matter" || !matterId || selected?.id !== matterId) {
      return "Open a matter before starting an exam.";
    }
    if (voiceReconciliationPendingRef.current || voiceReconciliationPending) {
      return "Wait for the previous-session check to finish before starting an exam.";
    }
    if (voiceReconciliationError) {
      return "Retry the previous-session check before starting an exam.";
    }
    if (activeSessionDeletions.current.size || deletingSessionKeys.size) {
      return "Wait for saved-session deletion to finish before starting an exam.";
    }
    if (saveRetryMatterIdRef.current) {
      return "Retry saving the retained session before starting another exam.";
    }
    if (live || sessionStartPhaseRef.current !== "idle") {
      return "End or cancel the current exam before starting another.";
    }
    if (
      busy ||
      busyOperations.current.size > 0 ||
      documentOperationRef.current?.matterId === matterId ||
      documentRemovalRef.current?.matterId === matterId
    ) {
      return "Wait for the current matter operation to finish before starting an exam.";
    }
    if (selectedDocumentRecovery) {
      return "Reindex the case record before starting an exam.";
    }
    if (!docs.length) {
      return "Index at least one document before starting an exam.";
    }
    const personaId = sessionPersonaIdRef.current;
    if (!personaId || !personas.some((persona) => persona.id === personaId)) {
      return "Select an available person before starting an exam.";
    }
    return null;
  }

  const practiceSessionStartBlockReason = getPracticeSessionStartBlockReason();

  useEffect(() => {
    if (view !== "session" || !stickTranscriptToBottom.current) return;
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript, view]);

  function paintMicLevel(level: number) {
    const width = Math.min(100, Math.round(Math.max(0, level) * 400));
    if (micMeterFillRef.current) micMeterFillRef.current.style.width = `${width}%`;
    micMeterRef.current?.setAttribute("aria-valuenow", String(width));
    micMeterRef.current?.setAttribute("aria-valuetext", `${width}% input level`);
  }

  function resetMicTelemetry() {
    hasMicAudioRef.current = false;
    setHasMicAudio(false);
    paintMicLevel(0);
  }

  function beginBusyOperation(): number {
    const operation = ++busyOperationSequence.current;
    busyOperations.current.add(operation);
    setBusy(true);
    return operation;
  }

  function finishBusyOperation(operation: number | null) {
    if (operation === null || !busyOperations.current.delete(operation)) return;
    if (!busyOperations.current.size) setBusy(false);
  }

  function updateDocumentOperation(operation: DocumentOperation): void {
    documentOperationRef.current = operation;
    setDocumentOperation(operation);
  }

  function finishDocumentOperation(request: number): void {
    if (documentOperationRef.current?.request !== request) return;
    documentOperationRef.current = null;
    setDocumentOperation(null);
  }

  function finishDocumentRemoval(request: number): void {
    if (documentRemovalRef.current?.request !== request) return;
    documentRemovalRef.current = null;
    setDocumentRemoval(null);
  }

  function clearDocumentRecovery(matterId: string): void {
    setDocumentRecovery((current) =>
      current?.matterId === matterId ? null : current
    );
  }

  function clearCaseRecordWarning(): void {
    setMatterDataWarning((current) =>
      removeMatterDataWarningSection(current, "Case record unavailable")
    );
  }

  function invalidateReportGenerationUi() {
    setReportGeneration(null);
  }

  function markSaveRetryPending(matterId: string, detail: unknown) {
    saveRetryMatterIdRef.current = matterId;
    setSaveRetryMatterId(matterId);
    setStatus("save_error");
    setError(
      `The session is still held in memory because it could not be saved: ${String(
        detail
      )}. Retry saving before leaving or starting another exam.`
    );
  }

  function clearSaveRetryPending(matterId: string) {
    if (saveRetryMatterIdRef.current !== matterId) return;
    saveRetryMatterIdRef.current = null;
    setSaveRetryMatterId(null);
  }

  function retryVoiceReconciliationCheck() {
    if (voiceReconciliationPendingRef.current) return;
    examHost().__examVoiceReconciliation = undefined;
    voiceReconciliationPendingRef.current = true;
    setVoiceReconciliationPending(true);
    setVoiceReconciliationError(null);
    setError(null);
    setVoiceReconciliationAttempt((attempt) => attempt + 1);
  }

  async function retryRetainedSave() {
    const matterId = saveRetryMatterIdRef.current;
    if (!matterId || retainedSaveRetryInFlight.current) return;

    retainedSaveRetryInFlight.current = true;
    const request = ++retainedSaveRetryRequest.current;
    const busyOperation = beginBusyOperation();
    setRetryingRetainedSave(true);
    setStatus("saving");
    setError(null);
    try {
      const result = (await window.api.stopVoice(false)) as VoiceStopResult;
      const retainedOwner = saveRetryMatterIdRef.current;
      if (
        request !== retainedSaveRetryRequest.current ||
        (retainedOwner !== matterId && retainedOwner !== null)
      ) {
        return;
      }

      const stoppedMatterId = result.session?.matterId || matterId;
      if (stoppedMatterId !== matterId) {
        markSaveRetryPending(
          matterId,
          `The save returned ownership for a different matter (${stoppedMatterId}).`
        );
        return;
      }

      clearSaveRetryPending(matterId);
      voiceOwnerMatterRef.current = null;
      setLive(false);
      setStatus("ended");
      examHost().__examVoiceReconciliation = Promise.resolve({
        kind: "saved",
        state: {
          active: false,
          hasSession: false,
          hasUnsavedSession: false,
          matterId,
          sessionId: result.session?.id || null,
        },
        result,
      });
      setNotice("The retained session was saved. Its transcript is available in Past sessions.");
      void refreshMatters();

      if (selectedIdRef.current === matterId) {
        setSavedArtifacts({
          matterId,
          sessionId: result.session?.id,
          canOpenTranscript: result.canOpenTranscript,
          canOpenReport: result.canOpenReport,
        });
        const sessionsRequest = ++sessionListRequest.current;
        try {
          const listed = await window.api.listSessions(matterId);
          if (
            request === retainedSaveRetryRequest.current &&
            sessionsRequest === sessionListRequest.current &&
            selectedIdRef.current === matterId
          ) {
            setSessions((listed.sessions || []) as SessionListItem[]);
            setSessionDataErrors(listed.dataErrors || []);
          }
        } catch {
          /* Saving succeeded; a later matter refresh can recover the optional list. */
        }
      }
    } catch (e) {
      if (
        request === retainedSaveRetryRequest.current &&
        saveRetryMatterIdRef.current === matterId
      ) {
        markSaveRetryPending(matterId, e);
      }
    } finally {
      if (request === retainedSaveRetryRequest.current) {
        retainedSaveRetryInFlight.current = false;
        setRetryingRetainedSave(false);
      }
      finishBusyOperation(busyOperation);
    }
  }

  const refreshMatters = useCallback(async () => {
    const request = ++mattersRequest.current;
    setMattersLoading(true);
    try {
      const result = await window.api.listMatters();
      if (request !== mattersRequest.current) return false;
      setMatters(result.matters as Matter[]);
      setDataErrors(result.dataErrors ?? []);
      if (result.dataErrors?.length) {
        setError(
          `Data integrity: ${result.dataErrors.join(" · ")} Use Restore on a matter folder backup if available.`
        );
      }
      return true;
    } catch (e) {
      if (request !== mattersRequest.current) return false;
      setDataErrors([]);
      setError(`Failed to load matters: ${String(e)}`);
      return false;
    } finally {
      if (request === mattersRequest.current) setMattersLoading(false);
    }
  }, []);

  const loadMatterDetail = useCallback(async (matterId: string): Promise<boolean> => {
    const request = ++matterDetailRequest.current;
    const sessionsRequest = ++sessionListRequest.current;
    setMatterDataWarning(null);
    try {
      const [personaResult, documentResult, sessionResult] = await Promise.allSettled([
        window.api.listPersonas(matterId) as Promise<Persona[]>,
        window.api.listDocs(matterId) as Promise<DocMeta[]>,
        window.api.listSessions(matterId) as Promise<ListSessionsResult>,
      ]);
      if (request !== matterDetailRequest.current || selectedIdRef.current !== matterId) {
        return false;
      }

      const unavailable: string[] = [];
      const failure = (label: string, reason: unknown) => {
        const detail = reason instanceof Error ? reason.message : String(reason);
        unavailable.push(`${label}: ${detail}`);
      };

      if (personaResult.status === "fulfilled") {
        const people = personaResult.value;
        setPersonas(people);
        const previousPersonaId = sessionPersonaIdRef.current;
        const nextPersonaId = people.some((persona) => persona.id === previousPersonaId)
          ? previousPersonaId
          : people[0]?.id ?? "";
        sessionPersonaIdRef.current = nextPersonaId;
        setSessionPersonaId(nextPersonaId);
        if (nextPersonaId !== previousPersonaId) setSessionVoice("");
      } else {
        // A rejected people refresh is not authoritative. Hide the prior rows and
        // their practice selection so stale witnesses cannot start a new session.
        setPersonas([]);
        sessionPersonaIdRef.current = "";
        setSessionPersonaId("");
        setSessionVoice("");
        failure("People unavailable", personaResult.reason);
      }

      if (documentResult.status === "fulfilled") {
        setDocs(documentResult.value);
        // A successful reload is authoritative even when a rebuild completed
        // after this matter lost renderer ownership. Clear only this matter's
        // prior recovery lock; another matter may still require recovery.
        clearDocumentRecovery(matterId);
      } else {
        // Never leave a previously loaded case record looking current when the
        // main process cannot verify its derived index.
        setDocs([]);
        setDocumentRecovery({ matterId, outcome: "unavailable" });
        failure("Case record unavailable", documentResult.reason);
      }

      if (sessionsRequest === sessionListRequest.current) {
        if (sessionResult.status === "fulfilled") {
          setSessions(sessionResult.value.sessions || []);
          setSessionDataErrors(sessionResult.value.dataErrors || []);
        } else {
          // Session actions must never remain bound to an unverified prior list.
          setSessions([]);
          setSessionDataErrors([]);
          failure("Past sessions unavailable", sessionResult.reason);
        }
      }

      if (unavailable.length === 3) {
        setError(`Failed to load matter: ${unavailable.join(" · ")}`);
        return false;
      }
      if (unavailable.length) {
        setMatterDataWarning(
          `Some matter data could not be refreshed. Available sections remain usable. ${unavailable.join(" · ")}`
        );
      }
      return true;
    } catch (e) {
      if (request !== matterDetailRequest.current || selectedIdRef.current !== matterId) {
        return false;
      }
      setPersonas([]);
      sessionPersonaIdRef.current = "";
      setSessionPersonaId("");
      setSessionVoice("");
      setDocs([]);
      setDocumentRecovery({ matterId, outcome: "unavailable" });
      if (sessionsRequest === sessionListRequest.current) {
        setSessions([]);
        setSessionDataErrors([]);
      }
      setMatterDataWarning(null);
      setError(`Failed to load matter: ${String(e)}`);
      return false;
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    pageHeadingRef.current?.focus({ preventScroll: true });
  }, [view]);

  useEffect(() => {
    if (!apiReady) return;
    void refreshMatters();
    const request = ++settingsRequest.current;
    void window.api
      .getSettings()
      .then((s) => {
        if (request !== settingsRequest.current) return;
        setKeyMeta({
          hasKey: s.hasKey,
          keyLast4: s.keyLast4,
          keySource: s.keySource,
          encryptionAvailable: s.encryptionAvailable !== false,
        });
        setVoice(s.defaultVoice || "eve");
        if (s.dataError) {
          setError(`Settings file unreadable: ${s.dataError}. Env key still works if set.`);
        }
      })
      .catch((e) => {
        if (request === settingsRequest.current) {
          setError(`Failed to load settings: ${String(e)}`);
        }
      });

    const infoRequest = ++appInfoRequest.current;
    setAppInfoLoading(true);
    void window.api
      .getAppInfo()
      .then((info) => {
        if (infoRequest !== appInfoRequest.current) return;
        setAppInfo(info as AppInfo);
      })
      .catch(() => undefined)
      .finally(() => {
        if (infoRequest === appInfoRequest.current) setAppInfoLoading(false);
      });
  }, [apiReady, refreshMatters]);

  useEffect(() => {
    if (!apiReady) {
      voiceReconciliationPendingRef.current = false;
      setVoiceReconciliationPending(false);
      return;
    }

    const request = ++voiceReconciliationRequest.current;
    voiceReconciliationPendingRef.current = true;
    setVoiceReconciliationPending(true);
    setVoiceReconciliationError(null);

    void reconcileRetainedVoiceSession().then((outcome) => {
      if (request !== voiceReconciliationRequest.current) return;
      voiceReconciliationPendingRef.current = false;
      setVoiceReconciliationPending(false);

      if (outcome.kind === "check-failed") {
        const detail = String(outcome.error);
        setVoiceReconciliationError(detail);
        setError(
          `Could not verify whether a previous voice session still needs saving: ${detail}. Retry the session check before starting a new exam.`
        );
        return;
      }
      if (outcome.kind === "none") return;

      const matterId = outcome.state.matterId;
      if (matterId) voiceOwnerMatterRef.current = matterId;
      if (outcome.kind === "save-failed") {
        if (matterId) {
          markSaveRetryPending(matterId, outcome.error);
        } else {
          const detail = String(outcome.error);
          setVoiceReconciliationError(detail);
          setError(
            `A previous voice session is still held in memory but has no matter ownership, so it could not be saved: ${detail}. Restart the app before starting another exam.`
          );
        }
        return;
      }

      const stoppedMatterId = outcome.result.session?.matterId || matterId;
      if (stoppedMatterId) clearSaveRetryPending(stoppedMatterId);
      voiceOwnerMatterRef.current = null;
      setLive(false);
      setStatus("ended");
      if (stoppedMatterId && selectedIdRef.current === stoppedMatterId) {
        setSavedArtifacts({
          matterId: stoppedMatterId,
          sessionId: outcome.result.session?.id,
          canOpenTranscript: outcome.result.canOpenTranscript,
          canOpenReport: outcome.result.canOpenReport,
        });
        const sessionsRequest = ++sessionListRequest.current;
        void window.api
          .listSessions(stoppedMatterId)
          .then((listed) => {
            if (
              request === voiceReconciliationRequest.current &&
              sessionsRequest === sessionListRequest.current &&
              selectedIdRef.current === stoppedMatterId
            ) {
              setSessions((listed.sessions || []) as SessionListItem[]);
              setSessionDataErrors(listed.dataErrors || []);
            }
          })
          .catch(() => {
            /* The saved notice remains useful even if the optional list refresh fails. */
          });
      }
      setNotice(
        outcome.result.canOpenTranscript
          ? "Recovered the voice session left open by the previous app window and saved its transcript."
          : "Recovered the voice session left open by the previous app window and saved its session record, but the transcript export is unavailable."
      );
      void refreshMatters();
    });

    return () => {
      if (voiceReconciliationRequest.current === request) {
        voiceReconciliationRequest.current += 1;
      }
    };
  }, [apiReady, refreshMatters, voiceReconciliationAttempt]);

  useEffect(() => {
    if (!apiReady) return;
    const host = examHost();
    const offT = window.api.onVoiceTranscript((line) => {
      const l = line as TranscriptLine & { replaceIndex?: number };
      setTranscript((prev) => {
        if (typeof l.replaceIndex === "number" && l.replaceIndex >= 0 && l.replaceIndex < prev.length) {
          const next = prev.slice();
          next[l.replaceIndex] = { role: l.role, text: l.text, at: l.at };
          return next;
        }
        return [...prev, { role: l.role, text: l.text, at: l.at }];
      });
    });
    const offS = window.api.onVoiceStatus((payload) => {
      const terminal = payload.status === "ended" || payload.status === "disconnected";
      const terminalSession = payload.session as
        | { id?: string; matterId?: string }
        | null
        | undefined;
      const eventMatterId = terminalSession?.matterId || voiceOwnerMatterRef.current;
      const ownsVoiceUi = !eventMatterId || selectedIdRef.current === eventMatterId;
      if (ownsVoiceUi) setStatus(String(payload.status || ""));
      if (terminal && ownsVoiceUi) {
        setLive(false);
        const needsSaveRetry = payload.needsSaveRetry === true;
        if (!needsSaveRetry && eventMatterId) {
          clearSaveRetryPending(eventMatterId);
          voiceOwnerMatterRef.current = null;
        }
        if (sessionStartPhaseRef.current === "starting") {
          // A terminal main-process event owns cancellation of the pending start.
          voiceStartRequest.current += 1;
          sessionStartPhaseRef.current = "idle";
          setSessionStartPhase("idle");
          finishBusyOperation(voiceBusyOperationRef.current);
          voiceBusyOperationRef.current = null;
        }
        // Invalidate any in-flight startSession (e.g. stuck on mic permission prompt)
        host.__examGeneration = (host.__examGeneration ?? 0) + 1;
        const cleanup = host.__examCleanup;
        if (cleanup) {
          void cleanup().catch(() => {
            /* best-effort */
          });
        }
        setSavedArtifacts({
          matterId: terminalSession?.matterId,
          sessionId: terminalSession?.id,
          canOpenTranscript: payload.canOpenTranscript,
          canOpenReport: payload.canOpenReport,
        });
        if (payload.status === "disconnected") {
          if (needsSaveRetry && eventMatterId) {
            markSaveRetryPending(
              eventMatterId,
              "the voice connection was lost and the automatic save failed"
            );
          } else if (needsSaveRetry) {
            setStatus("save_error");
            setError(
              "The voice connection was lost and testimony remains unsaved in memory. Restarting or closing the app may lose it."
            );
          } else {
            setError(
              String(
                payload.reason ||
                  "Connection lost. Transcript was saved if any lines existed."
              )
            );
          }
        }
        // Refresh past-sessions from the session payload (avoid stale selectedId closure)
        const sessionMatterId = (payload.session as { matterId?: string } | undefined)?.matterId;
        if (sessionMatterId) {
          const request = ++sessionListRequest.current;
          void window.api
            .listSessions(sessionMatterId)
            .then((result) => {
              if (
                request === sessionListRequest.current &&
                selectedIdRef.current === sessionMatterId
              ) {
                setSessions((result.sessions || []) as SessionListItem[]);
                setSessionDataErrors(result.dataErrors || []);
              }
            })
            .catch(() => {
              /* non-fatal */
            });
        }
      }
    });
    const offE = window.api.onVoiceError((payload) => {
      const ownerMatterId = voiceOwnerMatterRef.current;
      if (ownerMatterId && selectedIdRef.current === ownerMatterId) {
        setError(payload.message);
      }
    });
    const offTool = window.api.onVoiceTool((payload) => {
      setToolLog((prev) => [...prev, formatToolActivity(payload)]);
    });
    const offBarge = window.api.onVoiceBargeIn(() => {
      host.__examPlayer?.flush();
    });
    return () => {
      offT();
      offS();
      offE();
      offTool();
      offBarge();
    };
  }, [apiReady]);

  async function openMatter(id: string) {
    if (saveRetryMatterIdRef.current) {
      setError("Retry saving the retained session before opening a matter.");
      return;
    }
    finishBusyOperation(matterOpenBusyOperationRef.current);
    const busyOperation = beginBusyOperation();
    matterOpenBusyOperationRef.current = busyOperation;
    try {
      sessionReviewRequest.current += 1;
      invalidateReportGenerationUi();
      setReviewLoadingId(null);
      sessionReviewTargetRef.current = null;
      setSessionReview(null);
      if (selectedIdRef.current !== id) {
        // Completed-session UI is matter-owned. Never show Matter A's record under Matter B.
        setPersonas([]);
        setDocs([]);
        setSessions([]);
        setTranscript([]);
        setToolLog([]);
        setSavedArtifacts({});
        setStatus("idle");
        mutedIntentRef.current = false;
        setMuted(false);
        resetMicTelemetry();
        setMicInfo("");
        setSessionDataErrors([]);
        setMatterDataWarning(null);
        setDocumentQuery("");
        sessionPersonaIdRef.current = "";
        setSessionPersonaId("");
        setSessionVoice("");
        stickTranscriptToBottom.current = true;
      }
      selectedIdRef.current = id;
      setSelectedId(id);
      if (await loadMatterDetail(id)) setView("matter");
    } finally {
      finishBusyOperation(busyOperation);
      if (matterOpenBusyOperationRef.current === busyOperation) {
        matterOpenBusyOperationRef.current = null;
      }
    }
  }

  function errorForModal(modal: ModalOperation): string | null {
    return modalError?.modal === modal ? modalError.message : null;
  }

  function clearModalError(modal: ModalOperation) {
    setModalError((current) => (current?.modal === modal ? null : current));
  }

  function closeCreateMatter() {
    if (modalOperation === "create-matter") return;
    setShowCreateMatter(false);
    clearModalError("create-matter");
  }

  function closeEditMatter() {
    if (modalOperation === "edit-matter") return;
    setShowEditMatter(false);
    clearModalError("edit-matter");
    setCaption("");
    setCourt("");
    setNotes("");
  }

  function closePersona() {
    if (modalOperation === "persona") return;
    setShowPersona(false);
    clearModalError("persona");
  }

  async function createMatter() {
    if (!caption.trim()) return;
    const busyOperation = beginBusyOperation();
    setModalOperation("create-matter");
    setModalError(null);
    setError(null);
    try {
      const m = (await window.api.createMatter({ caption, court, notes })) as Matter;
      // The successful create is authoritative even if the optional list refresh
      // fails. Own it locally before opening so the workspace cannot render blank.
      setMatters((current) => [m, ...current.filter((matter) => matter.id !== m.id)]);
      setShowCreateMatter(false);
      setCaption("");
      setCourt("");
      setNotes("");
      await refreshMatters();
      await openMatter(m.id);
    } catch (e) {
      setModalError({ modal: "create-matter", message: String(e) });
    } finally {
      setModalOperation((current) => (current === "create-matter" ? null : current));
      finishBusyOperation(busyOperation);
    }
  }

  function openEditMatter() {
    if (!selected) return;
    setCaption(selected.caption);
    setCourt(selected.court || "");
    setNotes(selected.notes || "");
    clearModalError("edit-matter");
    setShowEditMatter(true);
  }

  async function saveMatterEdits() {
    if (!selectedId || !caption.trim()) return;
    const busyOperation = beginBusyOperation();
    setModalOperation("edit-matter");
    setModalError(null);
    setError(null);
    try {
      const updated = (await window.api.updateMatter(selectedId, {
        caption,
        court,
        notes,
      })) as Matter;
      // A list refresh started before this save must not restore the older metadata.
      mattersRequest.current += 1;
      setMatters((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      setShowEditMatter(false);
      setNotice("Matter details saved.");
    } catch (e) {
      setModalError({ modal: "edit-matter", message: String(e) });
    } finally {
      setModalOperation((current) => (current === "edit-matter" ? null : current));
      finishBusyOperation(busyOperation);
    }
  }

  async function exportMatter() {
    if (!selectedId || !selected) return;
    const busyOperation = beginBusyOperation();
    setError(null);
    setNotice(null);
    try {
      const zipPath = await window.api.exportMatter(selectedId);
      if (zipPath) {
        setNotice(`Matter exported to ${zipPath}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      finishBusyOperation(busyOperation);
    }
  }

  async function removeMatter() {
    if (!selectedId || !selected) return;
    if (live) {
      setError("End the live exam before deleting a matter.");
      return;
    }
    if (saveRetryMatterIdRef.current) {
      // A retained session still needs its save retried; deleting the matter
      // would destroy the folder that save must write into.
      setError("Retry saving the retained session before deleting a matter.");
      return;
    }
    const matterHasActiveReportGeneration = [...activeReportGenerations.current.keys()].some(
      (key) => key.startsWith(`${selectedId}:`)
    );
    if (matterHasActiveReportGeneration) {
      setError("Wait for the running report generation to finish before deleting this matter.");
      return;
    }
    const ok = confirm(
      `Permanently delete “${selected.caption}”?\n\nThis removes all imported documents, the local index, people, and session transcripts for this matter. This cannot be undone.`
    );
    if (!ok) return;
    const busyOperation = beginBusyOperation();
    setError(null);
    setNotice(null);
    try {
      await window.api.deleteMatter(selectedId);
      matterDetailRequest.current += 1;
      sessionReviewRequest.current += 1;
      invalidateReportGenerationUi();
      sessionReviewTargetRef.current = null;
      selectedIdRef.current = null;
      setSelectedId(null);
      setPersonas([]);
      setDocs([]);
      setDocumentQuery("");
      setSessions([]);
      setSessionDataErrors([]);
      setMatterDataWarning(null);
      setSessionReview(null);
      setTranscript([]);
      setToolLog([]);
      setSavedArtifacts({});
      setSessionIdentity(null);
      sessionPersonaIdRef.current = "";
      setSessionPersonaId("");
      setSessionVoice("");
      clearDocumentRecovery(selected.id);
      setView("matters");
      await refreshMatters();
      setNotice("Matter deleted.");
    } catch (e) {
      setError(String(e));
    } finally {
      finishBusyOperation(busyOperation);
    }
  }

  async function importDocs() {
    if (!selectedId || documentOperationRef.current || documentRemovalRef.current) return;
    const matterId = selectedId;
    const request = ++documentMutationRequest.current;
    const stillOwnsMatter = () =>
      documentMutationRequest.current === request && selectedIdRef.current === matterId;
    const busyOperation = beginBusyOperation();
    let imported: string[] = [];
    let needsReindex = false;
    updateDocumentOperation({ request, matterId, phase: "importing", importedCount: 0 });
    setError(null);
    setNotice(null);
    try {
      const result = await window.api.pickAndImportDocs(matterId);
      if (
        !result ||
        !Array.isArray(result.imported) ||
        result.imported.some((name) => typeof name !== "string") ||
        (result.renamed !== undefined &&
          (!Array.isArray(result.renamed) ||
            result.renamed.some((name) => typeof name !== "string"))) ||
        typeof result.needsReindex !== "boolean" ||
        (result.error !== undefined && typeof result.error !== "string")
      ) {
        if (!stillOwnsMatter()) return;
        setDocs([]);
        setDocumentRecovery({ matterId, outcome: "unavailable" });
        throw new Error("The document import response could not be verified.");
      }

      imported = result.imported;
      needsReindex = result.needsReindex || imported.length > 0;
      if (needsReindex && stillOwnsMatter()) {
        setDocs([]);
        setDocumentRecovery(
          imported.length
            ? { matterId, importedCount: imported.length, outcome: "imported" }
            : { matterId, outcome: "unavailable" }
        );
      }
      if (result.error) {
        if (stillOwnsMatter()) {
          setError(`The document import could not be verified. ${result.error}`);
        }
        return;
      }
      if (!imported.length) return; // user cancelled — do not reindex
      if (!stillOwnsMatter()) return;
      updateDocumentOperation({
        request,
        matterId,
        phase: "indexing",
        importedCount: imported.length,
      });
      const index = (await window.api.reindexDocs(matterId)) as ReindexResult;
      if (!stillOwnsMatter()) return;
      setDocs(index.documents || []);
      clearDocumentRecovery(matterId);
      clearCaseRecordWarning();
      if (index.issues?.length) setError(formatIndexingIssues(index.issues));
      // Main reports exactly which files were stored under a different name
      // (collision suffix or sanitization) — never inferred from name shape.
      const renamed = result.renamed ?? [];
      if (renamed.length) {
        setNotice(
          `Imported ${formatFileCount(imported.length)}. Saved under adjusted names: ${renamed.join(", ")}`
        );
      } else {
        setNotice(`Imported ${formatFileCount(imported.length)} and reindexed.`);
      }
    } catch (e) {
      if (stillOwnsMatter()) {
        if (needsReindex || imported.length) {
          setDocs([]);
          setDocumentRecovery(
            imported.length
              ? { matterId, importedCount: imported.length, outcome: "imported" }
              : { matterId, outcome: "unavailable" }
          );
        }
        setError(
          imported.length
            ? `Imported ${formatFileCount(imported.length)}, but indexing failed. The files are safely stored; choose Reindex to finish updating the case record. ${String(e)}`
            : String(e)
        );
      }
    } finally {
      finishDocumentOperation(request);
      finishBusyOperation(busyOperation);
    }
  }

  async function reindex() {
    if (!selectedId || documentOperationRef.current || documentRemovalRef.current) return;
    const matterId = selectedId;
    const request = ++documentMutationRequest.current;
    const stillOwnsMatter = () =>
      documentMutationRequest.current === request && selectedIdRef.current === matterId;
    const busyOperation = beginBusyOperation();
    updateDocumentOperation({ request, matterId, phase: "indexing", importedCount: 0 });
    setError(null);
    setNotice(null);
    try {
      const index = (await window.api.reindexDocs(matterId)) as ReindexResult;
      if (stillOwnsMatter()) {
        setDocs(index.documents || []);
        clearDocumentRecovery(matterId);
        clearCaseRecordWarning();
        if (index.issues?.length) setError(formatIndexingIssues(index.issues));
        else setNotice("Case record reindexed.");
      }
    } catch (e) {
      if (stillOwnsMatter()) setError(String(e));
    } finally {
      finishDocumentOperation(request);
      finishBusyOperation(busyOperation);
    }
  }

  async function cancelDocumentIndexing() {
    const operation = documentOperationRef.current;
    if (!operation || operation.phase !== "indexing") return;

    // Invalidate the renderer owner before awaiting IPC. Even if the rebuild
    // finishes while the cancel request crosses processes, its stale payload
    // cannot replace the visible case record.
    documentMutationRequest.current += 1;
    updateDocumentOperation({ ...operation, phase: "cancelling" });
    setError(null);
    try {
      const result = await window.api.cancelReindexDocs(operation.matterId);
      if (result?.cancelled !== operation.matterId) {
        throw new Error("The indexing cancellation response did not match this matter.");
      }
      if (selectedIdRef.current === operation.matterId) {
        if (operation.removedFileName) {
          setDocs([]);
          setDocumentRecovery({
            matterId: operation.matterId,
            fileName: operation.removedFileName,
            outcome: "removed",
          });
          setNotice(
            `“${operation.removedFileName}” was removed. Cancellation requested; choose Reindex to rebuild the case record before practicing.`
          );
        } else {
          if (operation.importedCount) {
            setDocs([]);
            setDocumentRecovery({
              matterId: operation.matterId,
              importedCount: operation.importedCount,
              outcome: "imported",
            });
          }
          setNotice(
            operation.importedCount
              ? `Imported ${formatFileCount(operation.importedCount)}. Cancellation requested; choose Reindex to ensure they are included in the case record.`
              : "Indexing cancellation requested. Choose Reindex whenever you want to refresh the case record."
          );
        }
      }
    } catch (e) {
      if (
        documentOperationRef.current?.request === operation.request &&
        documentOperationRef.current.phase === "cancelling"
      ) {
        updateDocumentOperation({ ...operation, phase: "indexing" });
      }
      if (selectedIdRef.current === operation.matterId) {
        setError(
          `Could not cancel case record indexing: ${String(
            e
          )}. Indexing may still finish; choose Reindex afterward to refresh the visible record.`
        );
      }
    }
  }

  async function removeDoc(doc: DocMeta) {
    if (!selectedId || documentRemovalRef.current || documentOperationRef.current) return;
    const matterId = selectedId;
    if (
      !confirm(
        `Permanently remove “${doc.fileName}” from this matter? The local copy will be deleted and this cannot be undone.`
      )
    ) {
      return;
    }
    if (
      selectedIdRef.current !== matterId ||
      documentRemovalRef.current ||
      documentOperationRef.current
    ) {
      return;
    }
    const request = ++documentMutationRequest.current;
    const removal = { request, matterId, documentId: doc.id, fileName: doc.fileName };
    documentRemovalRef.current = removal;
    setDocumentRemoval(removal);
    const requestIsCurrent = () => documentMutationRequest.current === request;
    const stillOwnsMatter = () =>
      requestIsCurrent() && selectedIdRef.current === matterId;
    const busyOperation = beginBusyOperation();
    let deletionCommitted = false;
    let deletionOutcomeUncertain = false;
    let caseRecordRecoveryRequired = false;
    setError(null);
    setNotice(null);
    try {
      const result = await window.api.deleteDoc(matterId, doc.id);
      if (!requestIsCurrent()) return;
      if (result?.needsReindex) {
        caseRecordRecoveryRequired = true;
        setDocumentRecovery({ matterId, outcome: "unavailable" });
        if (selectedIdRef.current === matterId) setDocs([]);
        throw new Error(result.error);
      }
      if (result?.deleted !== doc.id) {
        // A mismatched acknowledgement is an uncertain destructive outcome.
        // Hide the stale index and require an explicit rebuild before practice.
        deletionOutcomeUncertain = true;
        setDocumentRecovery({ matterId, fileName: doc.fileName, outcome: "unknown" });
        if (selectedIdRef.current === matterId) setDocs([]);
        throw new Error(
          "The document deletion response did not match the requested document. Reindex the matter before continuing."
        );
      }

      deletionCommitted = true;
      setDocumentRecovery({ matterId, fileName: doc.fileName, outcome: "removed" });
      if (stillOwnsMatter()) setDocs((current) => current.filter((item) => item.id !== doc.id));
      finishDocumentRemoval(request);

      // The backend has already deleted the source and tombstoned the old index.
      // Rebuild as a visible, cancellable second phase so failure is never
      // confused with a failed delete.
      updateDocumentOperation({
        request,
        matterId,
        phase: "indexing",
        importedCount: 0,
        removedFileName: doc.fileName,
      });
      const index = (await window.api.reindexDocs(matterId)) as ReindexResult;
      if (!requestIsCurrent()) return;
      clearDocumentRecovery(matterId);
      if (selectedIdRef.current === matterId) {
        setDocs(index.documents || []);
        clearCaseRecordWarning();
        if (index.issues?.length) setError(formatIndexingIssues(index.issues));
        else setNotice(`Removed “${doc.fileName}” and rebuilt the case record.`);
      }
    } catch (e) {
      if (stillOwnsMatter()) {
        if (deletionCommitted) {
          setDocs([]);
          setDocumentRecovery({ matterId, fileName: doc.fileName, outcome: "removed" });
          setError(
            `“${doc.fileName}” was removed, but the case record still needs reindexing. ${String(e)}`
          );
        } else if (deletionOutcomeUncertain) {
          setDocs([]);
          setError(
            `The result of removing “${doc.fileName}” could not be verified. The stale case record was hidden; reindex before continuing. ${String(e)}`
          );
        } else if (caseRecordRecoveryRequired) {
          setDocs([]);
          setError(
            `“${doc.fileName}” was not removed, but the prior case record could not be restored safely. Reindex before continuing. ${String(e)}`
          );
        } else {
          setError(`Could not remove “${doc.fileName}”: ${String(e)}`);
        }
      }
    } finally {
      finishDocumentRemoval(request);
      finishDocumentOperation(request);
      finishBusyOperation(busyOperation);
      if (
        (deletionCommitted || deletionOutcomeUncertain || caseRecordRecoveryRequired) &&
        selectedIdRef.current === matterId
      ) {
        recordHeadingRef.current?.focus();
      }
    }
  }

  async function openSessionReview(session: SessionListItem) {
    if (!selectedId) return;
    const matterId = selectedId;
    const request = ++sessionReviewRequest.current;
    invalidateReportGenerationUi();
    setSessionArtifactError(null);
    sessionReviewTargetRef.current = null;
    setReviewLoadingId(session.id);
    setError(null);
    try {
      const review = (await window.api.getSessionReview(matterId, session.id)) as SessionReviewData;
      if (
        request !== sessionReviewRequest.current ||
        selectedIdRef.current !== matterId ||
        review.session.id !== session.id ||
        review.session.matterId !== matterId
      ) {
        return;
      }
      const targetKey = sessionOperationKey(matterId, session.id);
      const cached = generatedReportCache.current.get(targetKey);
      const reportTimestamp = (generatedAt: string | undefined) => {
        const timestamp = generatedAt ? Date.parse(generatedAt) : Number.NaN;
        return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
      };
      const cachedGeneratedAt = reportTimestamp(cached?.report.generatedAt);
      const loadedGeneratedAt = reportTimestamp(review.report?.generatedAt);
      sessionReviewTargetRef.current = targetKey;
      setSessionReview(
        cached && cachedGeneratedAt >= loadedGeneratedAt
          ? mergeGeneratedReport(review, cached)
          : review
      );
      // The cache only bridges a closed-drawer/read race; once compared, the
      // live drawer or disk-backed review owns the result.
      generatedReportCache.current.delete(targetKey);
      const activeGeneration = activeReportGenerations.current.get(targetKey);
      const cachedFailure = reportGenerationFailureCache.current.get(targetKey);
      setReportGeneration(
        activeGeneration === undefined
          ? cachedFailure ?? null
          : {
              request: activeGeneration,
              matterId,
              sessionId: session.id,
              busy: true,
              error: null,
              status: null,
            }
      );
    } catch (e) {
      if (request === sessionReviewRequest.current && selectedIdRef.current === matterId) {
        setError(`Could not open session review: ${String(e)}`);
      }
    } finally {
      if (request === sessionReviewRequest.current) setReviewLoadingId(null);
    }
  }

  async function generateSavedSessionReport() {
    const review = sessionReview;
    if (!review) return;
    const matterId = review.session.matterId;
    const sessionId = review.session.id;
    const targetKey = sessionOperationKey(matterId, sessionId);

    // Ref-backed ownership closes the same-tick render window and also prevents
    // closing/reopening a drawer from launching a duplicate writer for this report.
    if (activeReportGenerations.current.has(targetKey)) return;
    if (
      review.report &&
      !confirm(
        "Regenerate this performance report?\n\nThe current coaching analysis will be replaced. The saved transcript will not change."
      )
    ) {
      return;
    }

    const request = ++reportGenerationSequence.current;
    reportGenerationFailureCache.current.delete(targetKey);
    activeReportGenerations.current.set(targetKey, request);
    setActiveReportGenerationKeys((current) => {
      const next = new Set(current);
      next.add(targetKey);
      return next;
    });
    setReportGeneration({
      request,
      matterId,
      sessionId,
      busy: true,
      error: null,
      status: null,
    });

    const operationIsCurrent = () =>
      activeReportGenerations.current.get(targetKey) === request;
    const displayedReviewMatches = () =>
      selectedIdRef.current === matterId && sessionReviewTargetRef.current === targetKey;

    try {
      const generated = (await window.api.generateSessionReport(
        matterId,
        sessionId
      )) as GeneratedSessionReportResult;
      if (!operationIsCurrent()) return;
      if (
        generated.session.id !== sessionId ||
        generated.session.matterId !== matterId ||
        !generated.report
      ) {
        throw new Error("The generated report did not match this saved session.");
      }
      const mergedReview = mergeGeneratedReport(review, generated);
      reportGenerationFailureCache.current.delete(targetKey);

      if (displayedReviewMatches()) {
        setSessionReview(mergedReview);
        setReportGeneration({
          request,
          matterId,
          sessionId,
          busy: false,
          error: null,
          status: review.report
            ? "Performance report regenerated."
            : "Performance report generated.",
        });
      } else {
        // Cache only the small report result. Reopening loads the transcript once
        // from disk and merges this result if it is newer than that disk review.
        generatedReportCache.current.delete(targetKey);
        generatedReportCache.current.set(targetKey, generated);
        while (generatedReportCache.current.size > MAX_CACHED_GENERATED_REPORTS) {
          const oldestKey = generatedReportCache.current.keys().next().value;
          if (typeof oldestKey !== "string") break;
          generatedReportCache.current.delete(oldestKey);
        }
      }

      // Refresh only this matter's table. Do not even claim the global list token
      // after navigation, since that could invalidate the new matter's detail load.
      if (selectedIdRef.current === matterId) {
        const sessionsRequest = ++sessionListRequest.current;
        void window.api
          .listSessions(matterId)
          .then((result) => {
            if (
              sessionsRequest === sessionListRequest.current &&
              selectedIdRef.current === matterId
            ) {
              setSessions((result.sessions || []) as SessionListItem[]);
              setSessionDataErrors(result.dataErrors || []);
            }
          })
          .catch((e) => {
            if (!displayedReviewMatches()) return;
            setReportGeneration((current) =>
              current?.request === request
                ? {
                    ...current,
                    status: `Report generated, but the session list could not refresh: ${String(e)}`,
                  }
                : current
            );
          });
      }
    } catch (e) {
      if (!operationIsCurrent()) return;
      const detail = e instanceof Error ? e.message : String(e);
      const failure = {
        request,
        matterId,
        sessionId,
        busy: false,
        error: detail,
        status: null,
      } satisfies ReportGenerationState;
      reportGenerationFailureCache.current.delete(targetKey);
      reportGenerationFailureCache.current.set(targetKey, failure);
      while (reportGenerationFailureCache.current.size > MAX_CACHED_GENERATED_REPORTS) {
        const oldestKey = reportGenerationFailureCache.current.keys().next().value;
        if (typeof oldestKey !== "string") break;
        reportGenerationFailureCache.current.delete(oldestKey);
      }
      if (displayedReviewMatches()) {
        setReportGeneration(failure);
      } else {
        setError(
          `Performance report generation failed: ${detail}. Reopen this saved session to retry.`
        );
      }
    } finally {
      if (activeReportGenerations.current.get(targetKey) === request) {
        activeReportGenerations.current.delete(targetKey);
        setActiveReportGenerationKeys((current) => {
          if (!current.has(targetKey)) return current;
          const next = new Set(current);
          next.delete(targetKey);
          return next;
        });
      }
    }
  }

  async function deleteSavedSession(session: SessionListItem) {
    const matterId = selectedIdRef.current;
    if (!matterId) return;
    const targetKey = sessionOperationKey(matterId, session.id);
    if (activeSessionDeletions.current.has(targetKey)) return;

    if (voiceReconciliationPendingRef.current) {
      setError("Wait for the previous-session check before deleting saved sessions.");
      return;
    }
    if (voiceReconciliationError) {
      setError("Retry the previous-session check before deleting saved sessions.");
      return;
    }
    if (live || sessionStartPhaseRef.current !== "idle" || saveRetryMatterIdRef.current) {
      setError("End or save the retained voice session before deleting saved sessions.");
      return;
    }
    if (activeReportGenerations.current.has(targetKey)) {
      setError("Wait for this session’s performance report to finish before deleting it.");
      return;
    }

    const personaName = personasById.get(session.personaId)?.fullName || "Unknown person";
    const startedAt = formatSessionDate(session.startedAt);
    if (
      !confirm(
        `Delete saved session “${session.id}” for ${personaName} from ${startedAt}?\n\nIts transcript and performance report will be permanently deleted. This cannot be undone.`
      )
    ) {
      return;
    }

    // Confirmation may have remained open while the originating UI was being replaced.
    if (
      selectedIdRef.current !== matterId ||
      voiceReconciliationPendingRef.current ||
      Boolean(voiceReconciliationError) ||
      sessionStartPhaseRef.current !== "idle" ||
      saveRetryMatterIdRef.current ||
      activeReportGenerations.current.has(targetKey) ||
      activeSessionDeletions.current.has(targetKey)
    ) {
      return;
    }

    const operation = ++sessionDeletionSequence.current;
    activeSessionDeletions.current.set(targetKey, operation);
    setDeletingSessionKeys((current) => {
      const next = new Set(current);
      next.add(targetKey);
      return next;
    });
    setError(null);
    try {
      const result = await window.api.deleteSession(matterId, session.id);
      if (result.deleted !== session.id) {
        throw new Error("The deletion result did not match the requested saved session.");
      }
      if (
        activeSessionDeletions.current.get(targetKey) !== operation ||
        selectedIdRef.current !== matterId
      ) {
        return;
      }

      // Invalidate only this still-selected matter's list request so a slower
      // refresh cannot resurrect the successfully deleted session.
      sessionListRequest.current += 1;
      setSessions((current) => current.filter((item) => item.id !== session.id));
      if (sessionReviewTargetRef.current === targetKey) {
        sessionReviewRequest.current += 1;
        sessionReviewTargetRef.current = null;
        setSessionReview(null);
        invalidateReportGenerationUi();
      }
      setNotice(`Deleted the saved session for ${personaName} from ${startedAt}.`);
      window.setTimeout(() => {
        if (selectedIdRef.current === matterId) sessionsHeadingRef.current?.focus();
      }, 0);
    } catch (e) {
      if (
        activeSessionDeletions.current.get(targetKey) === operation &&
        selectedIdRef.current === matterId
      ) {
        setError(`Could not delete the saved session for ${personaName}: ${String(e)}`);
      }
    } finally {
      if (activeSessionDeletions.current.get(targetKey) === operation) {
        activeSessionDeletions.current.delete(targetKey);
        setDeletingSessionKeys((current) => {
          if (!current.has(targetKey)) return current;
          const next = new Set(current);
          next.delete(targetKey);
          return next;
        });
      }
    }
  }

  async function openSessionArtifact(
    matterId: string,
    sessionId: string,
    kind: "transcript" | "report"
  ) {
    const targetKey = sessionOperationKey(matterId, sessionId);
    const showFailure = (message: string) => {
      if (sessionReviewTargetRef.current === targetKey) {
        setSessionArtifactError(message);
      } else {
        setError(`Could not open file: ${message}`);
      }
    };
    if (sessionReviewTargetRef.current === targetKey) setSessionArtifactError(null);
    try {
      const result = await window.api.openSessionArtifact(matterId, sessionId, kind);
      if (typeof result === "string" && result) showFailure(result);
    } catch (e) {
      showFailure(String(e));
    }
  }

  function openNewPersona() {
    clearModalError("persona");
    setPersonaForm({
      id: "",
      fullName: "",
      role: "",
      attitude: "neutral",
      notes: "",
      keyterms: "",
      voice: "",
    });
    setShowPersona(true);
  }

  function selectSessionPersona(personaId: string) {
    sessionPersonaIdRef.current = personaId;
    setSessionPersonaId(personaId);
    setSessionVoice("");
  }

  function openEditPersona(p: Persona) {
    clearModalError("persona");
    setPersonaForm({
      id: p.id,
      fullName: p.fullName,
      role: p.role,
      attitude: p.attitude,
      notes: p.notes,
      keyterms: (p.keyterms || []).join(", "),
      voice: p.voice || "",
    });
    setShowPersona(true);
  }

  async function savePersona() {
    if (!selectedId || !personaForm.fullName.trim()) return;
    setModalOperation("persona");
    setModalError(null);
    const busyOperation = beginBusyOperation();
    try {
      await window.api.savePersona(selectedId, {
        id: personaForm.id || undefined,
        fullName: personaForm.fullName,
        role: personaForm.role,
        attitude: personaForm.attitude,
        notes: personaForm.notes,
        keyterms: personaForm.keyterms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        voice: personaForm.voice,
      });
      setShowPersona(false);
      setPersonaForm({
        id: "",
        fullName: "",
        role: "",
        attitude: "neutral",
        notes: "",
        keyterms: "",
        voice: "",
      });
      await loadMatterDetail(selectedId);
    } catch (e) {
      setModalError({ modal: "persona", message: String(e) });
    } finally {
      setModalOperation((current) => (current === "persona" ? null : current));
      finishBusyOperation(busyOperation);
    }
  }

  async function removePersona() {
    if (!selectedId || !personaForm.id) return;
    if (!confirm(`Delete ${personaForm.fullName || "this person"}?`)) return;
    const matterId = selectedId;
    const personaId = personaForm.id;
    setModalOperation("persona");
    setModalError(null);
    const busyOperation = beginBusyOperation();
    try {
      await window.api.deletePersona(matterId, personaId);
      setShowPersona(false);
      await loadMatterDetail(matterId);
    } catch (e) {
      setModalError({ modal: "persona", message: String(e) });
    } finally {
      setModalOperation((current) => (current === "persona" ? null : current));
      finishBusyOperation(busyOperation);
    }
  }

  async function saveSettings() {
    const request = ++settingsRequest.current;
    const busyOperation = beginBusyOperation();
    setSettingsSaving(true);
    try {
      const publicS = await window.api.saveSettings({
        defaultVoice: voice,
      });
      if (request !== settingsRequest.current) return;
      setKeyMeta({
        hasKey: publicS.hasKey,
        keyLast4: publicS.keyLast4,
        keySource: publicS.keySource,
        encryptionAvailable: publicS.encryptionAvailable !== false,
      });
      setError(null);
      setNotice("Settings saved on this device.");
    } catch (e) {
      if (request === settingsRequest.current) setError(String(e));
    } finally {
      // The global busy lock prevents a second save from owning this flag. A
      // newer settings read may supersede the response while navigation is in
      // flight, but it must not leave the Save action permanently loading.
      setSettingsSaving(false);
      finishBusyOperation(busyOperation);
    }
  }

  async function importApiKeyFromClipboard() {
    if (keyImportingRef.current) return;
    const request = ++settingsRequest.current;
    keyImportingRef.current = true;
    setKeyImporting(true);
    setKeyImportFeedback(null);
    try {
      const result = await window.api.importApiKeyFromClipboard();
      if (request !== settingsRequest.current) return;
      setKeyMeta({
        hasKey: result.settings.hasKey,
        keyLast4: result.settings.keyLast4,
        keySource: result.settings.keySource,
        encryptionAvailable: result.settings.encryptionAvailable !== false,
      });
      setKeyImportFeedback(
        result.imported
          ? {
              tone: "success",
              message:
                "API key imported and encrypted. Any still-matching clipboard value was cleared.",
            }
          : {
              tone: "neutral",
              message: "Import canceled. The clipboard was not read or changed.",
            }
      );
    } catch {
      if (request === settingsRequest.current) {
        setKeyImportFeedback({
          tone: "error",
          message: "Could not import an API key. Check the clipboard and try again.",
        });
      }
    } finally {
      keyImportingRef.current = false;
      setKeyImporting(false);
    }
  }

  async function clearStoredKey() {
    const request = ++settingsRequest.current;
    const busyOperation = beginBusyOperation();
    try {
      const publicS = await window.api.saveSettings({ clearApiKey: true, defaultVoice: voice });
      if (request !== settingsRequest.current) return;
      setKeyMeta({
        hasKey: publicS.hasKey,
        keyLast4: publicS.keyLast4,
        keySource: publicS.keySource,
        encryptionAvailable: publicS.encryptionAvailable !== false,
      });
      setKeyImportFeedback(null);
      setError(null);
    } catch (e) {
      if (request === settingsRequest.current) setError(String(e));
    } finally {
      finishBusyOperation(busyOperation);
    }
  }

  async function openDiagnosticsFolder() {
    if (diagnosticsOpeningRef.current) return;
    diagnosticsOpeningRef.current = true;
    setDiagnosticsOpening(true);
    setDiagnosticsFeedback(null);
    try {
      await window.api.openDiagnostics();
      setDiagnosticsFeedback({
        tone: "success",
        message: "Diagnostics folder opened.",
      });
    } catch {
      setDiagnosticsFeedback({
        tone: "error",
        message: "Could not open the diagnostics folder. Try again or restart the app.",
      });
    } finally {
      diagnosticsOpeningRef.current = false;
      setDiagnosticsOpening(false);
    }
  }

  function setOwnedSessionStartPhase(phase: SessionStartPhase) {
    sessionStartPhaseRef.current = phase;
    setSessionStartPhase(phase);
  }

  async function cancelSessionStart() {
    if (sessionStartPhaseRef.current !== "starting") return;

    const request = ++voiceStartRequest.current;
    const host = examHost();
    finishBusyOperation(voiceBusyOperationRef.current);
    const busyOperation = beginBusyOperation();
    voiceBusyOperationRef.current = busyOperation;
    setOwnedSessionStartPhase("cancelling");
    setError(null);
    host.__examGeneration = (host.__examGeneration ?? 0) + 1;

    try {
      if (host.__examCleanup) await host.__examCleanup();
      await window.api.stopVoice(false);
      if (voiceStartRequest.current === request) setStatus("idle");
    } catch (e) {
      if (voiceStartRequest.current === request) {
        const matterId = voiceOwnerMatterRef.current || selectedIdRef.current;
        if (matterId) markSaveRetryPending(matterId, e);
        else setError(`Could not cancel voice startup: ${String(e)}`);
      }
    } finally {
      if (voiceStartRequest.current === request) {
        setOwnedSessionStartPhase("idle");
        setLive(false);
      }
      finishBusyOperation(busyOperation);
      if (voiceBusyOperationRef.current === busyOperation) voiceBusyOperationRef.current = null;
    }
  }

  function closeXaiProcessingAcknowledgement() {
    setShowXaiProcessingAcknowledgement(false);
    setXaiProcessingConsentChecked(false);
  }

  function requestSessionStart() {
    if (xaiProcessingAcknowledged) {
      void startSession();
      return;
    }
    setXaiProcessingConsentChecked(false);
    setShowXaiProcessingAcknowledgement(true);
  }

  function acknowledgeXaiProcessingAndStart() {
    if (!xaiProcessingConsentChecked) return;
    storeXaiProcessingAcknowledgement();
    setXaiProcessingAcknowledged(true);
    setShowXaiProcessingAcknowledgement(false);
    setXaiProcessingConsentChecked(false);
    void startSession();
  }

  async function startSession() {
    const startBlockReason = getPracticeSessionStartBlockReason();
    if (startBlockReason) {
      setError(startBlockReason);
      return;
    }

    const matterId = selectedIdRef.current!;
    const personaId = sessionPersonaIdRef.current;
    const request = ++voiceStartRequest.current;
    const busyOperation = beginBusyOperation();
    voiceBusyOperationRef.current = busyOperation;
    voiceOwnerMatterRef.current = matterId;
    setOwnedSessionStartPhase("starting");
    setError(null);
    setTranscript([]);
    setToolLog([]);
    setSavedArtifacts({});
    mutedIntentRef.current = false;
    setMuted(false);
    resetMicTelemetry();
    setMicInfo("");
    stickTranscriptToBottom.current = true;

    const host = examHost();
    let generation: number | null = null;
    let player: PcmPlayer | null = null;
    let mic: MicStreamer | null = null;
    let offAudio: (() => void) | null = null;
    let voiceStarted = false;
    let cleaned = false;
    let cleanupFn: (() => Promise<void>) | null = null;
    let micMeterTimer: number | null = null;
    let pendingMicLevel = 0;
    let lastMicMeterPaint = Number.NEGATIVE_INFINITY;
    const stillMine = () =>
      voiceStartRequest.current === request &&
      generation !== null &&
      host.__examGeneration === generation;

    const cancelMicMeterTimer = () => {
      if (micMeterTimer !== null) window.clearTimeout(micMeterTimer);
      micMeterTimer = null;
    };

    const flushMicMeter = () => {
      micMeterTimer = null;
      if (!stillMine()) return;
      lastMicMeterPaint = performance.now();
      paintMicLevel(pendingMicLevel);
    };

    const publishMicTelemetry = (level: number, framesSent: number) => {
      if (!stillMine()) return;
      if (framesSent > 0 && !hasMicAudioRef.current) {
        hasMicAudioRef.current = true;
        setHasMicAudio(true);
      }

      pendingMicLevel = level;
      const elapsed = performance.now() - lastMicMeterPaint;
      if (elapsed >= MIC_METER_INTERVAL_MS) {
        cancelMicMeterTimer();
        flushMicMeter();
      } else if (micMeterTimer === null) {
        micMeterTimer = window.setTimeout(
          flushMicMeter,
          Math.max(0, MIC_METER_INTERVAL_MS - elapsed)
        );
      }
    };

    try {
      // Serialize against a previous session's async cleanup. The request token
      // also lets Cancel win while this await is still retiring the old owner.
      const previousCleanup = host.__examCleanup;
      if (previousCleanup) {
        try {
          await previousCleanup();
        } catch {
          /* best-effort */
        }
      }
      if (voiceStartRequest.current !== request) return;

      generation = (host.__examGeneration ?? 0) + 1;
      host.__examGeneration = generation;

      /** One stable, owned cleanup closes whichever resources this start has acquired. */
      const ownedCleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        cancelMicMeterTimer();
        try {
          offAudio?.();
        } catch {
          /* ignore */
        }
        offAudio = null;
        try {
          mic?.setStatusHandler(null);
          mic?.setMuted(true);
          await mic?.stop();
        } catch {
          /* ignore */
        }
        try {
          player?.flush();
          await player?.close();
        } catch {
          /* ignore */
        }
        // Only clear host slots we still own (never clobber a newer session)
        if (host.__examMic === mic) host.__examMic = undefined;
        if (host.__examPlayer === player) host.__examPlayer = undefined;
        if (host.__examCleanup === ownedCleanup) host.__examCleanup = undefined;
        if (voiceStartRequest.current === request) {
          resetMicTelemetry();
          setMicInfo("");
        }
      };
      cleanupFn = ownedCleanup;
      // Install before any await that can disconnect or be cancelled.
      host.__examCleanup = ownedCleanup;

      // Audio output must be ready before main opens the realtime session: the
      // service can emit its forced opening while the start IPC is still pending.
      // Resuming here also stays within the Begin button's user-activation turn.
      player = new PcmPlayer();
      host.__examPlayer = player;
      await player.resume();

      if (!stillMine()) {
        await ownedCleanup();
        return;
      }

      audioDropNoted.current = false;
      offAudio = window.api.onVoiceAudio((payload) => {
        if (!player) return;
        if (player.enqueueBase64(payload.delta)) return;
        if (audioDropNoted.current) return;
        audioDropNoted.current = true;
        setError(
          "Live audio was skipped because playback fell behind. The saved transcript is unaffected."
        );
      });

      const persona = personas.find((p) => p.id === personaId);
      await window.api.startVoice({
        matterId,
        personaId,
        mode: sessionMode,
        // Witness-specific voice wins; else Settings default
        voice: sessionVoice || persona?.voice || voice || undefined,
      });
      voiceStarted = true;

      if (!stillMine()) {
        await ownedCleanup();
        await window.api.stopVoice(false);
        return;
      }

      setStatus("open");
      // Record the identity this transcript is actually being taken with, so a
      // later persona/mode selection cannot relabel the recorded testimony.
      setSessionIdentity({ personaName: persona?.fullName || "", mode: sessionMode });
      setView("session");
      // live so End works during mic permission prompt; invalidated if disconnect races us
      setLive(true);

      mic = new MicStreamer();
      host.__examMic = mic;
      mic.setStatusHandler((s) => {
        publishMicTelemetry(s.level, s.framesSent);
      });

      try {
        const { sampleRate } = await mic.start((b64) => {
          window.api.sendAudio(b64);
        });
        // Disconnect during the permission prompt invalidates generation
        if (!stillMine()) {
          // Cleanup may already have run before getUserMedia resolved, so stop
          // the now-acquired stream directly as well.
          await mic.stop();
          await ownedCleanup();
          return;
        }
        setMicInfo(`Mic live @ ${sampleRate} Hz → 24 kHz PCM`);
        // Apply the latest intent, not the pre-permission default. A user may
        // mute while getUserMedia is waiting on the operating-system prompt.
        mic.setMuted(mutedIntentRef.current);
      } catch (micErr) {
        if (!stillMine()) {
          await mic.stop();
          return;
        }
        const msg = micErr instanceof Error ? micErr.message : String(micErr);
        throw new Error(
          `Microphone failed: ${msg}. On Windows: Settings → Privacy → Microphone → allow desktop apps.`
        );
      }
    } catch (e) {
      try {
        await cleanupFn?.();
      } catch {
        /* best-effort audio cleanup */
      }
      let retainedSaveError: unknown = null;
      if (voiceStarted && stillMine()) {
        try {
          await window.api.stopVoice(false);
        } catch (stopError) {
          retainedSaveError = stopError;
        }
      }
      if (voiceStartRequest.current !== request) return;
      resetMicTelemetry();
      setMicInfo("");
      setLive(false);
      if (retainedSaveError) {
        markSaveRetryPending(matterId, retainedSaveError);
      } else {
        setError(String(e));
        setStatus("error");
      }
    } finally {
      if (voiceStartRequest.current === request) {
        setOwnedSessionStartPhase("idle");
      }
      finishBusyOperation(busyOperation);
      if (voiceBusyOperationRef.current === busyOperation) voiceBusyOperationRef.current = null;
    }
  }

  async function endSession(withReport: boolean) {
    const matterId = voiceOwnerMatterRef.current || selectedIdRef.current;
    if (!matterId) return;
    const request = ++sessionEndRequest.current;
    const stillOwnsMatterUi = () =>
      sessionEndRequest.current === request && selectedIdRef.current === matterId;
    const busyOperation = beginBusyOperation();
    setError(null);
    const host = examHost();
    try {
      if (sessionStartPhaseRef.current === "starting") {
        voiceStartRequest.current += 1;
        setOwnedSessionStartPhase("idle");
        finishBusyOperation(voiceBusyOperationRef.current);
        voiceBusyOperationRef.current = null;
      }
      // Invalidate in-flight start before teardown
      host.__examGeneration = (host.__examGeneration ?? 0) + 1;
      if (host.__examCleanup) await host.__examCleanup();
      setLive(false);
      // stopVoice persists the transcript; with report it then awaits Grok (up to ~2 min)
      if (stillOwnsMatterUi()) setStatus(withReport ? "generating_report" : "saving");
      const result = (await window.api.stopVoice(withReport)) as VoiceStopResult;
      const stoppedMatterId = result.session?.matterId || matterId;
      const ownsStoppedUi =
        sessionEndRequest.current === request && selectedIdRef.current === stoppedMatterId;
      if (ownsStoppedUi) {
        clearSaveRetryPending(stoppedMatterId);
        setSavedArtifacts({
          matterId: stoppedMatterId,
          sessionId: result.session?.id,
          canOpenTranscript: result.canOpenTranscript,
          canOpenReport: result.canOpenReport,
        });
        setStatus("ended");
      }
      if (withReport && !result.canOpenReport && ownsStoppedUi) {
        setError(
          result.canOpenTranscript
            ? "Transcript was saved, but the session report was not produced. Check the error banner or try again from Settings if the API key failed."
            : "The session record was saved, but neither the transcript export nor the session report was produced. The testimony remains available in Past sessions."
        );
      }
      if (stoppedMatterId && ownsStoppedUi) {
        const sessionsRequest = ++sessionListRequest.current;
        try {
          const listed = await window.api.listSessions(stoppedMatterId);
          if (
            sessionsRequest === sessionListRequest.current &&
            sessionEndRequest.current === request &&
            selectedIdRef.current === stoppedMatterId
          ) {
            setSessions((listed.sessions || []) as SessionListItem[]);
            setSessionDataErrors(listed.dataErrors || []);
          }
        } catch {
          /* non-fatal */
        }
      }
    } catch (e) {
      // The save failure is real no matter which screen the user reached during
      // the await. markSaveRetryPending is matter-scoped global state whose
      // banner and locks render on every view; gating it on current-view
      // ownership would leave unsaved testimony invisibly retained in main.
      markSaveRetryPending(matterId, e);
    } finally {
      finishBusyOperation(busyOperation);
    }
  }

  function toggleMute() {
    const next = !mutedIntentRef.current;
    mutedIntentRef.current = next;
    setMuted(next);
    examHost().__examMic?.setMuted(next);
  }

  /** Refuse to leave the session view while mic/voice are live (unless user ends the exam). */
  function leaveSessionView(next: View) {
    if (saveRetryMatterIdRef.current && next !== "session") {
      setError("Retry saving the retained session before leaving this screen.");
      return;
    }
    if (sessionStartPhaseRef.current !== "idle" && next !== "session") {
      setError(
        sessionStartPhaseRef.current === "cancelling"
          ? "Wait for voice startup to finish cancelling before leaving this screen."
          : "Cancel voice startup before leaving this screen."
      );
      return;
    }
    if (live && next !== "session") {
      setError("End the live exam before leaving this screen. Use End + report or End only.");
      return;
    }
    if (next !== "matter") {
      matterDetailRequest.current += 1;
      sessionReviewRequest.current += 1;
      invalidateReportGenerationUi();
      finishBusyOperation(matterOpenBusyOperationRef.current);
      matterOpenBusyOperationRef.current = null;
      setReviewLoadingId(null);
      sessionReviewTargetRef.current = null;
      setSessionReview(null);
    }
    setView(next);
    // A detail request may have been cancelled while another screen was open.
    if (next === "matter" && selectedIdRef.current) {
      void loadMatterDetail(selectedIdRef.current);
    }
  }

  async function restoreFirstBrokenMatter() {
    // Parse matter UUID from dataErrors if present; else no-op
    const uuidRe =
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
    for (const msg of dataErrors) {
      const m = msg.match(uuidRe);
      if (!m) continue;
      const busyOperation = beginBusyOperation();
      try {
        const result = await window.api.restoreMatterMeta(m[0]!);
        if (result.ok) {
          setError(null);
          setNotice(`Restored matter from ${result.restoredFrom ?? "backup"}.`);
          await refreshMatters();
        } else {
          setError(result.error || "Restore failed");
        }
      } catch (e) {
        setError(String(e));
      } finally {
        finishBusyOperation(busyOperation);
      }
      return;
    }
    setError("No matter id found in data errors to restore.");
  }

  async function restoreFirstBrokenSession() {
    const matterId = selectedIdRef.current;
    if (!matterId) return;
    const uuidRe =
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
    const sessionId = sessionDataErrors
      .map((message) => message.match(uuidRe)?.[0])
      .find((value): value is string => Boolean(value));
    if (!sessionId) {
      setError("No recoverable session id was found in the saved-session warning.");
      return;
    }

    const busyOperation = beginBusyOperation();
    setError(null);
    try {
      const result = await window.api.restoreSession(matterId, sessionId);
      if (!result.ok) {
        setError(result.error || "Session restore failed.");
        return;
      }
      const sessionsRequest = ++sessionListRequest.current;
      const refreshed = await window.api.listSessions(matterId);
      if (
        sessionsRequest !== sessionListRequest.current ||
        selectedIdRef.current !== matterId
      ) return;
      setSessions((refreshed.sessions || []) as SessionListItem[]);
      setSessionDataErrors(refreshed.dataErrors || []);
      setNotice(`Restored saved session from ${result.restoredFrom ?? "backup"}.`);
    } catch (e) {
      if (selectedIdRef.current === matterId) setError(`Session restore failed: ${String(e)}`);
    } finally {
      finishBusyOperation(busyOperation);
    }
  }

  const activePersona = personas.find((p) => p.id === sessionPersonaId);
  const personasById = useMemo(
    () => new Map(personas.map((persona) => [persona.id, persona])),
    [personas]
  );
  const saveRetryMatter = saveRetryMatterId
    ? matters.find((matter) => matter.id === saveRetryMatterId) ?? null
    : null;

  // The recorded session's own identity outranks the live practice-form
  // selections when labeling an existing transcript.
  const recordedPersonaName = sessionIdentity?.personaName || activePersona?.fullName || "";
  const recordedMode = sessionIdentity?.mode ?? sessionMode;

  function bubbleLabel(role: string): string {
    if (role === "user") return "Counsel";
    if (role === "assistant") {
      if (recordedMode === "hearing") {
        return recordedPersonaName ? `Court · ${recordedPersonaName}` : "Court";
      }
      return recordedPersonaName || "Witness";
    }
    return "Record";
  }

  function modeLabel(mode: "cross" | "deposition" | "hearing"): string {
    if (mode === "hearing") return "Hearing practice";
    if (mode === "deposition") return "Deposition";
    return "Cross-examination";
  }

  if (!apiReady) {
    return (
      <main className="bridge-failure" id="main-workspace">
        <span className="bridge-failure-index" aria-hidden="true">00</span>
        <h1>Desktop bridge failed to load</h1>
        <p className="sub">
          Cross Examination could not start its secure desktop connection. Close and reopen the
          app. If the problem continues, reinstall the verified build; your retained matter files
          are not removed by reinstalling.
        </p>
      </main>
    );
  }

  return (
    <div className="app-shell" data-view={view} aria-busy={busy}>
      <a className="skip-link" href="#main-workspace">Skip to workspace</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            CE
          </div>
          <div className="brand-text">
            <div className="brand-title">Cross Examination</div>
            <span className="brand-sub">Counsel workspace</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            className={`nav-btn ${view === "matters" || view === "matter" ? "active" : ""}`}
            onClick={() => leaveSessionView(selectedId ? "matter" : "matters")}
            aria-current={view === "matters" || view === "matter" ? "page" : undefined}
          >
            <span className="nav-index" aria-hidden="true">01</span>
            <span>Matters</span>
          </button>
          <button
            className={`nav-btn ${view === "session" ? "active" : ""}`}
            onClick={() => selectedId && leaveSessionView(live || transcript.length ? "session" : "matter")}
            disabled={!selectedId}
            aria-current={view === "session" ? "page" : undefined}
          >
            <span className="nav-index" aria-hidden="true">02</span>
            <span>Live exam</span>
          </button>
          <button
            className={`nav-btn ${view === "settings" ? "active" : ""}`}
            onClick={() => leaveSessionView("settings")}
            aria-current={view === "settings" ? "page" : undefined}
          >
            <span className="nav-index" aria-hidden="true">03</span>
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <span className="nav-ico">
              <AppIcon name={theme === "dark" ? "sun" : "moon"} size={17} />
            </span>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <div className="sidebar-foot-meta">
            <span className="privacy-dot" aria-hidden="true" />
            <p>On-device matter files<br />External xAI processing</p>
          </div>
        </div>
      </aside>

      <main className="main" id="main-workspace" tabIndex={-1}>
        {!online && (
          <div className="offline-notice" role="status" aria-live="polite">
            <strong>Working offline</strong>
            <span>Matter files remain available. Voice and report requests need a connection.</span>
          </div>
        )}
        {saveRetryMatterId && view !== "session" && (
          <div className="retained-session-warning" role="alert">
            <div>
              <strong>Recovered session still needs saving</strong>
              <span>
                {saveRetryMatter
                  ? `${saveRetryMatter.caption} is held safely in memory. Save it before opening another matter or starting an exam.`
                  : "The prior session is held safely in memory. Save it before opening a matter or starting an exam."}
              </span>
            </div>
            <button
              type="button"
              className="danger"
              disabled={retryingRetainedSave}
              onClick={() => void retryRetainedSave()}
            >
              {retryingRetainedSave ? "Retrying save…" : "Retry save"}
            </button>
          </div>
        )}
        {voiceReconciliationError && !saveRetryMatterId && (
          <div className="retained-session-warning" role="alert">
            <div>
              <strong>Previous-session check required</strong>
              <span>
                The app could not confirm that it is safe to start another voice session.
              </span>
            </div>
            <button
              type="button"
              disabled={voiceReconciliationPending}
              onClick={retryVoiceReconciliationCheck}
            >
              {voiceReconciliationPending ? "Checking…" : "Retry session check"}
            </button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            {dataErrors.length > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  className="ghost restore-action"
                  disabled={busy}
                  onClick={() => void restoreFirstBrokenMatter()}
                >
                  Restore from backup
                </button>
              </>
            )}
            <button type="button" className="ghost banner-dismiss" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {notice && !error && (
          <div className="notice" role="status">
            {notice}
            <button type="button" className="ghost banner-dismiss" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {view === "matters" && (
          <>
            <div className="header-row">
              <div>
                <h1 ref={pageHeadingRef} tabIndex={-1}>Matters</h1>
                <p className="sub">
                  You are counsel. Open a matter, load the case file, choose a real witness, and examine them by
                  voice.
                </p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setCaption("");
                  setCourt("");
                  setNotes("");
                  clearModalError("create-matter");
                  setShowCreateMatter(true);
                }}
              >
                + New matter
              </button>
            </div>
            <div className="grid-cards" aria-busy={mattersLoading}>
              {mattersLoading && !matters.length && (
                <div
                  className="matter-loading"
                  role="status"
                  aria-label="Loading matters"
                  aria-live="polite"
                >
                  <div>
                    <strong>Opening the local matter ledger…</strong>
                    <span>Checking saved matters and recovery records.</span>
                  </div>
                  <span className="loading-rule" aria-hidden="true" />
                  <span className="loading-rule" aria-hidden="true" />
                  <span className="loading-rule" aria-hidden="true" />
                </div>
              )}
              {matters.map((m, index) => (
                <button
                  key={m.id}
                  className="card matter-row"
                  onClick={() => void openMatter(m.id)}
                >
                  <span className="matter-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="matter-row-copy">
                    <span className="matter-title">{m.caption}</span>
                    <span className="matter-court">{m.court || "Court not set"}</span>
                  </span>
                  <span className="card-meta">Updated {new Date(m.updatedAt).toLocaleDateString()}</span>
                  <span className="matter-arrow" aria-hidden="true"><AppIcon name="arrow-right" size={18} /></span>
                </button>
              ))}
              {!mattersLoading && !matters.length && (
                <div className="card empty">
                  <div className="card-top">
                    <h2>No matters yet</h2>
                  </div>
                  <p>Create a caption, then drop in pleadings, depositions, and exhibits.</p>
                </div>
              )}
            </div>
          </>
        )}

        {view === "matter" && selected && (
          <>
            <div className="header-row matter-header">
              <div>
                <button className="ghost back-link" onClick={() => leaveSessionView("matters")}>
                  <AppIcon name="arrow-left" size={17} />
                  Back to matters
                </button>
                <h1 ref={pageHeadingRef} tabIndex={-1}>{selected.caption}</h1>
                <p className="matter-court">{selected.court || "Court not set"}</p>
                {selected.notes?.trim() ? (
                  <p className="matter-notes">{selected.notes.trim()}</p>
                ) : null}
              </div>
              <div className="matter-header-actions">
                <dl className="matter-overview" aria-label="Matter summary">
                  <div><dt>Indexed documents</dt><dd>{docs.length}</dd></div>
                  <div><dt>People prepared</dt><dd>{personas.length}</dd></div>
                </dl>
                <div className="row">
                  <button type="button" className="ghost" disabled={busy || live} onClick={openEditMatter}>
                    Edit details
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void exportMatter()}
                    title="Export this matter folder as a ZIP archive"
                  >
                    Export zip
                  </button>
                  <button
                    type="button"
                    className="ghost danger-text"
                    disabled={
                      busy ||
                      live ||
                      deletingSessionKeys.size > 0 ||
                      Boolean(saveRetryMatterId) ||
                      [...activeReportGenerationKeys].some((key) =>
                        key.startsWith(`${selected.id}:`)
                      )
                    }
                    onClick={() => void removeMatter()}
                    title="Permanently delete this matter and its local files"
                  >
                    Delete matter
                  </button>
                </div>
              </div>
            </div>

            {matterDataWarning && (
              <div className="matter-data-warning" role="alert">
                <span>{matterDataWarning}</span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setMatterDataWarning(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="matter-content">
              <section
                className="panel record-panel"
                aria-busy={Boolean(selectedDocumentOperation || selectedDocumentRemoval)}
              >
                <div className="panel-head">
                  <div>
                    <h2 ref={recordHeadingRef} className="panel-title" tabIndex={-1}>Case record</h2>
                    <p className="panel-subtitle">Indexed pleadings, testimony, exhibits, and working materials.</p>
                  </div>
                  <div className="row">
                    <button type="button" onClick={() => void importDocs()} disabled={busy}>
                      <AppIcon name="upload" size={17} />
                      {selectedDocumentOperation?.phase === "importing"
                        ? "Importing…"
                        : "Import files"}
                    </button>
                    <button type="button" onClick={() => void reindex()} disabled={busy}>
                      <AppIcon name="refresh" size={17} />
                      {selectedDocumentOperation?.phase === "indexing"
                        ? "Indexing…"
                        : selectedDocumentOperation?.phase === "cancelling"
                          ? "Cancelling…"
                          : "Reindex"}
                    </button>
                  </div>
                </div>
                {selectedDocumentRemoval && (
                  <div className="document-operation">
                    <p role="status" aria-live="polite" aria-atomic="true">
                      Permanently removing “{selectedDocumentRemoval.fileName}” from this matter…
                    </p>
                  </div>
                )}
                {selectedDocumentOperation && (
                  <div className="document-operation">
                    <p role="status" aria-live="polite" aria-atomic="true">
                      {selectedDocumentOperation.phase === "importing"
                        ? "Choose case files in the open dialog. Selected files will be copied locally."
                        : selectedDocumentOperation.phase === "cancelling"
                          ? "Cancelling case record indexing…"
                          : selectedDocumentOperation.removedFileName
                            ? `“${selectedDocumentOperation.removedFileName}” was removed. Rebuilding the case record…`
                          : selectedDocumentOperation.importedCount
                            ? `Imported ${selectedDocumentOperation.importedCount} ${
                                selectedDocumentOperation.importedCount === 1 ? "file" : "files"
                              }. Updating the case record…`
                            : "Rebuilding the case record…"}
                    </p>
                    {selectedDocumentOperation.phase !== "importing" && (
                      <button
                        type="button"
                        className="ghost document-operation-cancel"
                        disabled={selectedDocumentOperation.phase === "cancelling"}
                        onClick={() => void cancelDocumentIndexing()}
                      >
                        {selectedDocumentOperation.phase === "cancelling"
                          ? "Cancelling…"
                          : "Cancel indexing"}
                      </button>
                    )}
                  </div>
                )}
                {selectedDocumentRecovery && !selectedDocumentOperation && !selectedDocumentRemoval && (
                  <div className="document-recovery" role="alert">
                    <div>
                      <strong>Case record refresh required</strong>
                      <span>{documentRecoveryMessage(selectedDocumentRecovery)}</span>
                    </div>
                    <button type="button" disabled={busy} onClick={() => void reindex()}>
                      Reindex now
                    </button>
                  </div>
                )}
                <div className="record-filter" role="search" aria-label="Filter case record">
                  <div className="record-filter-heading">
                    <label htmlFor={documentFilterId}>Filter case record</label>
                    <p
                      id={documentFilterStatusId}
                      className={documentFilterPending ? "pending" : ""}
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {documentFilterFeedback}
                    </p>
                  </div>
                  <div className="record-filter-controls">
                    <input
                      id={documentFilterId}
                      type="search"
                      value={documentQuery}
                      onChange={(event) => setDocumentQuery(event.target.value)}
                      placeholder="Search filename or document type"
                      autoComplete="off"
                      aria-describedby={documentFilterStatusId}
                      disabled={!docs.length}
                    />
                    {documentQuery && (
                      <button
                        type="button"
                        className="ghost record-filter-clear"
                        onClick={() => setDocumentQuery("")}
                        aria-label="Clear case record filter"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div
                  className="table-wrap"
                  aria-busy={documentFilterPending || Boolean(selectedDocumentRemoval)}
                >
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Document name</th>
                        <th>Type</th>
                        <th>Size</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDocs.map((d) => (
                        <tr key={d.id}>
                          <td className="file-name">
                            <span className="file-icon"><AppIcon name="document" size={17} /></span>
                            {d.fileName}
                          </td>
                          <td><span className="doc-type">{d.docType}</span></td>
                          <td className="muted">{d.charCount.toLocaleString()} chars</td>
                          <td className="row-actions">
                            <button
                              type="button"
                              className="ghost table-action"
                              disabled={busy || live}
                              title="Remove from matter"
                              aria-label={
                                selectedDocumentRemoval?.documentId === d.id
                                  ? `Removing ${d.fileName} from this matter`
                                  : `Remove ${d.fileName} from this matter`
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                void removeDoc(d);
                              }}
                            >
                              {selectedDocumentRemoval?.documentId === d.id ? "Removing…" : "Remove"}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!docs.length && (
                        <tr>
                          <td colSpan={4} className="empty-row">
                            No indexed documents. Import files, then reindex the matter.
                          </td>
                        </tr>
                      )}
                      {Boolean(docs.length && normalizedDocumentQuery && !filteredDocs.length) && (
                        <tr>
                          <td colSpan={4} className="empty-row">
                            No documents match “{deferredDocumentQuery.trim()}”.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="panel people-panel">
                <div className="panel-head">
                  <div>
                    <h2 className="panel-title">People</h2>
                    <p className="panel-subtitle">Witnesses, parties, experts, and judges prepared for practice.</p>
                  </div>
                  <button onClick={openNewPersona}>
                    <AppIcon name="user-plus" size={17} />
                    Add person
                  </button>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Role</th>
                        <th>Voice</th>
                        <th>Demeanor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {personas.map((p) => (
                        <tr
                          key={p.id}
                          className={sessionPersonaId === p.id ? "selected-row" : ""}
                        >
                          <td className="file-name">
                            <button
                              type="button"
                              className="person-edit-button"
                              disabled={busy}
                              aria-pressed={sessionPersonaId === p.id}
                              onClick={() => {
                                selectSessionPersona(p.id);
                                openEditPersona(p);
                              }}
                              aria-label={`Select and edit ${p.fullName}`}
                            >
                              <span className="selection-dot" />
                              <span>{p.fullName}</span>
                            </button>
                          </td>
                          <td>{p.role}</td>
                          <td>{voiceLabel(p.voice)}</td>
                          <td className="attitude-text">{p.attitude}</td>
                        </tr>
                      ))}
                      {!personas.length && (
                        <tr>
                          <td colSpan={4} className="empty-row">
                            Add the real person you want to examine or appear before.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <section className="panel exam-launch">
              <div className="panel-head launch-heading">
                <div>
                  <h2 className="panel-title">Practice session</h2>
                  <p className="panel-subtitle">
                    {sessionMode === "hearing"
                      ? "Appear as counsel while the Court presses the record and your weakest points."
                      : "Examine a sworn case participant grounded in this matter’s indexed record."}
                  </p>
                </div>
              </div>
              <div className="session-config">
                <div className="field">
                  <label htmlFor={sessionModeId}>Practice mode</label>
                  <select
                    id={sessionModeId}
                    value={sessionMode}
                    onChange={(e) =>
                      setSessionMode(e.target.value as "cross" | "deposition" | "hearing")
                    }
                  >
                    <option value="cross">Cross-examination</option>
                    <option value="deposition">Deposition practice</option>
                    <option value="hearing">Hearing practice</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={sessionPersonaIdControl}>
                    {sessionMode === "hearing" ? "Presiding judge" : "Person"}
                  </label>
                  <select
                    id={sessionPersonaIdControl}
                    value={sessionPersonaId}
                    onChange={(e) => {
                      selectSessionPersona(e.target.value);
                    }}
                  >
                    <option value="">Select a person…</option>
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>{p.fullName} — {p.role}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={sessionVoiceId}>Session voice</label>
                  <select
                    id={sessionVoiceId}
                    value={sessionVoice}
                    onChange={(e) => setSessionVoice(e.target.value)}
                  >
                    <option value="">
                      {activePersona
                        ? `Default · ${voiceLabel(activePersona.voice || voice, voiceLabel(voice))}`
                        : `App default · ${voiceLabel(voice)}`}
                    </option>
                    {XAI_VOICES.map((v) => (
                      <option key={v.id} value={v.id}>{v.label} — {v.tone}</option>
                    ))}
                  </select>
                </div>
                <button
                  className={`${sessionStartPhase === "starting" ? "danger" : "primary"} session-start`}
                  disabled={
                    sessionStartPhase === "cancelling" ||
                    live ||
                    (sessionStartPhase === "idle" &&
                      Boolean(practiceSessionStartBlockReason))
                  }
                  onClick={() =>
                    sessionStartPhase === "starting"
                      ? void cancelSessionStart()
                      : requestSessionStart()
                  }
                >
                  <AppIcon name={sessionStartPhase === "starting" ? "mic" : "play"} size={18} />
                  {sessionStartPhase === "starting"
                    ? "Cancel startup"
                    : sessionStartPhase === "cancelling"
                      ? "Cancelling…"
                      : voiceReconciliationPending
                        ? "Checking previous session…"
                        : voiceReconciliationError
                          ? "Session check required"
                          : deletingSessionKeys.size > 0
                            ? "Deleting saved session…"
                            : selectedDocumentRecovery
                              ? "Reindex case record first"
                            : selectedDocumentOperation?.phase === "importing"
                              ? "Import in progress"
                              : selectedDocumentOperation?.phase === "indexing"
                                ? "Indexing case record…"
                                : selectedDocumentOperation?.phase === "cancelling"
                                  ? "Cancelling indexing…"
                                  : busy
                                    ? "Please wait…"
                              : live
                                ? "Exam in progress"
                                : sessionMode === "hearing"
                                  ? "Begin hearing"
                                  : "Begin examination"}
                </button>
              </div>
              <div className="session-note">
                <span className="info-mark">i</span>
                {sessionStartPhase === "starting"
                  ? "Connecting to the voice service. Cancel before navigating away if you need to stop."
                  : sessionStartPhase === "cancelling"
                    ? "Cancelling voice startup and releasing audio resources…"
                    : voiceReconciliationPending
                      ? "Checking whether a previous app window left a session that needs to be saved…"
                      : voiceReconciliationError
                        ? "Retry the previous-session check from the alert before beginning."
                        : deletingSessionKeys.size > 0
                          ? "Wait for the saved-session deletion to finish before beginning."
                          : selectedDocumentRecovery
                            ? "Reindex the case record before beginning."
                          : selectedDocumentOperation?.phase === "importing"
                            ? "Choose or cancel the file picker before beginning a practice session."
                            : selectedDocumentOperation
                              ? "Wait for case record indexing to finish, or cancel it from the Case record panel."
                          : live
                            ? "End the live exam before starting another."
                            : !docs.length
                              ? "Index at least one document before beginning."
                              : !sessionPersonaId
                                ? "Select a person to continue."
                                : "The session voice override applies only to this practice session."}
              </div>
              <p className="external-processing-disclosure">
                <strong>External xAI processing.</strong>{" "}
                Beginning sends microphone audio and relevant case context to xAI for live
                voice processing. The live transcript is derived from that audio, and content
                sent to xAI is handled under the data and retention terms for your xAI account.
              </p>
            </section>

            <section className="panel sessions-panel">
              <div className="panel-head">
                <div>
                  <h2 ref={sessionsHeadingRef} className="panel-title" tabIndex={-1}>
                    Past sessions
                  </h2>
                  <p className="panel-subtitle">
                    Transcripts and reports saved under this matter’s sessions folder.
                  </p>
                </div>
              </div>
              {sessionDataErrors.length > 0 && (
                <div className="session-data-warning" role="alert">
                  <div>
                    <strong>Saved-session recovery needed</strong>
                    <span>{sessionDataErrors.join(" · ")}</span>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void restoreFirstBrokenSession()}
                  >
                    Restore from backup
                  </button>
                </div>
              )}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Person</th>
                      <th>Mode</th>
                      <th>Lines</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const targetKey = sessionOperationKey(selected.id, s.id);
                      const personaName =
                        personasById.get(s.personaId)?.fullName || "Unknown person";
                      const startedAt = formatSessionDate(s.startedAt);
                      const deleting = deletingSessionKeys.has(targetKey);
                      const reportGenerating = activeReportGenerationKeys.has(targetKey);
                      const voiceDeletionLocked =
                        voiceReconciliationPending ||
                        Boolean(voiceReconciliationError) ||
                        live ||
                        sessionStartPhase !== "idle" ||
                        Boolean(saveRetryMatterId);
                      return (
                        <tr key={s.id}>
                          <td>
                            <span>{startedAt}</span>
                            {s.unfinished ? (
                              <span
                                className="badge session-unfinished-badge"
                                aria-label="Interrupted session recovered from an automatic checkpoint"
                              >
                                Recovered checkpoint
                              </span>
                            ) : null}
                          </td>
                          <td>{personaName}</td>
                          <td><span className="doc-type">{modeLabel(s.mode)}</span></td>
                          <td className="muted">{s.lineCount}</td>
                          <td className="row-actions">
                            <button
                              type="button"
                              className="ghost table-action review-action"
                              disabled={busy || deleting || reviewLoadingId === s.id}
                              aria-label={
                                reviewLoadingId === s.id
                                  ? `Loading session review for ${personaName}`
                                  : `Review session for ${personaName} from ${startedAt}`
                              }
                              onClick={(event) => {
                                sessionReviewReturnFocusRef.current = event.currentTarget;
                                void openSessionReview(s);
                              }}
                            >
                              {reviewLoadingId === s.id ? "Loading…" : "Review session"}
                            </button>
                            <button
                              type="button"
                              className="ghost table-action delete-session-action"
                              disabled={deleting || reportGenerating || voiceDeletionLocked}
                              aria-label={`Delete saved session for ${personaName} from ${startedAt}`}
                              title={
                                reportGenerating
                                  ? "Wait for report generation to finish"
                                  : voiceReconciliationPending
                                    ? "Wait for the previous-session check to finish"
                                    : voiceReconciliationError
                                      ? "Retry the previous-session check first"
                                  : voiceDeletionLocked
                                      ? "End or save the voice session first"
                                      : "Permanently delete this saved transcript and report"
                              }
                              onClick={() => void deleteSavedSession(s)}
                            >
                              {deleting ? "Deleting…" : "Delete"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!sessions.length && (
                      <tr>
                        <td colSpan={5} className="empty-row">
                          No past exams yet. End a practice session to save a transcript here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        {view === "session" && selected && (
          <>
            <div className="session-header">
              <div className="session-identity">
                <h1 ref={pageHeadingRef} tabIndex={-1}>{selected.caption}</h1>
                <div className="session-meta">
                  <div>
                    <span>{recordedMode === "hearing" ? "Court" : "Witness"}</span>
                    <strong>{recordedPersonaName || "Not selected"}</strong>
                  </div>
                  <div>
                    <span>Mode</span>
                    <strong>{modeLabel(recordedMode)}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong role="status" aria-live="polite">
                      <span className={`status-dot ${live ? "live" : ""}`} />
                      {live
                        ? "On the record"
                        : status === "generating_report"
                          ? "Generating report…"
                          : status === "saving" || status === "closing"
                            ? "Saving transcript…"
                            : status === "save_error"
                              ? "Save needs retry"
                              : status === "ended"
                                ? "Ended"
                                : status || "Idle"}
                    </strong>
                  </div>
                </div>
              </div>
              <div className="session-command">
                {live && (
                  <div className="live-bar">
                    <AppIcon name="mic" size={19} />
                    <div
                      ref={micMeterRef}
                      className="mic-meter"
                      role="meter"
                      aria-label="Microphone input level"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={0}
                      aria-valuetext="0% input level"
                    >
                      <div
                        ref={micMeterFillRef}
                        className="mic-meter-fill"
                      />
                    </div>
                    <span className="mic-meter-label">
                      {muted ? "Muted" : hasMicAudio ? "Mic live" : "Waiting for mic"}
                    </span>
                  </div>
                )}
                <div className="session-actions">
                  <button className="mute-control" onClick={toggleMute} disabled={!live}>
                    <AppIcon name="mic" size={17} />
                    {muted ? "Unmute mic" : "Mute mic"}
                  </button>
                  {sessionStartPhase === "starting" ? (
                    <button className="danger" onClick={() => void cancelSessionStart()}>
                      Cancel startup
                    </button>
                  ) : sessionStartPhase === "cancelling" ? (
                    <button className="danger" disabled>
                      Cancelling…
                    </button>
                  ) : saveRetryMatterId === selected.id ? (
                    <button
                      className="danger"
                      disabled={retryingRetainedSave}
                      onClick={() => void retryRetainedSave()}
                    >
                      {retryingRetainedSave ? "Retrying save…" : "Retry save"}
                    </button>
                  ) : (
                    <>
                      <button
                        className="danger"
                        disabled={busy || !live}
                        onClick={() => void endSession(true)}
                        title="End the exam and generate an impeachment-style report"
                      >
                        {busy && status === "generating_report" ? "Generating report…" : "End + report"}
                      </button>
                      <button disabled={busy || !live} onClick={() => void endSession(false)}>
                        {busy && (status === "saving" || status === "closing") ? "Saving…" : "End only"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="session-layout">
              <section className="panel transcript-panel">
                <div className="panel-head transcript-head">
                  <h2 className="panel-title">Live examination</h2>
                  <span className="transcript-count">{transcript.length} lines</span>
                </div>
                <div
                  className="transcript"
                  ref={transcriptScrollRef}
                  role="log"
                  aria-label="Live transcript"
                  aria-live="polite"
                  aria-relevant="additions text"
                  aria-busy={sessionStartPhase === "starting"}
                  onScroll={() => {
                    const el = transcriptScrollRef.current;
                    if (!el) return;
                    // Stay pinned only while the user is near the bottom (reading history freezes pin).
                    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                    stickTranscriptToBottom.current = gap < 96;
                  }}
                >
                  {transcript.map((t, i) => (
                    <TranscriptBubble
                      key={`${t.at}-${i}`}
                      role={t.role}
                      text={t.text}
                      who={t.role !== "system" ? bubbleLabel(t.role) : "Record"}
                      lineNo={i + 1}
                      isCurrent={i === transcript.length - 1}
                    />
                  ))}
                  {!transcript.length && (
                    <div className="transcript-empty">
                      <AppIcon name="mic" size={24} />
                      <p>The record will appear here after the witness is sworn.</p>
                    </div>
                  )}
                </div>
              </section>
              <aside className="panel activity-panel">
                <div className="panel-head">
                  <div>
                    <h2 className="panel-title">Case file activity</h2>
                    <p className="panel-subtitle">
                      {sessionMode === "hearing"
                        ? "Bench book retrieval as the Court examines you."
                        : "Dossier and record retrieval supporting each answer."}
                    </p>
                  </div>
                </div>
                <div className="activity-label">Recent activity</div>
                <ul className="tool-list">
                  {toolLog.map((t, i) => (
                    <li key={i} className={i === toolLog.length - 1 ? "latest" : ""}>
                      <span className="activity-icon"><AppIcon name={i === 0 ? "document" : "refresh"} size={17} /></span>
                      <span>{t}</span>
                    </li>
                  ))}
                  {!toolLog.length && <li className="activity-empty">Waiting for case-file activity…</li>}
                </ul>
                {savedArtifacts.matterId && savedArtifacts.sessionId &&
                  (savedArtifacts.canOpenTranscript || savedArtifacts.canOpenReport) && (
                  <div className="saved-block">
                    <h3>
                      {savedArtifacts.canOpenTranscript && savedArtifacts.canOpenReport
                        ? "Session files saved"
                        : "Session file saved"}
                    </h3>
                    <p>
                      {savedArtifacts.canOpenTranscript && savedArtifacts.canOpenReport
                        ? "Transcript and report are available in this matter’s session folder."
                        : savedArtifacts.canOpenTranscript
                          ? "The transcript is available in this matter’s session folder."
                          : "The report is available in this matter’s session folder."}
                    </p>
                    <div className="row">
                      {savedArtifacts.canOpenTranscript && (
                        <button
                          onClick={() =>
                            void openSessionArtifact(
                              savedArtifacts.matterId!,
                              savedArtifacts.sessionId!,
                              "transcript"
                            )
                          }
                        >
                          Open transcript
                        </button>
                      )}
                      {savedArtifacts.canOpenReport && (
                        <button
                          className="primary"
                          onClick={() =>
                            void openSessionArtifact(
                              savedArtifacts.matterId!,
                              savedArtifacts.sessionId!,
                              "report"
                            )
                          }
                        >
                          Open report
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {micInfo && <p className="mic-detail">{micInfo}</p>}
              </aside>
            </div>
          </>
        )}
        {view === "settings" && (
          <>
            <div className="header-row">
              <div>
                <h1 ref={pageHeadingRef} tabIndex={-1}>Settings</h1>
                <p className="sub">
                  API keys stay in the main process. Use <code>XAI_API_KEY</code> or the native
                  clipboard import below; this page never receives the key.
                </p>
              </div>
            </div>
            <div className="settings-layout">
            <section className="panel settings-panel" aria-labelledby="settings-preferences-heading">
              <h2 className="panel-title" id="settings-preferences-heading">Workspace preferences</h2>
              <div className="field">
                <span className="field-label" id={appearanceLabelId}>Appearance</span>
                <div className="theme-seg" role="group" aria-labelledby={appearanceLabelId}>
                  <button
                    type="button"
                    className={theme === "dark" ? "active" : ""}
                    onClick={() => setTheme("dark")}
                    aria-pressed={theme === "dark"}
                  >
                    <AppIcon name="moon" size={16} />
                    Dark
                  </button>
                  <button
                    type="button"
                    className={theme === "light" ? "active" : ""}
                    onClick={() => setTheme("light")}
                    aria-pressed={theme === "light"}
                  >
                    <AppIcon name="sun" size={16} />
                    Light
                  </button>
                </div>
                <p className="field-help">
                  Choose the carbon record room or the bone-paper reading desk. Preference is
                  saved on this machine.
                </p>
              </div>
              <div className="field settings-key-field">
                <div className="settings-key-row">
                  <div>
                    <h2>xAI API key</h2>
                    <p id="api-key-status" className="settings-key-status" aria-live="polite">
                      {keyMeta.keySource === "env"
                        ? "Environment key active."
                        : keyMeta.keySource === "stored"
                          ? keyMeta.encryptionAvailable
                            ? `Stored encrypted key · ending ${keyMeta.keyLast4}.`
                            : `Stored plaintext key (OS encryption unavailable) · ending ${keyMeta.keyLast4}.`
                          : "No API key configured."}
                    </p>
                  </div>
                  <div className="settings-key-actions">
                    <button
                      type="button"
                      disabled={busy || keyImporting}
                      aria-describedby={
                        keyImportFeedback
                          ? "api-key-status key-import-help key-import-feedback"
                          : "api-key-status key-import-help"
                      }
                      onClick={() => void importApiKeyFromClipboard()}
                    >
                      {keyImporting
                        ? "Waiting for confirmation…"
                        : "Import key from clipboard…"}
                    </button>
                    {keyMeta.keySource === "stored" && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy || keyImporting}
                        onClick={() => void clearStoredKey()}
                      >
                        Clear stored key
                      </button>
                    )}
                  </div>
                </div>
                <p id="key-import-help" className="settings-key-help">
                  A native confirmation imports the clipboard value in the main process, encrypts
                  it with OS secure storage, and clears the clipboard after success only when it
                  still matches the imported key. The page never reads the clipboard or key.
                </p>
                {keyImportFeedback && (
                  <p
                    id="key-import-feedback"
                    className={`settings-key-feedback ${keyImportFeedback.tone}`}
                    role={keyImportFeedback.tone === "error" ? "alert" : "status"}
                    aria-live={keyImportFeedback.tone === "error" ? "assertive" : "polite"}
                  >
                    {keyImportFeedback.message}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor={defaultVoiceId}>Default witness voice</label>
                <select
                  id={defaultVoiceId}
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                >
                  {XAI_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} — {v.tone}
                    </option>
                  ))}
                </select>
                <p className="field-help">
                  Used when a witness has no voice of their own. Prefer setting voice on each person.
                </p>
              </div>
              <div className="row">
                <button
                  className="primary"
                  disabled={busy || keyImporting}
                  onClick={() => void saveSettings()}
                >
                  {settingsSaving ? "Saving settings…" : "Save settings"}
                </button>
              </div>
            </section>
            <section
              className="settings-support"
              aria-labelledby="settings-support-heading"
            >
              <div>
                <h2 id="settings-support-heading">About &amp; support</h2>
                <p className="settings-support-version" aria-live="polite">
                  {appInfo
                    ? `Cross Examination ${appInfo.version} · Electron ${appInfo.electronVersion}`
                    : appInfoLoading
                      ? "Loading version information…"
                      : "Version information unavailable."}
                </p>
                <p id="diagnostics-help" className="settings-support-help">
                  Open the diagnostics folder when troubleshooting. Its location is not shown in
                  the app.
                </p>
              </div>
              <div className="settings-support-actions">
                <button
                  type="button"
                  disabled={diagnosticsOpening}
                  aria-describedby={
                    diagnosticsFeedback
                      ? "diagnostics-help diagnostics-feedback"
                      : "diagnostics-help"
                  }
                  onClick={() => void openDiagnosticsFolder()}
                >
                  {diagnosticsOpening ? "Opening diagnostics…" : "Open diagnostics folder"}
                </button>
                {diagnosticsFeedback && (
                  <p
                    id="diagnostics-feedback"
                    className={`settings-support-feedback ${diagnosticsFeedback.tone}`}
                    role={diagnosticsFeedback.tone === "error" ? "alert" : "status"}
                    aria-live={diagnosticsFeedback.tone === "error" ? "assertive" : "polite"}
                  >
                    {diagnosticsFeedback.message}
                  </p>
                )}
              </div>
            </section>
            </div>
          </>
        )}
      </main>

      {showXaiProcessingAcknowledgement && (
        <ModalDialog
          title="Before xAI voice processing"
          submitting={false}
          error={null}
          onClose={closeXaiProcessingAcknowledgement}
          onSubmit={acknowledgeXaiProcessingAndStart}
        >
          <div className="processing-consent-copy">
            <p>Live practice uses xAI’s external voice service.</p>
            <ul>
              <li>Your microphone audio is streamed to xAI during the session.</li>
              <li>
                Relevant case-file context and live transcript content are sent to xAI so the
                service can respond in character.
              </li>
              <li>
                The app keeps matter files and saved session artifacts on this device. Content
                sent to xAI is handled under the data and retention terms for your xAI account.
              </li>
            </ul>
          </div>
          <label className="processing-consent-check">
            <input
              type="checkbox"
              data-dialog-initial-focus
              checked={xaiProcessingConsentChecked}
              onChange={(event) => setXaiProcessingConsentChecked(event.target.checked)}
            />
            <span>
              I understand that microphone, case, and transcript content leaves this device for
              xAI processing.
            </span>
          </label>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={!xaiProcessingConsentChecked}
            >
              Acknowledge and begin
            </button>
            <button
              type="button"
              className="ghost"
              onClick={closeXaiProcessingAcknowledgement}
            >
              Cancel
            </button>
          </div>
        </ModalDialog>
      )}

      {showCreateMatter && (
        <ModalDialog
          title="New matter"
          submitting={modalOperation === "create-matter"}
          error={errorForModal("create-matter")}
          onClose={closeCreateMatter}
          onSubmit={() => void createMatter()}
        >
          <div className="field">
            <label htmlFor="create-matter-caption">Caption</label>
            <input
              id="create-matter-caption"
              data-dialog-initial-focus
              required
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Smith v. Jones"
            />
          </div>
          <div className="field">
            <label htmlFor="create-matter-court">Court</label>
            <input
              id="create-matter-court"
              value={court}
              onChange={(e) => setCourt(e.target.value)}
              placeholder="N.D. Ohio"
            />
          </div>
          <div className="field">
            <label htmlFor="create-matter-notes">Notes</label>
            <textarea
              id="create-matter-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || !caption.trim()}
            >
              {modalOperation === "create-matter" ? "Creating…" : "Create matter"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={modalOperation === "create-matter"}
              onClick={closeCreateMatter}
            >
              Cancel
            </button>
          </div>
        </ModalDialog>
      )}

      {showEditMatter && selected && (
        <ModalDialog
          title="Edit matter"
          submitting={modalOperation === "edit-matter"}
          error={errorForModal("edit-matter")}
          onClose={closeEditMatter}
          onSubmit={() => void saveMatterEdits()}
        >
          <div className="field">
            <label htmlFor="edit-matter-caption">Caption</label>
            <input
              id="edit-matter-caption"
              data-dialog-initial-focus
              required
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Smith v. Jones"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-matter-court">Court</label>
            <input
              id="edit-matter-court"
              value={court}
              onChange={(e) => setCourt(e.target.value)}
              placeholder="N.D. Ohio"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-matter-notes">Notes</label>
            <textarea
              id="edit-matter-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || !caption.trim()}
            >
              {modalOperation === "edit-matter" ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={modalOperation === "edit-matter"}
              onClick={closeEditMatter}
            >
              Cancel
            </button>
          </div>
        </ModalDialog>
      )}

      {showPersona && (
        <ModalDialog
          title={personaForm.id ? "Edit person" : "Add real person"}
          submitting={modalOperation === "persona"}
          error={errorForModal("persona")}
          onClose={closePersona}
          onSubmit={() => void savePersona()}
        >
          <div className="field">
            <label htmlFor="persona-full-name">Full name</label>
            <input
              id="persona-full-name"
              data-dialog-initial-focus
              required
              value={personaForm.fullName}
              onChange={(e) => setPersonaForm({ ...personaForm, fullName: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-role">Role</label>
            <input
              id="persona-role"
              value={personaForm.role}
              onChange={(e) => setPersonaForm({ ...personaForm, role: e.target.value })}
              placeholder="Plaintiff / CFO / treating physician"
            />
          </div>
          <div className="field">
            <label htmlFor="persona-voice">Voice (this witness)</label>
            <select
              id="persona-voice"
              value={personaForm.voice}
              onChange={(e) => setPersonaForm({ ...personaForm, voice: e.target.value })}
              aria-describedby="persona-voice-help"
            >
              <option value="">App default ({voiceLabel(voice)})</option>
              {XAI_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {v.tone}
                </option>
              ))}
            </select>
            <p
              id="persona-voice-help"
              className="field-help"
            >
              Each witness can sound different. Custom cloned voices can be pasted as an id later.
            </p>
          </div>
          <div className="field">
            <label htmlFor="persona-attitude">Attitude</label>
            <select
              id="persona-attitude"
              value={personaForm.attitude}
              onChange={(e) => setPersonaForm({ ...personaForm, attitude: e.target.value })}
            >
              {["hostile", "evasive", "cooperative", "neutral", "expert"].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="persona-notes">Counsel notes on demeanor / traps</label>
            <textarea
              id="persona-notes"
              value={personaForm.notes}
              onChange={(e) => setPersonaForm({ ...personaForm, notes: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-keyterms">Key terms (comma-separated)</label>
            <input
              id="persona-keyterms"
              value={personaForm.keyterms}
              onChange={(e) => setPersonaForm({ ...personaForm, keyterms: e.target.value })}
              placeholder="Acme Corp, Exhibit 12, 30(b)(6)"
            />
          </div>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || !personaForm.fullName.trim()}
            >
              {modalOperation === "persona"
                ? "Saving…"
                : personaForm.id
                  ? "Save changes"
                  : "Save person"}
            </button>
            {personaForm.id && selectedId && (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void removePersona()}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="ghost"
              disabled={modalOperation === "persona"}
              onClick={closePersona}
            >
              Cancel
            </button>
          </div>
        </ModalDialog>
      )}

      {sessionReview && (
        <SessionReviewDrawer
          key={sessionReview.session.id}
          review={sessionReview}
          personaName={
            sessionReview.session.personaName ||
            sessionReview.report?.personaName ||
            personasById.get(sessionReview.session.personaId)?.fullName ||
            "Session participant"
          }
          returnFocusTo={sessionReviewReturnFocusRef.current}
          onClose={() => {
            sessionReviewRequest.current += 1;
            invalidateReportGenerationUi();
            setReviewLoadingId(null);
            sessionReviewTargetRef.current = null;
            setSessionArtifactError(null);
            setSessionReview(null);
          }}
          onGenerateReport={() => void generateSavedSessionReport()}
          reportGenerating={
            Boolean(
              reportGeneration?.busy &&
                reportGeneration.matterId === sessionReview.session.matterId &&
                reportGeneration.sessionId === sessionReview.session.id
            )
          }
          reportGenerationError={
            reportGeneration?.matterId === sessionReview.session.matterId &&
            reportGeneration.sessionId === sessionReview.session.id
              ? reportGeneration.error
              : null
          }
          reportGenerationStatus={
            reportGeneration?.matterId === sessionReview.session.matterId &&
            reportGeneration.sessionId === sessionReview.session.id
              ? reportGeneration.status
              : null
          }
          artifactOpenError={sessionArtifactError}
          onOpenArtifact={(kind) =>
            void openSessionArtifact(
              sessionReview.session.matterId,
              sessionReview.session.id,
              kind
            )
          }
        />
      )}
    </div>
  );
}
