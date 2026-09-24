import { contextBridge, ipcRenderer } from "electron";
import type { SessionRecord, SessionReport } from "./types.js";
import type {
  PublicDocumentMeta,
  PublicReindexResult,
} from "./services/documents.js";

export type ExamMode = "cross" | "deposition" | "hearing";

export type PublicSettings = {
  hasKey: boolean;
  keyLast4: string;
  keySource: "env" | "stored" | "none";
  defaultVoice: string;
  /** Whether OS secure storage can encrypt a stored API key. */
  encryptionAvailable: boolean;
  dataError?: string;
};

export type ListMattersResult = {
  matters: Array<{
    id: string;
    caption: string;
    court: string;
    notes: string;
    createdAt: string;
    updatedAt: string;
  }>;
  dataErrors: string[];
};

export type SessionListItem = {
  id: string;
  personaId: string;
  mode: ExamMode;
  startedAt: string;
  endedAt?: string;
  unfinished: boolean;
  lineCount: number;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
};

export type ListSessionsResult = {
  sessions: SessionListItem[];
  dataErrors: string[];
};

export type SessionReviewResult = {
  session: Omit<SessionRecord, "reportPath">;
  unfinished: boolean;
  report: SessionReport | null;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
  dataErrors: string[];
};

export type GeneratedSessionReportResult = {
  session: VoiceSessionIdentity;
  report: SessionReport;
  canOpenReport: boolean;
  reportDataErrors: string[];
};

export type VoiceSessionIdentity = Readonly<{ id: string; matterId: string }>;

export type VoiceTerminalResult = Readonly<{
  session: VoiceSessionIdentity | null;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
  needsSaveRetry: boolean;
}>;

export type VoiceStatusPayload = {
  status: "open" | "closed" | "ended" | "disconnected";
  session?: VoiceSessionIdentity | null;
  sessionId?: string;
  canOpenTranscript?: boolean;
  canOpenReport?: boolean;
  needsSaveRetry?: boolean;
  reason?: string;
};

export type VoiceStateSnapshot = Readonly<{
  active: boolean;
  hasSession: boolean;
  hasUnsavedSession: boolean;
  matterId: string | null;
  sessionId: string | null;
}>;

export type ImportDocumentsResult = Readonly<{
  imported: string[];
  /** Files whose stored name differs from the picked source file's name. */
  renamed: string[];
  needsReindex: boolean;
  error?: string;
}>;

export type DeleteDocumentResult =
  | Readonly<{ deleted: string; needsReindex?: false }>
  | Readonly<{ deleted: null; needsReindex: true; error: string }>;

