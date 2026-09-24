import { Profiler, StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const audioHarness = vi.hoisted(() => ({
  enqueued: [] as string[],
  enqueueResult: true,
  players: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  microphones: [] as Array<{
    stop: ReturnType<typeof vi.fn>;
    setMuted: ReturnType<typeof vi.fn>;
    emitStatus: (status: {
      sampleRate: number;
      level: number;
      framesSent: number;
      muted: boolean;
    }) => void;
  }>,
  startImpl: null as null | (() => Promise<{ sampleRate: number }>),
}));

const XAI_PROCESSING_ACK_STORAGE_KEY = "cx-xai-processing-ack-v1";

vi.mock("../src/audio", () => ({
  PcmPlayer: class PcmPlayer {
    close = vi.fn(async () => undefined);
    flush = vi.fn();
    resume = vi.fn(async () => undefined);
    constructor() {
      audioHarness.players.push(this);
    }
    enqueueBase64(delta: string) {
      audioHarness.enqueued.push(delta);
      return audioHarness.enqueueResult;
    }
  },
  MicStreamer: class MicStreamer {
    statusHandler: ((status: {
      sampleRate: number;
      level: number;
      framesSent: number;
      muted: boolean;
    }) => void) | null = null;
    stop = vi.fn(async () => undefined);
    setMuted = vi.fn();
    setStatusHandler = vi.fn((handler: typeof this.statusHandler) => {
      this.statusHandler = handler;
    });
    start = vi.fn(async () =>
      audioHarness.startImpl ? audioHarness.startImpl() : { sampleRate: 24_000 }
    );
    constructor() {
      audioHarness.microphones.push(this);
    }
    emitStatus(status: {
      sampleRate: number;
      level: number;
      framesSent: number;
      muted: boolean;
    }) {
      this.statusHandler?.(status);
    }
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const alpha = {
  id: "matter-alpha",
  caption: "Alpha v. Acme",
  court: "N.D. Ohio",
  notes: "",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};
const beta = {
  ...alpha,
  id: "matter-beta",
  caption: "Beta v. Bravo",
};

function person(id: string, matterId: string, fullName: string) {
  return {
    id,
    matterId,
    fullName,
    role: "Fact witness",
    attitude: "neutral",
    notes: "",
    keyterms: [],
    voice: "",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function caseDoc(id: string, fileName: string, docType = "PDF") {
  return {
    id,
    fileName,
    docType,
    charCount: 1_200,
    pageCount: 2,
  };
}

function review(sessionId: string, matterId: string, personaName: string) {
  return {
    unfinished: false,
    session: {
      id: sessionId,
      matterId,
      personaId: `person-${sessionId}`,
      mode: "cross" as const,
      startedAt: "2026-07-13T12:00:00.000Z",
      endedAt: "2026-07-13T12:05:00.000Z",
      transcript: [{ role: "assistant", text: `${personaName} answer`, at: "2026-07-13T12:01:00.000Z" }],
    },
    report: {
      sessionId,
      matterCaption: beta.caption,
      personaName,
      mode: "cross" as const,
      generatedAt: "2026-07-13T12:06:00.000Z",
      summary: "Complete",
      admissions: [],
      hedges: [],
      inconsistencies: [],
      missedFollowUps: [],
      scorecard: { control: "", oneFactQuestions: "", impeachment: "", form: "", notes: "" },
    },
    canOpenTranscript: false,
    canOpenReport: false,
    dataErrors: [],
  };
}

function generatedReportResult(value: ReturnType<typeof review>) {
  if (!value.report) throw new Error("Expected a report fixture");
  return {
    session: { id: value.session.id, matterId: value.session.matterId },
    report: value.report,
    canOpenReport: true,
    reportDataErrors: [],
  };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getAppInfo: vi.fn().mockResolvedValue({
      version: "0.1.0",
      electronVersion: "43.1.0",
      platform: "win32",
      packaged: false,
    }),
    openDiagnostics: vi.fn().mockResolvedValue({ opened: true }),
    getSettings: vi.fn().mockResolvedValue({
      hasKey: true,
      keyLast4: "1234",
      keySource: "stored",
      defaultVoice: "eve",
      encryptionAvailable: true,
    }),
    importApiKeyFromClipboard: vi.fn().mockResolvedValue({
      imported: false,
      settings: {
        hasKey: true,
        keyLast4: "1234",
        keySource: "stored",
        defaultVoice: "eve",
        encryptionAvailable: true,
      },
    }),
    saveSettings: vi.fn(),
    listMatters: vi.fn().mockResolvedValue({ matters: [alpha, beta], dataErrors: [] }),
    createMatter: vi.fn(),
    getMatter: vi.fn(),
    updateMatter: vi.fn(),
    exportMatter: vi.fn().mockResolvedValue(null),
    deleteMatter: vi.fn(),
    restoreMatterMeta: vi.fn(),
    listPersonas: vi.fn().mockResolvedValue([]),
    savePersona: vi.fn(),
    deletePersona: vi.fn(),
    pickAndImportDocs: vi.fn(),
    reindexDocs: vi.fn(),
    cancelReindexDocs: vi.fn(),
    listDocs: vi.fn().mockResolvedValue([]),
    deleteDoc: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    getSessionReview: vi.fn(),
    generateSessionReport: vi.fn(),
    deleteSession: vi.fn(),
    restoreSession: vi.fn(),
    startVoice: vi.fn(),
    stopVoice: vi.fn(),
    getVoiceState: vi.fn().mockResolvedValue({
      active: false,
      hasSession: false,
      hasUnsavedSession: false,
      matterId: null,
      sessionId: null,
    }),
    sendAudio: vi.fn(),
    openSessionArtifact: vi.fn(),
    onVoiceAudio: vi.fn(() => () => undefined),
    onVoiceTranscript: vi.fn(() => () => undefined),
    onVoiceStatus: vi.fn(() => () => undefined),
    onVoiceError: vi.fn(() => () => undefined),
    onVoiceTool: vi.fn(() => () => undefined),
    onVoiceBargeIn: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "api", { configurable: true, value: api });
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.setItem(XAI_PROCESSING_ACK_STORAGE_KEY, "1");
  audioHarness.enqueued.length = 0;
  audioHarness.enqueueResult = true;
  audioHarness.players.length = 0;
  audioHarness.microphones.length = 0;
  audioHarness.startImpl = null;
  delete (window as unknown as { __examVoiceReconciliation?: unknown })
    .__examVoiceReconciliation;
});

describe("App presentation accessibility contracts", () => {
  it("announces the initial matters request without flashing the empty state", async () => {
    const initialMatters = deferred<{ matters: typeof alpha[]; dataErrors: string[] }>();
    installApi({
      listMatters: vi.fn(() => initialMatters.promise),
    });
    render(<App />);

    expect(
      await screen.findByRole("status", { name: "Loading matters" })
    ).toBeTruthy();
    expect(screen.queryByText("No matters yet")).toBeNull();

    await act(async () => {
      initialMatters.resolve({ matters: [alpha], dataErrors: [] });
    });

    expect(await screen.findByRole("button", { name: /Alpha v\. Acme/ })).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Loading matters" })).toBeNull()
    );
  });

  it("identifies the active primary navigation destination", async () => {
    installApi();
    render(<App />);

    const matters = screen.getByRole("button", { name: "Matters" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(matters.getAttribute("aria-current")).toBe("page");
    expect(settings.getAttribute("aria-current")).toBeNull();

    fireEvent.click(settings);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(settings.getAttribute("aria-current")).toBe("page");
    expect(matters.getAttribute("aria-current")).toBeNull();
  });

  it("names the sidebar theme toggle as its action without contradictory pressed state", () => {
    installApi();
    render(<App />);

    const toggle = screen.getByRole("button", {
      name: /Switch to (?:light|dark) mode/,
    });
    const initialName = toggle.getAttribute("aria-label");
    expect(toggle.getAttribute("aria-pressed")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-label")).not.toBe(initialName);
    expect(toggle.getAttribute("aria-pressed")).toBeNull();
  });

  it("provides a programmatically focusable destination for the skip link", () => {
    installApi();
    render(<App />);

    expect(screen.getByRole("link", { name: "Skip to workspace" }).getAttribute("href"))
      .toBe("#main-workspace");
    expect(screen.getByRole("main").getAttribute("tabindex")).toBe("-1");
  });

  it("programmatically names every practice-session selector", async () => {
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));

    expect(await screen.findByRole("combobox", { name: "Practice mode" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Person" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Session voice" })).toBeTruthy();
  });

  it("keeps matter summary terms before their definitions in source order", async () => {
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const summary = await screen.findByLabelText("Matter summary");

    for (const item of Array.from(summary.children)) {
      expect(item.children[0]?.tagName).toBe("DT");
      expect(item.children[1]?.tagName).toBe("DD");
    }
  });

  it("programmatically names appearance and default-voice settings", async () => {
    installApi();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("group", { name: "Appearance" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Default witness voice" })
    ).toBeTruthy();
  });

  it("exposes the live transcript as a log and microphone input as a meter", async () => {
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue({ id: "session-meter", matterId: beta.id }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: "session-meter", matterId: beta.id },
        canOpenTranscript: false,
        canOpenReport: false,
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const begin = await screen.findByRole("button", { name: "Begin examination" });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(begin);

    expect(
      await screen.findByRole("log", { name: "Live transcript" })
    ).toBeTruthy();
    const meter = await screen.findByRole("meter", { name: "Microphone input level" });
    const initialValue = Number(meter.getAttribute("aria-valuenow"));
    expect(Number.isFinite(initialValue)).toBe(true);

    act(() => {
      audioHarness.microphones[0]!.emitStatus({
        sampleRate: 24_000,
        level: 0.4,
        framesSent: 1,
        muted: false,
      });
    });
    await waitFor(() =>
      expect(Number(meter.getAttribute("aria-valuenow"))).toBeGreaterThan(initialValue)
    );

    fireEvent.click(screen.getByRole("button", { name: "End only" }));
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
  });
});

describe("App async ownership", () => {
  it("requires a clear first-use acknowledgement before starting xAI voice processing", async () => {
    window.localStorage.removeItem(XAI_PROCESSING_ACK_STORAGE_KEY);
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue({ id: "session-consent", matterId: beta.id }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(
      await screen.findByText(/Beginning sends microphone audio and relevant case context to xAI/)
    ).toBeTruthy();
    const begin = await screen.findByRole("button", { name: "Begin examination" });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    begin.focus();
    fireEvent.click(begin);

    const dialog = await screen.findByRole("dialog", { name: "Before xAI voice processing" });
    expect(api.startVoice).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/microphone audio is streamed to xAI/i)).toBeTruthy();
    expect(within(dialog).getByText(/case-file context and live transcript content/i)).toBeTruthy();
    const acknowledgement = within(dialog).getByRole("checkbox", {
      name: /content leaves this device for xAI processing/i,
    });
    const continueButton = within(dialog).getByRole("button", {
      name: "Acknowledge and begin",
    }) as HTMLButtonElement;
    expect(document.activeElement).toBe(acknowledgement);
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(acknowledgement);
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);

    await waitFor(() => expect(api.startVoice).toHaveBeenCalledOnce());
    expect(window.localStorage.getItem(XAI_PROCESSING_ACK_STORAGE_KEY)).toBe("1");
    expect(screen.queryByRole("dialog", { name: "Before xAI voice processing" })).toBeNull();
  });

  it("targets matter recovery from a prefixed low-level metadata error", async () => {
    const recoverableId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const recoverableMatter = { ...alpha, id: recoverableId };
    const api = installApi({
      listMatters: vi
        .fn()
        .mockResolvedValueOnce({
          matters: [],
          dataErrors: [
            `Matter ${recoverableId}: DataFileSafetyError: Matter metadata exceeds the safety limit`,
          ],
        })
        .mockResolvedValueOnce({ matters: [recoverableMatter], dataErrors: [] }),
      restoreMatterMeta: vi.fn().mockResolvedValue({
        ok: true,
        matter: recoverableMatter,
        restoredFrom: "matter.json.bak",
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore from backup" }));

    await waitFor(() => expect(api.restoreMatterMeta).toHaveBeenCalledWith(recoverableId));
    expect((await screen.findByRole("status")).textContent).toContain(
      "Restored matter from matter.json.bak"
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No matter id found/)).toBeNull();
  });

  it("keeps a post-create matter refresh newer than the initial list request", async () => {
    const initialMatters = deferred<{ matters: typeof alpha[]; dataErrors: string[] }>();
    const api = installApi({
      listMatters: vi
        .fn()
        .mockImplementationOnce(() => initialMatters.promise)
        .mockResolvedValueOnce({ matters: [beta], dataErrors: [] }),
      createMatter: vi.fn().mockResolvedValue(beta),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "+ New matter" }));
    const dialog = await screen.findByRole("dialog", { name: "New matter" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Caption" }), {
      target: { value: beta.caption },
    });
    fireEvent.submit(dialog);

    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
    expect(api.listMatters).toHaveBeenCalledTimes(2);

    await act(async () => initialMatters.resolve({
      matters: [alpha],
      dataErrors: ["stale list corruption"],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    expect(screen.getByRole("button", { name: /Beta v\. Bravo/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alpha v\. Acme/ })).toBeNull();
    expect(screen.queryByText(/stale list corruption/)).toBeNull();
  });

  it("does not let a stale initial settings result overwrite a completed save", async () => {
    const initialSettings = deferred<{
      hasKey: boolean;
      keyLast4: string;
      keySource: "env" | "stored" | "none";
      defaultVoice: string;
      dataError?: string;
    }>();
    const api = installApi({
      getSettings: vi.fn(() => initialSettings.promise),
      saveSettings: vi.fn().mockResolvedValue({
        hasKey: true,
        keyLast4: "9876",
        keySource: "stored",
        defaultVoice: "ara",
      }),
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    const voiceSelect = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(voiceSelect, { target: { value: "ara" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledOnce());
    expect(api.saveSettings).toHaveBeenCalledWith({ defaultVoice: "ara" });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(await screen.findByText(/Stored encrypted key · ending 9876/)).toBeTruthy();

    await act(async () => initialSettings.resolve({
      hasKey: false,
      keyLast4: "",
      keySource: "none",
      defaultVoice: "eve",
      dataError: "stale corrupt settings",
    }));
    expect(voiceSelect.value).toBe("ara");
    expect(screen.getByText(/Stored encrypted key · ending 9876/)).toBeTruthy();
    expect(screen.queryByText(/stale corrupt settings/)).toBeNull();
  });

  it("imports an API key through the native clipboard bridge without a renderer key field", async () => {
    const importing = deferred<{
      imported: boolean;
      settings: {
        hasKey: boolean;
        keyLast4: string;
        keySource: "env" | "stored" | "none";
        defaultVoice: string;
      };
    }>();
    const api = installApi({
      getSettings: vi.fn().mockResolvedValue({
        hasKey: false,
        keyLast4: "",
        keySource: "none",
        defaultVoice: "eve",
      }),
      importApiKeyFromClipboard: vi.fn(() => importing.promise),
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByText(/native confirmation imports the clipboard value/i)).toBeTruthy();
    const importButton = screen.getByRole("button", { name: "Import key from clipboard…" });
    fireEvent.click(importButton);
    fireEvent.click(importButton);

    expect(api.importApiKeyFromClipboard).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Waiting for confirmation…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await act(async () => importing.resolve({
      imported: true,
      settings: {
        hasKey: true,
        keyLast4: "9876",
        keySource: "stored",
        defaultVoice: "eve",
      },
    }));

    expect(await screen.findByText(/Stored encrypted key · ending 9876/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Any still-matching clipboard value was cleared"
    );
    expect(api.saveSettings).not.toHaveBeenCalled();

    api.importApiKeyFromClipboard.mockResolvedValueOnce({
      imported: false,
      settings: {
        hasKey: true,
        keyLast4: "9876",
        keySource: "stored",
        defaultVoice: "eve",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import key from clipboard…" }));
    expect(await screen.findByText("Import canceled. The clipboard was not read or changed.")).toBeTruthy();
  });

  it("keeps an API-key import newer than the initial settings request", async () => {
    const initialSettings = deferred<{
      hasKey: boolean;
      keyLast4: string;
      keySource: "env" | "stored" | "none";
      defaultVoice: string;
    }>();
    const api = installApi({
      getSettings: vi.fn(() => initialSettings.promise),
      importApiKeyFromClipboard: vi.fn().mockResolvedValue({
        imported: true,
        settings: {
          hasKey: true,
          keyLast4: "9876",
          keySource: "stored",
          defaultVoice: "eve",
        },
      }),
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Import key from clipboard…" })
    );
    expect(await screen.findByText(/Stored encrypted key · ending 9876/)).toBeTruthy();

    await act(async () => initialSettings.resolve({
      hasKey: false,
      keyLast4: "",
      keySource: "none",
      defaultVoice: "ara",
    }));

    expect(screen.getByText(/Stored encrypted key · ending 9876/)).toBeTruthy();
    expect(api.importApiKeyFromClipboard).toHaveBeenCalledOnce();
  });

  it("shows app versions and path-free diagnostics feedback in secondary Settings support", async () => {
    const openDiagnostics = vi
      .fn()
      .mockResolvedValueOnce({ opened: true, path: "C:\\Users\\counsel\\private-diagnostics" })
      .mockRejectedValueOnce(new Error("C:\\Users\\counsel\\private-diagnostics is locked"));
    const api = installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        version: "2.4.1",
        electronVersion: "43.1.0",
        platform: "win32",
        packaged: true,
      }),
      openDiagnostics,
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "About & support" })).toBeTruthy();
    expect(await screen.findByText("Cross Examination 2.4.1 · Electron 43.1.0")).toBeTruthy();
    const openButton = screen.getByRole("button", { name: "Open diagnostics folder" });
    fireEvent.click(openButton);

    expect(await screen.findByText("Diagnostics folder opened.")).toBeTruthy();
    expect(api.openDiagnostics).toHaveBeenCalledOnce();
    expect(screen.queryByText(/private-diagnostics/i)).toBeNull();

    fireEvent.click(openButton);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not open the diagnostics folder. Try again or restart the app."
    );
    expect(screen.queryByText(/private-diagnostics/i)).toBeNull();
  });

  it("commits only the newest matter detail request", async () => {
    const alphaPeople = deferred<ReturnType<typeof person>[]>();
    const alphaDocs = deferred<unknown[]>();
    const alphaSessions = deferred<{ sessions: unknown[]; dataErrors: string[] }>();
    const betaPeople = deferred<ReturnType<typeof person>[]>();
    const betaDocs = deferred<unknown[]>();
    const betaSessions = deferred<{ sessions: unknown[]; dataErrors: string[] }>();
    installApi({
      listPersonas: vi.fn((id: string) => id === alpha.id ? alphaPeople.promise : betaPeople.promise),
      listDocs: vi.fn((id: string) => id === alpha.id ? alphaDocs.promise : betaDocs.promise),
      listSessions: vi.fn((id: string) => id === alpha.id ? alphaSessions.promise : betaSessions.promise),
    });
    render(<App />);

    const alphaButton = await screen.findByRole("button", { name: /Alpha v\. Acme/ });
    const betaButton = screen.getByRole("button", { name: /Beta v\. Bravo/ });
    fireEvent.click(alphaButton);
    fireEvent.click(betaButton);

    await act(async () => {
      betaPeople.resolve([person("person-beta", beta.id, "Beta Witness")]);
      betaDocs.resolve([]);
      betaSessions.resolve({ sessions: [], dataErrors: [] });
    });
    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
    expect(screen.getByText("Beta Witness")).toBeTruthy();

    await act(async () => {
      alphaPeople.resolve([person("person-alpha", alpha.id, "Alpha Witness")]);
      alphaDocs.resolve([]);
      alphaSessions.resolve({ sessions: [], dataErrors: [] });
    });
    expect(screen.getByRole("heading", { name: beta.caption })).toBeTruthy();
    expect(screen.queryByText("Alpha Witness")).toBeNull();
  });

  it("keeps a terminal-event session refresh from overwriting a newer detail refresh", async () => {
    const terminalSessions = deferred<{ sessions: unknown[]; dataErrors: string[] }>();
    const newerSession = {
      id: "session-newer",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T14:00:00.000Z",
      endedAt: "2026-07-13T14:05:00.000Z",
      unfinished: false,
      lineCount: 22,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const staleSession = { ...newerSession, id: "session-stale", lineCount: 11 };
    let emitStatus: ((payload: Record<string, unknown>) => void) | undefined;
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi
        .fn()
        .mockResolvedValueOnce({ sessions: [], dataErrors: [] })
        .mockImplementationOnce(() => terminalSessions.promise)
        .mockResolvedValueOnce({ sessions: [newerSession], dataErrors: [] }),
      onVoiceStatus: vi.fn((callback: (payload: Record<string, unknown>) => void) => {
        emitStatus = callback;
        return () => undefined;
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    await screen.findByRole("heading", { name: beta.caption });
    await waitFor(() => expect(emitStatus).toBeTypeOf("function"));
    act(() => emitStatus?.({
      status: "ended",
      session: { id: "session-terminal", matterId: beta.id },
    }));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("22")).toBeTruthy();

    await act(async () => terminalSessions.resolve({ sessions: [staleSession], dataErrors: [] }));
    expect(screen.getByText("22")).toBeTruthy();
    expect(screen.queryByText("11")).toBeNull();
  });

  it("locks navigation and exposes Retry save after a failed disconnect save", async () => {
    const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let emitStatus: ((payload: Record<string, unknown>) => void) | undefined;
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi
        .fn()
        .mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue({ id: sessionId, matterId: beta.id }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: sessionId, matterId: beta.id },
        canOpenTranscript: true,
        canOpenReport: false,
        needsSaveRetry: false,
      }),
      onVoiceStatus: vi.fn((callback: (payload: Record<string, unknown>) => void) => {
        emitStatus = callback;
        return () => undefined;
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    await waitFor(() => expect(emitStatus).toBeTypeOf("function"));

    act(() =>
      emitStatus?.({
        status: "disconnected",
        reason: "network lost",
        session: { id: sessionId, matterId: beta.id },
        canOpenTranscript: false,
        canOpenReport: false,
        needsSaveRetry: true,
      })
    );

    const retry = await screen.findByRole("button", { name: "Retry save" });
    expect(screen.getByRole("alert").textContent).toContain(
      "the voice connection was lost and the automatic save failed"
    );
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    expect(screen.getByRole("heading", { name: "Live examination" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Retry saving");

    api.stopVoice.mockImplementationOnce(async () => {
      emitStatus?.({
        status: "ended",
        session: { id: sessionId, matterId: beta.id },
        canOpenTranscript: true,
        canOpenReport: false,
        needsSaveRetry: false,
      });
      return {
        session: { id: sessionId, matterId: beta.id },
        canOpenTranscript: true,
        canOpenReport: false,
        needsSaveRetry: false,
      };
    });
    fireEvent.click(retry);
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull());
    expect(
      await screen.findByText(
        "The retained session was saved. Its transcript is available in Past sessions."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    expect(await screen.findByRole("heading", { name: "Matters" })).toBeTruthy();
  });

  it("keeps a stale review request from replacing or unlocking the newest one", async () => {
    const first = deferred<ReturnType<typeof review>>();
    const second = deferred<ReturnType<typeof review>>();
    const sessions = [
      { id: "session-one", personaId: "p1", mode: "cross", startedAt: "2026-07-13T10:00:00.000Z", lineCount: 1, canOpenTranscript: false, canOpenReport: false },
      { id: "session-two", personaId: "p2", mode: "cross", startedAt: "2026-07-13T11:00:00.000Z", lineCount: 1, canOpenTranscript: false, canOpenReport: false },
    ];
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("p1", beta.id, "First Witness"),
        person("p2", beta.id, "Second Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions, dataErrors: [] }),
      getSessionReview: vi.fn((_: string, id: string) => id === "session-one" ? first.promise : second.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const reviewButtons = await screen.findAllByRole("button", { name: /^Review session/ });
    fireEvent.click(reviewButtons[0]!);
    fireEvent.click(reviewButtons[1]!);

    await act(async () => first.resolve(review("session-one", beta.id, "First Review")));
    expect(screen.getByRole("button", { name: /^Loading session review/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => second.resolve(review("session-two", beta.id, "Second Review")));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Second Review" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("First Review answer")).toBeNull());
  });

  it("generates a missing saved-session report, replaces the review, and refreshes its matter", async () => {
    const session = {
      id: "session-report",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      endedAt: "2026-07-13T10:05:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const initialReview = {
      ...review(session.id, beta.id, "Beta Witness"),
      session: {
        ...review(session.id, beta.id, "Beta Witness").session,
        personaId: "person-beta",
      },
      report: null,
    };
    const generatedReview = {
      ...review(session.id, beta.id, "Beta Witness"),
      report: {
        ...review(session.id, beta.id, "Beta Witness").report!,
        summary: "Fresh coaching analysis",
      },
      canOpenReport: true,
    };
    const generated = generatedReportResult(generatedReview);
    const generation = deferred<typeof generated>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi
        .fn()
        .mockResolvedValueOnce({ sessions: [session], dataErrors: [] })
        .mockResolvedValueOnce({
          sessions: [{ ...session, canOpenReport: true }],
          dataErrors: [],
        }),
      getSessionReview: vi.fn().mockResolvedValue(initialReview),
      generateSessionReport: vi.fn(() => generation.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const reviewButton = await screen.findByRole("button", { name: /^Review session/ });
    reviewButton.focus();
    fireEvent.click(reviewButton);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    const generate = screen.getByRole("button", { name: "Generate performance report" });
    generate.focus();
    fireEvent.click(generate);
    fireEvent.click(generate);

    expect(api.generateSessionReport).toHaveBeenCalledOnce();
    expect(api.generateSessionReport).toHaveBeenCalledWith(beta.id, session.id);
    expect(
      (screen.getByRole("button", { name: "Generating report…" }) as HTMLButtonElement).disabled
    ).toBe(true);

    await act(async () => generation.resolve(generated));
    expect(await screen.findByText("Fresh coaching analysis")).toBeTruthy();
    expect(
      within(screen.getByRole("tabpanel", { name: "Performance report" }))
        .getByRole("status").textContent
    ).toContain("Performance report generated");
    expect(screen.getByRole("button", { name: "Regenerate performance report" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open report file" })).toBeTruthy();
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));

    const confirmRegeneration = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate performance report" }));
    expect(confirmRegeneration).toHaveBeenCalledOnce();
    expect(api.generateSessionReport).toHaveBeenCalledOnce();
    confirmRegeneration.mockRestore();

    fireEvent.click(screen.getByRole("button", { name: "Close session review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(reviewButton);
  });

  it("keeps a generation failure inline and retries the same saved session", async () => {
    const session = {
      id: "session-retry-report",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const initialReview = { ...review(session.id, beta.id, "Beta Witness"), report: null };
    const generated = generatedReportResult(review(session.id, beta.id, "Beta Witness"));
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      getSessionReview: vi.fn().mockResolvedValue(initialReview),
      generateSessionReport: vi
        .fn()
        .mockRejectedValueOnce(new Error("Report provider unavailable"))
        .mockResolvedValueOnce(generated),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Review session/ }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));

    const reportError = await screen.findByRole("alert");
    expect(reportError.textContent).toContain("Report provider unavailable");
    expect(screen.queryByText(/Could not open session review/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));
    expect(await screen.findByText("Complete")).toBeTruthy();
    expect(api.generateSessionReport).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Report provider unavailable/)).toBeNull();
  });

  it("retains a report failure when the drawer closes and restores it on reopen", async () => {
    const session = {
      id: "session-report-close-failure",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const initialReview = { ...review(session.id, beta.id, "Beta Witness"), report: null };
    const generation = deferred<ReturnType<typeof generatedReportResult>>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      getSessionReview: vi.fn().mockResolvedValue(initialReview),
      generateSessionReport: vi.fn(() => generation.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const trigger = await screen.findByRole("button", { name: /^Review session/ });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Close session review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => generation.reject(new Error("Report provider went offline")));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Reopen this saved session to retry"
    );

    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    const panel = screen.getByRole("tabpanel", { name: "Performance report" });
    expect(within(panel).getByRole("alert").textContent).toContain(
      "Report provider went offline"
    );
    expect(api.generateSessionReport).toHaveBeenCalledOnce();
  });

  it("keeps artifact-open failures visible inside the modal session review", async () => {
    const session = {
      id: "session-artifact-failure",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: true,
      canOpenReport: false,
    };
    const sessionReview = {
      ...review(session.id, beta.id, "Beta Witness"),
      canOpenTranscript: true,
      canOpenReport: false,
      dataErrors: [],
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      getSessionReview: vi.fn().mockResolvedValue(sessionReview),
      openSessionArtifact: vi.fn().mockResolvedValue("The transcript export is unavailable."),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Review session/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open transcript file" }));

    const artifactError = await within(dialog).findByRole("alert");
    expect(artifactError.textContent).toContain("Session file could not be opened");
    expect(artifactError.textContent).toContain("transcript export is unavailable");
    expect(api.openSessionArtifact).toHaveBeenCalledWith(
      beta.id,
      session.id,
      "transcript"
    );
  });

  it("does not let a stale generation replace or unlock a newer review's job", async () => {
    const sessions = [
      { id: "report-one", personaId: "p1", mode: "cross" as const, startedAt: "2026-07-13T10:00:00.000Z", unfinished: false, lineCount: 1, canOpenTranscript: false, canOpenReport: false },
      { id: "report-two", personaId: "p2", mode: "cross" as const, startedAt: "2026-07-13T11:00:00.000Z", unfinished: false, lineCount: 1, canOpenTranscript: false, canOpenReport: false },
    ];
    const firstGeneration = deferred<ReturnType<typeof generatedReportResult>>();
    const secondGeneration = deferred<ReturnType<typeof generatedReportResult>>();
    const firstReviewBase = review("report-one", beta.id, "First Witness");
    const secondReviewBase = review("report-two", beta.id, "Second Witness");
    const firstReview = {
      ...firstReviewBase,
      session: { ...firstReviewBase.session, personaId: "p1" },
      report: null,
    };
    const secondReview = {
      ...secondReviewBase,
      session: { ...secondReviewBase.session, personaId: "p2" },
      report: null,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("p1", beta.id, "First Witness"),
        person("p2", beta.id, "Second Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions, dataErrors: [] }),
      getSessionReview: vi.fn((_: string, id: string) =>
        Promise.resolve(id === "report-one" ? firstReview : secondReview)
      ),
      generateSessionReport: vi.fn((_: string, id: string) =>
        id === "report-one" ? firstGeneration.promise : secondGeneration.promise
      ),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const reviewButtons = await screen.findAllByRole("button", { name: /^Review session/ });
    fireEvent.click(reviewButtons[0]!);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Close session review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(reviewButtons[1]!);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));
    expect(api.generateSessionReport).toHaveBeenCalledTimes(2);

    await act(async () =>
      firstGeneration.resolve(
        generatedReportResult(review("report-one", beta.id, "Stale First"))
      )
    );
    expect(screen.getByRole("heading", { name: "Second Witness" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Generating report…" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.queryByText("Stale First")).toBeNull();

    await act(async () =>
      secondGeneration.resolve(
        generatedReportResult(review("report-two", beta.id, "Current Second"))
      )
    );
    expect(await screen.findByText("Complete")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current Second" })).toBeTruthy();
  });

  it("keeps one report job across close and reopen instead of launching a duplicate writer", async () => {
    const session = {
      id: "report-reopen",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 1,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const initial = { ...review(session.id, beta.id, "Beta Witness"), report: null };
    const generation = deferred<ReturnType<typeof generatedReportResult>>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      getSessionReview: vi.fn().mockResolvedValue(initial),
      generateSessionReport: vi.fn(() => generation.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const trigger = await screen.findByRole("button", { name: /^Review session/ });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Close session review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const deleteDuringReport = screen.getByRole("button", {
      name: /Delete saved session for Beta Witness/,
    }) as HTMLButtonElement;
    expect(deleteDuringReport.disabled).toBe(true);
    fireEvent.click(deleteDuringReport);
    expect(api.deleteSession).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    const inProgress = screen.getByRole("button", { name: "Generating report…" });
    expect((inProgress as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(inProgress);
    expect(api.generateSessionReport).toHaveBeenCalledOnce();

    await act(async () =>
      generation.resolve(
        generatedReportResult(review(session.id, beta.id, "Beta Witness"))
      )
    );
    expect(await screen.findByText("Complete")).toBeTruthy();
    expect(api.getSessionReview).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getByText("Beta Witness answer")).toBeTruthy();
  });

  it("prefers a completed cached report when disk returns a malformed report timestamp", async () => {
    const session = {
      id: "report-malformed-time",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 1,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const initial = { ...review(session.id, beta.id, "Beta Witness"), report: null };
    const generatedBase = review(session.id, beta.id, "Beta Witness");
    const generatedReview = {
      ...generatedBase,
      report: { ...generatedBase.report, summary: "Fresh cached report" },
    };
    const generated = generatedReportResult(generatedReview);
    const staleBase = review(session.id, beta.id, "Beta Witness");
    const staleDiskReview = {
      ...staleBase,
      report: {
        ...staleBase.report,
        generatedAt: "not-a-date",
        summary: "Stale disk report",
      },
    };
    const generation = deferred<ReturnType<typeof generatedReportResult>>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      getSessionReview: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(staleDiskReview),
      generateSessionReport: vi.fn(() => generation.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const trigger = await screen.findByRole("button", { name: /^Review session/ });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate performance report" }));
    fireEvent.click(screen.getByRole("button", { name: "Close session review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => generation.resolve(generated));
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    expect(await screen.findByText("Fresh cached report")).toBeTruthy();
    expect(screen.queryByText("Stale disk report")).toBeNull();
  });

  it("deletes a confirmed saved session immediately and restores focus to Past sessions", async () => {
    const session = {
      id: "delete-success",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      deleteSession: vi.fn().mockResolvedValue({ deleted: session.id }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const deleteButton = await screen.findByRole("button", {
      name: /Delete saved session for Beta Witness/,
    });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(beta.id, session.id));
    expect(confirmDelete).toHaveBeenCalledOnce();
    expect(confirmDelete.mock.calls[0]?.[0]).toContain(session.id);
    expect(confirmDelete.mock.calls[0]?.[0]).toContain("Beta Witness");
    expect(await screen.findByText(/Deleted the saved session for Beta Witness/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Review session/ })).toBeNull();
    const sessionsHeading = screen.getByRole("heading", { name: "Past sessions" });
    await waitFor(() => expect(document.activeElement).toBe(sessionsHeading));
  });

  it("keeps a saved session visible and surfaces a clean deletion rejection", async () => {
    const session = {
      id: "delete-rejected",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      deleteSession: vi
        .fn()
        .mockRejectedValue(new Error("Report generation is still active for this session")),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const deleteButton = await screen.findByRole("button", {
      name: /Delete saved session for Beta Witness/,
    });
    fireEvent.click(deleteButton);

    expect(
      await screen.findByText(
        /Could not delete the saved session for Beta Witness: Error: Report generation is still active/
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review session/ })).toBeTruthy();
    await waitFor(() => expect((deleteButton as HTMLButtonElement).disabled).toBe(false));
    expect(api.deleteSession).toHaveBeenCalledOnce();
  });

  it("does not remove a row for a mismatched deletion response", async () => {
    const session = {
      id: "delete-response-owner",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      deleteSession: vi.fn().mockResolvedValue({ deleted: "different-session" }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", {
      name: /Delete saved session for Beta Witness/,
    }));

    expect(
      await screen.findByText(/The deletion result did not match the requested saved session/)
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review session/ })).toBeTruthy();
  });

  it("does not let a stale deletion rejection overwrite a newer matter", async () => {
    const alphaSession = {
      id: "delete-stale-alpha",
      personaId: "person-alpha",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const betaSession = {
      ...alphaSession,
      id: "session-beta-current",
      personaId: "person-beta",
    };
    const deletion = deferred<{ deleted: string }>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = installApi({
      listPersonas: vi.fn((matterId: string) => Promise.resolve([
        person(
          matterId === alpha.id ? "person-alpha" : "person-beta",
          matterId,
          matterId === alpha.id ? "Alpha Witness" : "Beta Witness"
        ),
      ])),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn((matterId: string) => Promise.resolve({
        sessions: [matterId === alpha.id ? alphaSession : betaSession],
        dataErrors: [],
      })),
      deleteSession: vi.fn(() => deletion.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    fireEvent.click(await screen.findByRole("button", {
      name: /Delete saved session for Alpha Witness/,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(
      await screen.findByRole("button", { name: /Delete saved session for Beta Witness/ })
    ).toBeTruthy();

    await act(async () => deletion.reject(new Error("Stale Alpha deletion failure")));
    expect(screen.getByRole("heading", { name: beta.caption })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review session/ })).toBeTruthy();
    expect(screen.queryByText(/Stale Alpha deletion failure/)).toBeNull();
    expect(api.deleteSession).toHaveBeenCalledWith(alpha.id, alphaSession.id);
  });

  it("suppresses duplicate saved-session deletion requests in the same render window", async () => {
    const session = {
      id: "delete-single-flight",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const deletion = deferred<{ deleted: string }>();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [session], dataErrors: [] }),
      deleteSession: vi.fn(() => deletion.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const deleteButton = await screen.findByRole("button", {
      name: /Delete saved session for Beta Witness/,
    });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    expect(await screen.findByText("Deleting…")).toBeTruthy();
    expect(api.deleteSession).toHaveBeenCalledOnce();
    expect(confirmDelete).toHaveBeenCalledOnce();
    await act(async () => deletion.resolve({ deleted: session.id }));
    await waitFor(() => expect(screen.queryByText("Deleting…")).toBeNull());
  });

  it("silently unlocks voice start when bootstrap finds no retained session", async () => {
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const begin = await screen.findByRole("button", { name: "Begin examination" });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    expect(api.getVoiceState).toHaveBeenCalledOnce();
    expect(api.stopVoice).not.toHaveBeenCalled();
    expect(screen.queryByText(/Recovered the voice session/)).toBeNull();
  });

  it("finalizes one retained bootstrap session exactly once across StrictMode remounts", async () => {
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      getVoiceState: vi.fn().mockResolvedValue({
        active: true,
        hasSession: true,
        hasUnsavedSession: true,
        matterId: beta.id,
        sessionId: "retained-bootstrap",
      }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: "retained-bootstrap", matterId: beta.id },
        canOpenTranscript: true,
        canOpenReport: false,
      }),
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    expect(
      await screen.findByText(
        "Recovered the voice session left open by the previous app window and saved its transcript."
      )
    ).toBeTruthy();
    expect(api.getVoiceState).toHaveBeenCalledOnce();
    expect(api.stopVoice).toHaveBeenCalledOnce();
    expect(api.stopVoice).toHaveBeenCalledWith(false);
    await waitFor(() => expect(api.listMatters.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("reports when a retained session saves without a transcript export", async () => {
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      getVoiceState: vi.fn().mockResolvedValue({
        active: true,
        hasSession: true,
        hasUnsavedSession: true,
        matterId: beta.id,
        sessionId: "retained-without-transcript",
      }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: "retained-without-transcript", matterId: beta.id },
        canOpenTranscript: false,
        canOpenReport: false,
      }),
    });
    render(<App />);

    expect(
      await screen.findByText(
        "Recovered the voice session left open by the previous app window and saved its session record, but the transcript export is unavailable."
      )
    ).toBeTruthy();
    expect(api.stopVoice).toHaveBeenCalledOnce();
  });

  it("keeps a failed bootstrap save globally retryable before any matter is selected", async () => {
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      getVoiceState: vi.fn().mockResolvedValue({
        active: false,
        hasSession: true,
        hasUnsavedSession: true,
        matterId: beta.id,
        sessionId: "retained-retry",
      }),
      stopVoice: vi
        .fn()
        .mockRejectedValueOnce(new Error("Session file is locked"))
        .mockResolvedValueOnce({
          session: { id: "retained-retry", matterId: beta.id },
          canOpenTranscript: true,
          canOpenReport: false,
        }),
    });
    render(<App />);

    const retry = await screen.findByRole("button", { name: "Retry save" });
    expect(screen.getByText("Recovered session still needs saving")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(screen.getByRole("heading", { name: "Matters" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Practice session" })).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(
        "The retained session was saved. Its transcript is available in Past sessions."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
  });

  it("blocks a new voice start until the bootstrap state query finishes", async () => {
    const voiceState = deferred<{
      active: boolean;
      hasSession: boolean;
      hasUnsavedSession: boolean;
      matterId: string | null;
      sessionId: string | null;
    }>();
    const savedSession = {
      id: "pending-bootstrap-delete-lock",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [savedSession], dataErrors: [] }),
      getVoiceState: vi.fn(() => voiceState.promise),
      startVoice: vi.fn().mockResolvedValue(undefined),
      stopVoice: vi.fn().mockResolvedValue({ session: null }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const checking = await screen.findByRole("button", { name: "Checking previous session…" });
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    const deleteWhileChecking = screen.getByRole("button", {
      name: /Delete saved session for Beta Witness/,
    }) as HTMLButtonElement;
    expect(deleteWhileChecking.disabled).toBe(true);
    fireEvent.click(checking);
    expect(api.startVoice).not.toHaveBeenCalled();

    await act(async () => voiceState.resolve({
      active: false,
      hasSession: false,
      hasUnsavedSession: false,
      matterId: null,
      sessionId: null,
    }));
    const begin = await screen.findByRole("button", { name: "Begin examination" });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(deleteWhileChecking.disabled).toBe(false));
    fireEvent.click(begin);
    await waitFor(() => expect(api.startVoice).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "End only" }));
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
  });

  it("keeps starts and deletion locked until a failed bootstrap check is retried", async () => {
    const savedSession = {
      id: "failed-bootstrap-check",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T10:00:00.000Z",
      unfinished: false,
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [savedSession], dataErrors: [] }),
      getVoiceState: vi
        .fn()
        .mockRejectedValueOnce(new Error("Voice state IPC unavailable"))
        .mockResolvedValueOnce({
          active: false,
          hasSession: false,
          hasUnsavedSession: false,
          matterId: null,
          sessionId: null,
        }),
    });
    render(<App />);

    const retryCheck = await screen.findByRole("button", { name: "Retry session check" });
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const blockedStart = await screen.findByRole("button", { name: "Session check required" });
    expect((blockedStart as HTMLButtonElement).disabled).toBe(true);
    const blockedDelete = screen.getByRole("button", {
      name: /Delete saved session for Beta Witness/,
    }) as HTMLButtonElement;
    expect(blockedDelete.disabled).toBe(true);

    fireEvent.click(retryCheck);
    await waitFor(() => expect(api.getVoiceState).toHaveBeenCalledTimes(2));
    const begin = await screen.findByRole("button", { name: "Begin examination" });
    await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(blockedDelete.disabled).toBe(false));
  });

  it("does not carry a completed transcript into another matter", async () => {
    let pushTranscript:
      | ((line: { role: string; text: string; at: string }) => void)
      | undefined;
    installApi({
      listPersonas: vi.fn((id: string) => Promise.resolve([
        person(`person-${id}`, id, id === alpha.id ? "Alpha Witness" : "Beta Witness"),
      ])),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      onVoiceTranscript: vi.fn((callback) => {
        pushTranscript = callback;
        return () => undefined;
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    await screen.findByRole("heading", { name: alpha.caption });
    await waitFor(() => expect(pushTranscript).toBeTypeOf("function"));
    act(() => pushTranscript?.({
      role: "user",
      text: "Secret Alpha admission",
      at: "2026-07-13T12:01:00.000Z",
    }));

    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    await screen.findByRole("heading", { name: beta.caption });
    fireEvent.click(screen.getByRole("button", { name: "Live exam" }));

    expect(screen.queryByText("Secret Alpha admission")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Live examination" })).toBeNull();
    expect(screen.getByRole("heading", { name: beta.caption })).toBeTruthy();
  });

  it("keeps navigation owned by a pending voice start and lets counsel cancel it", async () => {
    const starting = deferred<void>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn(() => starting.promise),
      stopVoice: vi.fn().mockResolvedValue({ session: null }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    const cancel = await screen.findByRole("button", { name: "Cancel startup" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(screen.getByText("Cancel voice startup before leaving this screen.")).toBeTruthy();

    fireEvent.click(cancel);
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Begin examination" });

    await act(async () => starting.resolve(undefined));
    expect(screen.queryByRole("heading", { name: "Live examination" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  });

  it("keeps startup cancellable from the session view while microphone permission is pending", async () => {
    const pendingMic = deferred<{ sampleRate: number }>();
    audioHarness.startImpl = () => pendingMic.promise;
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue(undefined),
      stopVoice: vi.fn().mockResolvedValue({ session: null }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    const cancel = screen.getByRole("button", { name: "Cancel startup" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    fireEvent.click(cancel);
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel startup" })).toBeNull());
    expect(audioHarness.microphones[0]?.stop).toHaveBeenCalled();

    await act(async () => pendingMic.resolve({ sampleRate: 24_000 }));
    expect(screen.queryByText("Mic live @ 24000 Hz")).toBeNull();
  });

  it("preserves mute intent when microphone permission resolves after the user mutes", async () => {
    const pendingMic = deferred<{ sampleRate: number }>();
    audioHarness.startImpl = () => pendingMic.promise;
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue(undefined),
      stopVoice: vi.fn().mockResolvedValue({ session: null }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });

    const mic = audioHarness.microphones[0]!;
    fireEvent.click(screen.getByRole("button", { name: "Mute mic" }));
    expect(mic.setMuted).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Unmute mic" })).toBeTruthy();

    await act(async () => pendingMic.resolve({ sampleRate: 24_000 }));
    await waitFor(() => expect(mic.setMuted).toHaveBeenLastCalledWith(true));
    expect(screen.getByText("Muted")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "End only" }));
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
  });

  it("revalidates practice prerequisites after consent before claiming audio resources", async () => {
    window.localStorage.removeItem(XAI_PROCESSING_ACK_STORAGE_KEY);
    const rebuilding = deferred<{
      documents: ReturnType<typeof caseDoc>[];
      issues: [];
    }>();
    const indexedDocument = caseDoc("doc-beta", "Beta exhibit.pdf");
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([indexedDocument]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      reindexDocs: vi.fn(() => rebuilding.promise),
      startVoice: vi.fn().mockResolvedValue(undefined),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    let dialog = await screen.findByRole("dialog", { name: "Before xAI voice processing" });
    fireEvent.click(within(dialog).getByRole("checkbox"));

    // A background operation can begin while the consent sheet is open. The
    // consent action must re-check event-time ownership instead of trusting the
    // now-stale enabled Begin button that opened the sheet.
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    await waitFor(() => expect(api.reindexDocs).toHaveBeenCalledWith(beta.id));
    dialog = screen.getByRole("dialog", { name: "Before xAI voice processing" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Acknowledge and begin" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Before xAI voice processing" })).toBeNull()
    );
    expect(api.startVoice).not.toHaveBeenCalled();
    expect(audioHarness.players).toHaveLength(0);
    expect(audioHarness.microphones).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain(
      "Wait for the current matter operation to finish before starting an exam."
    );

    await act(async () => rebuilding.resolve({ documents: [indexedDocument], issues: [] }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Begin examination" })).toBeTruthy()
    );
  });

  it("keeps a retained session navigation-locked until Retry save succeeds", async () => {
    const sessionResult = {
      session: { id: "session-save-retry", matterId: beta.id },
      canOpenTranscript: true,
      canOpenReport: false,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue(undefined),
      stopVoice: vi
        .fn()
        .mockRejectedValueOnce(new Error("Session file is temporarily locked"))
        .mockResolvedValueOnce(sessionResult),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    fireEvent.click(screen.getByRole("button", { name: "End only" }));

    const retry = await screen.findByRole("button", { name: "Retry save" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Save needs retry")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    expect(screen.getByRole("heading", { name: "Live examination" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Retry saving");

    fireEvent.click(retry);
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull());
    expect(screen.getByText("Ended")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
  });

  it("offers Retry save when microphone startup cleanup cannot persist the retained session", async () => {
    audioHarness.startImpl = async () => {
      throw new Error("Microphone permission denied");
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue(undefined),
      stopVoice: vi
        .fn()
        .mockRejectedValueOnce(new Error("Could not write retained session"))
        .mockResolvedValueOnce({
          session: { id: "mic-failure-session", matterId: beta.id },
          canOpenTranscript: true,
          canOpenReport: false,
        }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));

    const retry = await screen.findByRole("button", { name: "Retry save" });
    expect(screen.getByRole("alert").textContent).toContain("Could not write retained session");
    fireEvent.click(retry);
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Ended")).toBeTruthy();
  });

  it("subscribes to opening audio before the voice start IPC resolves", async () => {
    let emitAudio: ((payload: { delta: string }) => void) | undefined;
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      onVoiceAudio: vi.fn((callback: (payload: { delta: string }) => void) => {
        emitAudio = callback;
        return () => undefined;
      }),
      startVoice: vi.fn(async () => {
        emitAudio?.({ delta: "opening-audio" });
      }),
      stopVoice: vi.fn().mockResolvedValue({ session: null }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));

    await waitFor(() => expect(api.startVoice).toHaveBeenCalledOnce());
    expect(api.onVoiceAudio).toHaveBeenCalled();
    expect(audioHarness.enqueued).toEqual(["opening-audio"]);
    await act(async () => {
      audioHarness.enqueueResult = false;
      emitAudio?.({ delta: "late-audio" });
      emitAudio?.({ delta: "later-still" });
    });
    expect(screen.getByRole("alert").textContent).toContain("Live audio was skipped");
    expect(screen.getAllByText(/Live audio was skipped/)).toHaveLength(1);
    expect(await screen.findByRole("heading", { name: "Live examination" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End only" }));
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
  });

  it("uses terminal artifact capabilities without receiving filesystem paths", async () => {
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi
        .fn()
        .mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue({ id: sessionId, matterId: beta.id }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: sessionId, matterId: beta.id },
        canOpenTranscript: true,
        canOpenReport: false,
      }),
      openSessionArtifact: vi.fn().mockResolvedValue(""),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    fireEvent.click(screen.getByRole("button", { name: "End + report" }));

    expect(await screen.findByRole("heading", { name: "Session file saved" })).toBeTruthy();
    expect(
      screen.getByText("The transcript is available in this matter’s session folder.")
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Transcript was saved, but the session report was not produced"
    );
    expect(screen.queryByRole("button", { name: "Open report" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    await waitFor(() =>
      expect(api.openSessionArtifact).toHaveBeenCalledWith(beta.id, sessionId, "transcript")
    );
  });

  it("surfaces a stop save failure globally after navigating away, without unlocking a newer matter load", async () => {
    const stopping = deferred<never>();
    const betaPeople = deferred<ReturnType<typeof person>[]>();
    const betaDocs = deferred<ReturnType<typeof caseDoc>[]>();
    const betaSessions = deferred<{ sessions: unknown[]; dataErrors: string[] }>();
    let emitVoiceError: ((payload: { message: string }) => void) | undefined;
    const api = installApi({
      listPersonas: vi.fn((matterId: string) => matterId === beta.id
        ? betaPeople.promise
        : Promise.resolve([person("person-alpha", alpha.id, "Alpha witness")])),
      listDocs: vi.fn((matterId: string) => matterId === beta.id
        ? betaDocs.promise
        : Promise.resolve([caseDoc("doc-session", "Session record.pdf")])),
      listSessions: vi.fn((matterId: string) => matterId === beta.id
        ? betaSessions.promise
        : Promise.resolve({ sessions: [], dataErrors: [] })),
      stopVoice: vi.fn(() => stopping.promise),
      onVoiceError: vi.fn((callback: (payload: { message: string }) => void) => {
        emitVoiceError = callback;
        return () => undefined;
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    fireEvent.click(screen.getByRole("button", { name: "End + report" }));
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(true));
    expect(screen.getAllByText("Generating report…").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));

    fireEvent.click(screen.getByRole("button", { name: "+ New matter" }));
    const dialog = await screen.findByRole("dialog", { name: "New matter" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Caption" }), {
      target: { value: "Deferred load guard" },
    });
    const createButton = within(dialog).getByRole("button", { name: "Create matter" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    act(() => emitVoiceError?.({ message: "Report failed for Alpha" }));
    expect(screen.queryByText("Report failed for Alpha")).toBeNull();
    await act(async () => stopping.reject(new Error("Alpha report transport failed")));
    expect(createButton.disabled).toBe(true);
    // A rejected stopVoice means the transcript save failed and the session is
    // retained in main-process memory. That failure is matter-scoped global
    // state: it must surface and stay retryable even though the user has
    // navigated to another matter while the save was in flight.
    expect(screen.getByText(/Alpha report transport failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();

    await act(async () => {
      betaPeople.resolve([person("person-beta", beta.id, "Beta Witness")]);
      betaDocs.resolve([]);
      betaSessions.resolve({ sessions: [], dataErrors: [] });
    });
    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
    await waitFor(() => expect(createButton.disabled).toBe(false));
    expect(screen.getByRole("heading", { name: beta.caption })).toBeTruthy();
    expect(screen.getByText(/Alpha report transport failed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("does not commit the App tree for every microphone status frame", async () => {
    let commits = 0;
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta record.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: "session-beta", matterId: beta.id },
        canOpenTranscript: false,
        canOpenReport: false,
      }),
    });
    render(
      <Profiler id="app" onRender={() => { commits += 1; }}>
        <App />
      </Profiler>
    );

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    const mic = audioHarness.microphones[0]!;
    const commitsBeforeFrames = commits;

    for (let frame = 1; frame <= 24; frame += 1) {
      act(() => mic.emitStatus({
        sampleRate: 24_000,
        level: 0.02 + frame / 1_000,
        framesSent: frame,
        muted: false,
      }));
    }

    expect(commits - commitsBeforeFrames).toBe(1);
    expect(screen.getByText("Mic live")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".mic-meter-fill")!.style.width).not.toBe("0%");

    fireEvent.click(screen.getByRole("button", { name: "End only" }));
    await waitFor(() => expect(api.stopVoice).toHaveBeenCalledWith(false));
  });

  it("preserves the selected person and session voice across a valid detail reload", async () => {
    const people = [
      person("person-first", beta.id, "First Witness"),
      person("person-second", beta.id, "Second Witness"),
    ];
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue(people),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    await screen.findByRole("heading", { name: beta.caption });
    let selects = document.querySelectorAll<HTMLSelectElement>(".session-config select");
    fireEvent.change(selects[1]!, { target: { value: "person-second" } });
    fireEvent.change(selects[2]!, { target: { value: "ara" } });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    await waitFor(() => expect(api.listPersonas).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: beta.caption });

    selects = document.querySelectorAll<HTMLSelectElement>(".session-config select");
    expect(selects[1]!.value).toBe("person-second");
    expect(selects[2]!.value).toBe("ara");
  });

  it("does not let an older matter's reindex result replace the current case record", async () => {
    const reindexing = deferred<{ documents: ReturnType<typeof caseDoc>[] }>();
    installApi({
      listDocs: vi.fn((matterId: string) => Promise.resolve([
        matterId === alpha.id
          ? caseDoc("doc-alpha", "Alpha original.pdf")
          : caseDoc("doc-beta", "Beta current.pdf"),
      ])),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      reindexDocs: vi.fn(() => reindexing.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    expect(await screen.findByText("Alpha original.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Beta current.pdf")).toBeTruthy();

    await act(async () => reindexing.resolve({
      documents: [caseDoc("doc-alpha-new", "Alpha replacement.pdf")],
    }));
    expect(screen.getByText("Beta current.pdf")).toBeTruthy();
    expect(screen.queryByText("Alpha replacement.pdf")).toBeNull();
  });

  it("clears an older matter's recovery lock when a later detail reload verifies its index", async () => {
    const reindexing = deferred<{ documents: ReturnType<typeof caseDoc>[] }>();
    let alphaLoads = 0;
    const api = installApi({
      listDocs: vi.fn((matterId: string) => {
        if (matterId !== alpha.id) {
          return Promise.resolve([caseDoc("doc-beta", "Beta current.pdf")]);
        }
        alphaLoads += 1;
        return alphaLoads === 1
          ? Promise.reject(new Error("index is invalid; reindex required"))
          : Promise.resolve([caseDoc("doc-alpha-new", "Alpha replacement.pdf")]);
      }),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      reindexDocs: vi.fn(() => reindexing.promise),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    expect(await screen.findByText("Case record refresh required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reindex now" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Beta current.pdf")).toBeTruthy();

    await act(async () => reindexing.resolve({
      documents: [caseDoc("doc-alpha-new", "Alpha replacement.pdf")],
    }));
    expect(screen.getByText("Beta current.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    expect(await screen.findByText("Alpha replacement.pdf")).toBeTruthy();
    expect(screen.queryByText("Case record refresh required")).toBeNull();
    expect(api.listDocs).toHaveBeenCalledTimes(3);
  });

  it("does not start indexing when a completed picker no longer owns the selected matter", async () => {
    const picking = deferred<{ imported: string[]; needsReindex: boolean }>();
    const api = installApi({
      listDocs: vi.fn((matterId: string) => Promise.resolve([
        matterId === alpha.id
          ? caseDoc("doc-alpha", "Alpha original.pdf")
          : caseDoc("doc-beta", "Beta current.pdf"),
      ])),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      pickAndImportDocs: vi.fn(() => picking.promise),
      reindexDocs: vi.fn(),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    expect(await screen.findByText("Alpha original.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import files" }));
    expect(await screen.findByText(/Choose case files in the open dialog/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Beta current.pdf")).toBeTruthy();

    await act(async () =>
      picking.resolve({ imported: ["Alpha imported.pdf"], needsReindex: true })
    );

    await waitFor(() => expect(api.reindexDocs).not.toHaveBeenCalled());
    expect(screen.getByText("Beta current.pdf")).toBeTruthy();
  });

  it("does not clear the current matter for a malformed picker result owned by an older matter", async () => {
    const picking = deferred<unknown>();
    const api = installApi({
      listDocs: vi.fn((matterId: string) => Promise.resolve([
        matterId === alpha.id
          ? caseDoc("doc-alpha", "Alpha original.pdf")
          : caseDoc("doc-beta", "Beta current.pdf"),
      ])),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      pickAndImportDocs: vi.fn(() => picking.promise),
      reindexDocs: vi.fn(),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Alpha v\. Acme/ }));
    expect(await screen.findByText("Alpha original.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import files" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to matters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Beta current.pdf")).toBeTruthy();

    await act(async () => picking.resolve(null));

    await waitFor(() => expect(api.reindexDocs).not.toHaveBeenCalled());
    expect(screen.getByText("Beta current.pdf")).toBeTruthy();
    expect(screen.queryByText("Case record refresh required")).toBeNull();
  });

  it("requests cancellation and suppresses a late post-import indexing result", async () => {
    const reindexing = deferred<{ documents: ReturnType<typeof caseDoc>[] }>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-existing", "Existing.pdf")]),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      pickAndImportDocs: vi.fn().mockResolvedValue({
        imported: ["Imported.pdf"],
        needsReindex: true,
      }),
      reindexDocs: vi.fn(() => reindexing.promise),
      cancelReindexDocs: vi.fn().mockResolvedValue({ cancelled: beta.id }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Existing.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import files" }));
    expect(await screen.findByText("Imported 1 file. Updating the case record…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Starting…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reindex case record first" })).toBeTruthy();
    expect(screen.getByText("Reindex the case record before beginning.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel indexing" }));

    await waitFor(() => expect(api.cancelReindexDocs).toHaveBeenCalledWith(beta.id));
    expect(await screen.findByText(/Cancellation requested; choose Reindex/)).toBeTruthy();
    await act(async () =>
      reindexing.resolve({ documents: [caseDoc("doc-imported", "Imported.pdf")] })
    );

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Reindex" }) as HTMLButtonElement).disabled)
        .toBe(false)
    );
    expect(screen.queryByText("Existing.pdf")).toBeNull();
    expect(screen.queryByText("Imported.pdf")).toBeNull();
    expect(screen.getByText(/refreshed case record could not be verified/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Reindex case record first" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("recovers the cancel control when the cancellation response targets another matter", async () => {
    const reindexing = deferred<{ documents: ReturnType<typeof caseDoc>[] }>();
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-existing", "Existing.pdf")]),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      reindexDocs: vi.fn(() => reindexing.promise),
      cancelReindexDocs: vi.fn().mockResolvedValue({ cancelled: alpha.id }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Existing.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel indexing" }));

    expect(
      await screen.findByText(/cancellation response did not match this matter/i)
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Cancel indexing" }) as HTMLButtonElement).disabled
    ).toBe(false);

    await act(async () => reindexing.resolve({
      documents: [caseDoc("doc-rebuilt", "Rebuilt.pdf")],
    }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Reindex" }) as HTMLButtonElement).disabled)
        .toBe(false)
    );
    expect(screen.getByText("Existing.pdf")).toBeTruthy();
  });

  it("distinguishes a post-import indexing failure from an import failure", async () => {
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listDocs: vi.fn().mockResolvedValue([]),
      listPersonas: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      pickAndImportDocs: vi.fn().mockResolvedValue({
        imported: ["One.pdf", "Two.pdf"],
        needsReindex: true,
      }),
      reindexDocs: vi.fn().mockRejectedValue(new Error("index disk busy")),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Import files" }));

    expect(
      await screen.findByText(/Imported 2 files, but indexing failed/)
    ).toBeTruthy();
    expect(screen.getByText(/choose Reindex to finish updating the case record/)).toBeTruthy();
    expect(screen.getByText(/index disk busy/)).toBeTruthy();
    expect(screen.getByText(/refreshed case record could not be verified/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Reindex case record first" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("fails closed when import rollback could not be verified", async () => {
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-existing", "Existing.pdf")]),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      pickAndImportDocs: vi.fn().mockResolvedValue({
        imported: [],
        needsReindex: true,
        error: "Import cleanup could not be verified. Reindex the matter.",
      }),
      reindexDocs: vi.fn(),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Existing.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import files" }));

    expect(await screen.findByText(/document import could not be verified/i)).toBeTruthy();
    expect(screen.queryByText("Existing.pdf")).toBeNull();
    expect(screen.getByText(/current case record could not be verified/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reindex now" })).toBeTruthy();
    expect(api.reindexDocs).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Reindex case record first" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

  });

  it("hides stale documents and requires recovery when the case record cannot be loaded", async () => {
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listDocs: vi.fn().mockRejectedValue(new Error("index is invalid; reindex required")),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      reindexDocs: vi.fn().mockResolvedValue({
        documents: [caseDoc("doc-recovered", "Recovered record.pdf")],
        issues: [],
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));

    expect(await screen.findByText(/Case record refresh required/)).toBeTruthy();
    expect(screen.getByText(/current case record could not be verified/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reindex now" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Reindex case record first" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reindex now" }));
    expect(await screen.findByText("Recovered record.pdf")).toBeTruthy();
    expect(screen.queryByText(/Case record unavailable:/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Begin examination" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("removes a document by current identity once, shows progress, and restores focus", async () => {
    const deleting = deferred<{ deleted: string }>();
    const rebuilding = deferred<{ documents: ReturnType<typeof caseDoc>[]; issues: [] }>();
    const target = caseDoc("doc-target", "Target exhibit.pdf");
    const retained = caseDoc("doc-retained", "Retained testimony.pdf", "Transcript");
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([]),
      listDocs: vi.fn().mockResolvedValue([target, retained]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      deleteDoc: vi.fn(() => deleting.promise),
      reindexDocs: vi.fn(() => rebuilding.promise),
    });
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const remove = await screen.findByRole("button", {
      name: "Remove Target exhibit.pdf from this matter",
    });
    fireEvent.click(remove);
    fireEvent.click(remove);

    expect(confirmDelete).toHaveBeenCalledOnce();
    expect(api.deleteDoc).toHaveBeenCalledOnce();
    expect(api.deleteDoc).toHaveBeenCalledWith(beta.id, target.id);
    expect(
      screen.getByRole("button", { name: "Removing Target exhibit.pdf from this matter" })
    ).toBeTruthy();

    await act(async () => deleting.resolve({ deleted: target.id }));
    expect(await screen.findByText(/Target exhibit\.pdf.*removed.*Rebuilding the case record/i)).toBeTruthy();
    expect(api.reindexDocs).toHaveBeenCalledWith(beta.id);

    await act(async () => rebuilding.resolve({ documents: [retained], issues: [] }));
    expect(await screen.findByText(/Removed “Target exhibit\.pdf” and rebuilt/)).toBeTruthy();
    expect(screen.queryByText("Target exhibit.pdf")).toBeNull();
    expect(screen.getByText("Retained testimony.pdf")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Case record" }))
    );
    confirmDelete.mockRestore();
  });

  it("makes a committed delete recoverable when its cancellable rebuild fails", async () => {
    const target = caseDoc("doc-target", "Target exhibit.pdf");
    const recovered = caseDoc("doc-recovered", "Remaining record.pdf");
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([target, recovered]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      deleteDoc: vi.fn().mockResolvedValue({ deleted: target.id }),
      reindexDocs: vi
        .fn()
        .mockRejectedValueOnce(new Error("index volume unavailable"))
        .mockResolvedValueOnce({ documents: [recovered], issues: [] }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove Target exhibit.pdf from this matter",
      })
    );

    expect(
      await screen.findByText(/Target exhibit\.pdf.*was removed, but the case record still needs reindexing/i)
    ).toBeTruthy();
    expect(screen.getByText(/index volume unavailable/)).toBeTruthy();
    expect(screen.getByText("Case record refresh required")).toBeTruthy();
    expect(screen.queryByText("Remaining record.pdf")).toBeNull();
    const blockedStart = screen.getByRole("button", { name: "Reindex case record first" });
    expect((blockedStart as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reindex now" }));
    expect(await screen.findByText("Remaining record.pdf")).toBeTruthy();
    await waitFor(() => expect(api.reindexDocs).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Case record refresh required")).toBeNull();
  });

  it("fails closed when a rejected document removal cannot restore the prior index", async () => {
    const target = caseDoc("doc-target", "Target exhibit.pdf");
    const retained = caseDoc("doc-retained", "Remaining record.pdf");
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([target, retained]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      deleteDoc: vi.fn().mockResolvedValue({
        deleted: null,
        needsReindex: true,
        error: "The prior case record could not be safely restored.",
      }),
      reindexDocs: vi.fn().mockResolvedValue({ documents: [target, retained], issues: [] }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove Target exhibit.pdf from this matter",
      })
    );

    expect(await screen.findByText(/Target exhibit\.pdf.*was not removed/i)).toBeTruthy();
    expect(screen.queryByText("Target exhibit.pdf")).toBeNull();
    expect(screen.queryByText("Remaining record.pdf")).toBeNull();
    expect(screen.getByText("Case record refresh required")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Reindex case record first" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reindex now" }));
    expect(await screen.findByText("Target exhibit.pdf")).toBeTruthy();
    expect(screen.getByText("Remaining record.pdf")).toBeTruthy();
    expect(api.reindexDocs).toHaveBeenCalledWith(beta.id);
  });

  it("filters the case record by filename or document type and clears the query", async () => {
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([]),
      listDocs: vi.fn().mockResolvedValue([
        caseDoc("doc-financials", "Quarterly financials.pdf", "PDF"),
        caseDoc("doc-deposition", "Jordan Lee.pdf", "Transcript"),
        caseDoc("doc-exhibit", "Exhibit 12.png", "Image"),
      ]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const filter = await screen.findByRole("searchbox", { name: "Filter case record" });
    fireEvent.change(filter, { target: { value: "transcript" } });

    expect(await screen.findByText("1 of 3 documents match")).toBeTruthy();
    expect(screen.getByText("Jordan Lee.pdf")).toBeTruthy();
    expect(screen.queryByText("Quarterly financials.pdf")).toBeNull();
    expect(screen.queryByText("Exhibit 12.png")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear case record filter" }));
    expect(await screen.findByText("3 total documents")).toBeTruthy();
    expect(screen.getByText("Quarterly financials.pdf")).toBeTruthy();
    expect(screen.getByText("Exhibit 12.png")).toBeTruthy();
  });

  it("owns focus and shows submission failures inside an accessible matter dialog", async () => {
    const creating = deferred<typeof beta>();
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      createMatter: vi.fn(() => creating.promise),
    });
    render(<App />);

    const trigger = await screen.findByRole("button", { name: "+ New matter" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "New matter" });
    const caption = within(dialog).getByRole("textbox", { name: "Caption" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(caption));
    expect(dialog.tagName).toBe("FORM");
    expect(within(dialog).getByRole("textbox", { name: "Court" })).toBeTruthy();
    expect(within(dialog).getByRole("textbox", { name: "Notes" })).toBeTruthy();

    fireEvent.change(caption, { target: { value: "Newco v. Northstar" } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(api.createMatter).toHaveBeenCalled());
    expect((cancel as HTMLButtonElement).disabled).toBe(true);

    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New matter" })).toBeTruthy();

    await act(async () => creating.reject(new Error("Matter store unavailable")));
    const localError = await within(dialog).findByRole("alert");
    expect(localError.textContent).toContain("Matter store unavailable");
    expect((cancel as HTMLButtonElement).disabled).toBe(false);

    caption.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(caption);

    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New matter" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("exposes person editing as a real button and restores focus after the dialog closes", async () => {
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([
        person("person-beta", beta.id, "Beta Witness"),
      ]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    const editPerson = await screen.findByRole("button", {
      name: "Select and edit Beta Witness",
    });
    editPerson.focus();
    fireEvent.click(editPerson);

    const dialog = await screen.findByRole("dialog", { name: "Edit person" });
    const fullName = within(dialog).getByRole("textbox", { name: "Full name" });
    await waitFor(() => expect(document.activeElement).toBe(fullName));
    expect(within(dialog).getByRole("textbox", { name: "Role" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Voice (this witness)" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Attitude" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit person" })).toBeNull());
    expect(document.activeElement).toBe(editPerson);
  });

  it("keeps the last-known-good matter list when a later refresh fails", async () => {
    const recoverableMatter = {
      ...beta,
      id: "33333333-3333-4333-8333-333333333333",
    };
    const api = installApi({
      listMatters: vi
        .fn()
        .mockResolvedValueOnce({
          matters: [recoverableMatter],
          dataErrors: [`Matter ${recoverableMatter.id}: saved metadata needs recovery.`],
        })
        .mockRejectedValueOnce(new Error("matter index temporarily unavailable")),
      restoreMatterMeta: vi.fn().mockResolvedValue({ ok: true, restoredFrom: "matter.json.bak" }),
    });
    render(<App />);

    expect(
      await screen.findByRole("button", { name: /Beta v\. Bravo/ })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }));

    expect(await screen.findByText(/Failed to load matters:.*matter index temporarily unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Beta v\. Bravo/ })).toBeTruthy();
    expect(screen.queryByText("No matters yet")).toBeNull();
    expect(api.listMatters).toHaveBeenCalledTimes(2);
  });

  it("opens a successfully created matter even when its follow-up list refresh fails", async () => {
    const created = {
      ...alpha,
      id: "matter-created",
      caption: "Newco v. Northstar",
      court: "S.D.N.Y.",
    };
    const api = installApi({
      listMatters: vi
        .fn()
        .mockResolvedValueOnce({ matters: [beta], dataErrors: [] })
        .mockRejectedValueOnce(new Error("matter index temporarily unavailable")),
      createMatter: vi.fn().mockResolvedValue(created),
      listPersonas: vi.fn().mockResolvedValue([]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "+ New matter" }));
    const dialog = await screen.findByRole("dialog", { name: "New matter" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Caption" }), {
      target: { value: created.caption },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Court" }), {
      target: { value: created.court },
    });
    fireEvent.submit(dialog);

    expect(await screen.findByRole("heading", { name: created.caption })).toBeTruthy();
    expect(screen.getByText(created.court)).toBeTruthy();
    expect(screen.getByText(/Failed to load matters:.*matter index temporarily unavailable/)).toBeTruthy();
    expect(api.createMatter).toHaveBeenCalledOnce();
    expect(api.listMatters).toHaveBeenCalledTimes(2);
  });

  it("clears stale people and their practice selection when a people refresh fails", async () => {
    const betaWitness = person("person-beta", beta.id, "Beta Witness");
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi
        .fn()
        .mockResolvedValueOnce([betaWitness])
        .mockRejectedValueOnce(new Error("people store locked")),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(
      await screen.findByRole("button", { name: "Select and edit Beta Witness" })
    ).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Person" }) as HTMLSelectElement).value).toBe(
      betaWitness.id
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));

    expect(await screen.findByText(/People unavailable: people store locked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select and edit Beta Witness" })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Person" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Begin examination" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(api.listPersonas).toHaveBeenCalledTimes(2);
  });

  it("clears stale saved-session actions when a session refresh fails", async () => {
    const savedSession = {
      id: "session-stale",
      personaId: "person-beta",
      mode: "cross",
      startedAt: "2026-07-13T12:00:00.000Z",
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi
        .fn()
        .mockResolvedValueOnce({ sessions: [savedSession], dataErrors: [] })
        .mockRejectedValueOnce(new Error("session store locked")),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByRole("button", { name: /^Review session/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));

    expect(await screen.findByText(/Past sessions unavailable: session store locked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Review session/ })).toBeNull();
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("keeps fulfilled matter sections usable when another section fails, then clears the warning", async () => {
    const savedSession = {
      id: "session-partial",
      personaId: "person-beta",
      mode: "cross",
      startedAt: "2026-07-13T12:00:00.000Z",
      lineCount: 2,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi
        .fn()
        .mockRejectedValueOnce(new Error("people store locked"))
        .mockResolvedValueOnce([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [savedSession], dataErrors: [] }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByRole("heading", { name: beta.caption })).toBeTruthy();
    expect(screen.getByText("Beta exhibit.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review session/ })).toBeTruthy();
    expect(screen.getByText(/People unavailable: people store locked/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    await waitFor(() => expect(api.listPersonas).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("button", {
        name: "Select and edit Beta Witness",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/People unavailable: people store locked/)).toBeNull();
  });

  it("marks and explains a session recovered from an unfinished checkpoint", async () => {
    const interruptedSession = {
      id: "session-interrupted",
      personaId: "person-beta",
      mode: "cross" as const,
      startedAt: "2026-07-13T12:00:00.000Z",
      unfinished: true,
      lineCount: 1,
      canOpenTranscript: false,
      canOpenReport: false,
    };
    const savedReview = review(interruptedSession.id, beta.id, "Beta Witness");
    const interruptedReview = {
      ...savedReview,
      unfinished: true,
      session: { ...savedReview.session, endedAt: undefined as string | undefined },
    };
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue({
        sessions: [interruptedSession],
        dataErrors: [],
      }),
      getSessionReview: vi.fn().mockResolvedValue(interruptedReview),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(
      await screen.findByLabelText("Interrupted session recovered from an automatic checkpoint")
    ).toBeTruthy();
    const reviewButton = screen.getByRole("button", { name: /^Review session/ });
    reviewButton.focus();
    fireEvent.click(reviewButton);
    expect(
      await screen.findByRole("status", { name: "Interrupted session recovery" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close session review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(reviewButton);
  });

  it("surfaces a damaged saved session and restores its validated backup", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const restoredSession = {
      id: sessionId,
      personaId: "person-beta",
      mode: "cross",
      startedAt: "2026-07-13T12:00:00.000Z",
      lineCount: 4,
      canOpenTranscript: true,
      canOpenReport: false,
    };
    const api = installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi.fn().mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([]),
      listSessions: vi
        .fn()
        .mockResolvedValueOnce({
          sessions: [],
          dataErrors: [`Session ${sessionId}: saved session JSON is missing. Use Restore.`],
        })
        .mockResolvedValueOnce({ sessions: [restoredSession], dataErrors: [] }),
      restoreSession: vi.fn().mockResolvedValue({
        ok: true,
        restoredFrom: `${sessionId}.json.bak`,
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    expect(await screen.findByText("Saved-session recovery needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore from backup" }));

    await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith(beta.id, sessionId));
    expect(await screen.findByText(/Restored saved session from/)).toBeTruthy();
    expect(screen.queryByText("Saved-session recovery needed")).toBeNull();
  });
});

describe("recorded session identity", () => {
  it("keeps a completed transcript labeled with the persona and mode it was recorded under", async () => {
    const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let emitTranscript:
      | ((line: { role: string; text: string; at: string; replaceIndex?: number }) => void)
      | undefined;
    installApi({
      listMatters: vi.fn().mockResolvedValue({ matters: [beta], dataErrors: [] }),
      listPersonas: vi
        .fn()
        .mockResolvedValue([person("person-beta", beta.id, "Beta Witness")]),
      listDocs: vi.fn().mockResolvedValue([caseDoc("doc-beta", "Beta exhibit.pdf")]),
      listSessions: vi.fn().mockResolvedValue({ sessions: [], dataErrors: [] }),
      startVoice: vi.fn().mockResolvedValue({ id: sessionId, matterId: beta.id }),
      stopVoice: vi.fn().mockResolvedValue({
        session: { id: sessionId, matterId: beta.id },
        canOpenTranscript: true,
        canOpenReport: false,
        needsSaveRetry: false,
      }),
      onVoiceTranscript: vi.fn(
        (
          callback: (line: {
            role: string;
            text: string;
            at: string;
            replaceIndex?: number;
          }) => void
        ) => {
          emitTranscript = callback;
          return () => undefined;
        }
      ),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Beta v\. Bravo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Begin examination" }));
    await screen.findByRole("heading", { name: "Live examination" });
    await waitFor(() => expect(emitTranscript).toBeTypeOf("function"));

    act(() =>
      emitTranscript?.({
        role: "assistant",
        text: "I reviewed the ledger before signing.",
        at: "2026-07-18T10:00:00.000Z",
      })
    );
    const log = screen.getByRole("log", { name: "Live transcript" });
    expect(within(log).getByText("Beta Witness")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "End only" }));
    expect(await screen.findByText("Ended")).toBeTruthy();

    // Change the practice-form selections after the session ended…
    fireEvent.click(screen.getByRole("button", { name: "Matters" }));
    fireEvent.change(screen.getByLabelText("Practice mode"), {
      target: { value: "hearing" },
    });

    // …then return to the recorded exam. The saved record must keep its own labels.
    fireEvent.click(screen.getByRole("button", { name: "Live exam" }));
    await screen.findByRole("heading", { name: "Live examination" });
    const recordedLog = screen.getByRole("log", { name: "Live transcript" });
    expect(within(recordedLog).getByText("Beta Witness")).toBeTruthy();
    expect(within(recordedLog).queryByText(/Court ·/)).toBeNull();
    expect(screen.getByText("Cross-examination")).toBeTruthy();
    expect(screen.getByText("Witness")).toBeTruthy();
    expect(screen.queryByText("Hearing practice")).toBeNull();
  });
});