const api = {
  getAppInfo: (): Promise<{
    version: string;
    electronVersion: string;
    platform: string;
    packaged: boolean;
  }> => ipcRenderer.invoke("app:getInfo"),
  openDiagnostics: (): Promise<{ opened: true }> =>
    ipcRenderer.invoke("app:openDiagnostics"),

  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke("settings:get"),
  importApiKeyFromClipboard: (): Promise<{
    imported: boolean;
    settings: PublicSettings;
  }> =>
    ipcRenderer.invoke("settings:importApiKeyFromClipboard"),
  saveSettings: (patch: {
    defaultVoice?: string;
    clearApiKey?: boolean;
  }): Promise<PublicSettings> => ipcRenderer.invoke("settings:save", patch),

  listMatters: (): Promise<ListMattersResult> => ipcRenderer.invoke("matters:list"),
  createMatter: (input: { caption: string; court?: string; notes?: string }) =>
    ipcRenderer.invoke("matters:create", input),
  getMatter: (matterId: string) => ipcRenderer.invoke("matters:get", matterId),
  updateMatter: (
    matterId: string,
    patch: { caption?: string; court?: string; notes?: string }
  ) => ipcRenderer.invoke("matters:update", matterId, patch),
  deleteMatter: (matterId: string): Promise<{ deleted: string }> =>
    ipcRenderer.invoke("matters:delete", matterId),
  exportMatter: (matterId: string): Promise<string | null> =>
    ipcRenderer.invoke("matters:export", matterId),
  restoreMatterMeta: (
    matterId: string
  ): Promise<{ ok: boolean; matter?: unknown; error?: string; restoredFrom?: string }> =>
    ipcRenderer.invoke("matters:restoreMeta", matterId),

  listPersonas: (matterId: string) => ipcRenderer.invoke("personas:list", matterId),
  savePersona: (
    matterId: string,
    input: {
      id?: string;
      fullName: string;
      role: string;
      attitude: string;
      notes: string;
      keyterms: string[];
      voice: string;
    }
  ) => ipcRenderer.invoke("personas:save", matterId, input),
  deletePersona: (matterId: string, personaId: string) =>
    ipcRenderer.invoke("personas:delete", matterId, personaId),

  pickAndImportDocs: (matterId: string): Promise<ImportDocumentsResult> =>
    ipcRenderer.invoke("docs:pickAndImport", matterId),
  reindexDocs: (matterId: string): Promise<PublicReindexResult> =>
    ipcRenderer.invoke("docs:reindex", matterId),
  cancelReindexDocs: (matterId: string): Promise<{ cancelled: string }> =>
    ipcRenderer.invoke("docs:cancelReindex", matterId),
  listDocs: (matterId: string): Promise<PublicDocumentMeta[]> =>
    ipcRenderer.invoke("docs:list", matterId),
  deleteDoc: (
    matterId: string,
    documentId: string
  ): Promise<DeleteDocumentResult> =>
    ipcRenderer.invoke("docs:delete", matterId, documentId),
  listSessions: (matterId: string): Promise<ListSessionsResult> =>
    ipcRenderer.invoke("sessions:list", matterId),
  getSessionReview: (matterId: string, sessionId: string): Promise<SessionReviewResult> =>
    ipcRenderer.invoke("sessions:get", matterId, sessionId),
  generateSessionReport: (
    matterId: string,
    sessionId: string
  ): Promise<GeneratedSessionReportResult> =>
    ipcRenderer.invoke("sessions:generateReport", matterId, sessionId),
  restoreSession: (
    matterId: string,
    sessionId: string
  ): Promise<{
    ok: boolean;
    error?: string;
    restoredFrom?: string;
  }> => ipcRenderer.invoke("sessions:restore", matterId, sessionId),
  openSessionArtifact: (
    matterId: string,
    sessionId: string,
    kind: "transcript" | "report"
  ): Promise<string> => ipcRenderer.invoke("sessions:openArtifact", matterId, sessionId, kind),
  deleteSession: (
    matterId: string,
    sessionId: string
  ): Promise<{ deleted: string }> =>
    ipcRenderer.invoke("sessions:delete", matterId, sessionId),

  startVoice: (setup: {
    matterId: string;
    personaId: string;
    mode: ExamMode;
    voice?: string;
  }): Promise<VoiceSessionIdentity> => ipcRenderer.invoke("voice:start", setup),
  stopVoice: (generateReport: boolean): Promise<VoiceTerminalResult> =>
    ipcRenderer.invoke("voice:stop", generateReport),
  getVoiceState: (): Promise<VoiceStateSnapshot> => ipcRenderer.invoke("voice:getState"),
  sendAudio: (base64Pcm: string) => ipcRenderer.send("voice:audio-in", base64Pcm),

  onVoiceAudio: (cb: (payload: { delta: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { delta: string }) => cb(payload);
    ipcRenderer.on("voice:audio", listener);
    return () => ipcRenderer.removeListener("voice:audio", listener);
  },
  onVoiceTranscript: (
    cb: (line: {
      role: string;
      text: string;
      at: string;
      replaceIndex?: number;
    }) => void
  ) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      line: {
        role: string;
        text: string;
        at: string;
        replaceIndex?: number;
      }
    ) => cb(line);
    ipcRenderer.on("voice:transcript", listener);
    return () => ipcRenderer.removeListener("voice:transcript", listener);
  },
  onVoiceStatus: (cb: (payload: VoiceStatusPayload) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: VoiceStatusPayload) => cb(payload);
    ipcRenderer.on("voice:status", listener);
    return () => ipcRenderer.removeListener("voice:status", listener);
  },
  onVoiceError: (cb: (payload: { message: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { message: string }) => cb(payload);
    ipcRenderer.on("voice:error", listener);
    return () => ipcRenderer.removeListener("voice:error", listener);
  },
  onVoiceTool: (cb: (payload: Record<string, unknown>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: Record<string, unknown>) => cb(payload);
    ipcRenderer.on("voice:tool", listener);
    return () => ipcRenderer.removeListener("voice:tool", listener);
  },
  onVoiceBargeIn: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("voice:barge-in", listener);
    return () => ipcRenderer.removeListener("voice:barge-in", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

export type DesktopApi = typeof api;
