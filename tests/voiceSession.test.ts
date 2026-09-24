import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const socketHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    readyState: number;
    bufferedAmount: number;
    sent: string[];
    pingCalls: number;
    terminateCalls: number;
    terminate: () => void;
    open: () => void;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  urls: [] as string[],
  options: [] as unknown[],
}));

const serviceMocks = vi.hoisted(() => ({
  generateCalls: [] as unknown[][],
  generateImpl: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  saveCalls: [] as unknown[][],
  saveImpl: undefined as undefined | ((...args: unknown[]) => string),
  transcriptCalls: [] as unknown[][],
  transcriptImpl: undefined as undefined | ((...args: unknown[]) => string),
  dossier: "Grounded dossier",
  instructions: "Test instructions",
  sessionJsonByteLimit: 16 * 1024 * 1024,
  retrievalCalls: [] as string[],
  retrieveImpl: undefined as
    | undefined
    | ((question: string) => { text: string; hitCount: number }),
  searchCalls: [] as unknown[][],
  searchImpl: undefined as undefined | ((...args: unknown[]) => unknown),
  excerptCalls: [] as unknown[][],
  excerptImpl: undefined as undefined | ((...args: unknown[]) => unknown),
  priorCalls: [] as unknown[][],
  priorImpl: undefined as undefined | ((...args: unknown[]) => unknown),
  uuidSequence: 0,
}));

vi.mock("electron", () => ({ BrowserWindow: class BrowserWindow {} }));

vi.mock("uuid", () => ({ v4: () => `session-${++serviceMocks.uuidSequence}` }));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    bufferedAmount = 0;
    sent: string[] = [];
    pingCalls = 0;
    terminateCalls = 0;
    terminate = () => {
      this.terminateCalls += 1;
      this.readyState = FakeWebSocket.CLOSED;
    };

    constructor(url: string, options?: unknown) {
      super();
      socketHarness.urls.push(url);
      socketHarness.options.push(options);
      socketHarness.instances.push(this);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    ping() {
      this.pingCalls += 1;
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }
  }

  return { default: FakeWebSocket };
});

vi.mock("../electron/services/settings.js", () => ({
  loadSettings: () => ({ xaiApiKey: "xai-test-key", defaultVoice: "eve" }),
}));

vi.mock("../electron/services/matters.js", () => ({
  getMatter: (matterId: string) => ({
    id: matterId,
    caption: `Matter ${matterId}`,
    court: "Test court",
    notes: "",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
  }),
  listPersonas: (matterId: string) => [{
    id: `person-${matterId}`,
    matterId,
    fullName: `Witness ${matterId}`,
    role: "Fact witness",
    attitude: "neutral",
    notes: "",
    keyterms: [],
    voice: "",
    createdAt: "2026-07-13T12:00:00.000Z",
  }],
}));

vi.mock("../electron/services/indexer.js", () => ({
  SEARCH_INPUT_LIMITS: Object.freeze({
    queryChars: 2_000,
    toolQueryChars: 1_000,
    witnessNameChars: 200,
    docTypeChars: 80,
    fileNameChars: 512,
    terms: 64,
  }),
  clampMaxResults: (_value: unknown, fallback = 8) => fallback,
  getDocumentExcerpt: (...args: unknown[]) => {
    serviceMocks.excerptCalls.push(args);
    return serviceMocks.excerptImpl?.(...args) ?? [];
  },
  getPriorTestimony: (...args: unknown[]) => {
    serviceMocks.priorCalls.push(args);
    return serviceMocks.priorImpl?.(...args) ?? [];
  },
  loadIndex: (matterId: string) => ({
    matterId,
    builtAt: "2026-07-13T12:00:00.000Z",
    documents: [{ id: "doc-1" }],
    chunks: [{ id: "chunk-1" }],
  }),
  searchCaseRecord: (...args: unknown[]) => {
    serviceMocks.searchCalls.push(args);
    return serviceMocks.searchImpl?.(...args) ?? [];
  },
}));

vi.mock("../electron/services/caseContext.js", () => ({
  buildSessionDossier: () => ({ dossier: serviceMocks.dossier, docCount: 1, chunkCount: 1, excerptCount: 1 }),
  retrieveForQuestion: (_matterId: string, _persona: unknown, question: string) => {
    serviceMocks.retrievalCalls.push(question);
    return serviceMocks.retrieveImpl?.(question) ?? { text: "", hitCount: 0 };
  },
}));

vi.mock("../electron/services/prompts.js", () => ({
  buildSessionInstructions: () => serviceMocks.instructions,
  DOSSIER_BEGIN: "===== BEGIN CASE FILE DOSSIER =====",
  DOSSIER_END: "===== END CASE FILE DOSSIER =====",
  isHearingMode: (mode: string) => mode === "hearing",
  sessionOpeningSpoken: () => "Please state your name.",
  sessionOpeningTranscript: () => "Witness sworn.",
}));

vi.mock("../electron/services/report.js", () => ({
  generateSessionReport: (...args: unknown[]) => {
    serviceMocks.generateCalls.push(args);
    if (!serviceMocks.generateImpl) throw new Error("Unexpected report generation");
    return serviceMocks.generateImpl(...args);
  },
  saveSession: (...args: unknown[]) => {
    // Persist snapshots, not mutable manager references, so each checkpoint can
    // be asserted independently after later transcript mutations.
    serviceMocks.saveCalls.push([
      JSON.parse(JSON.stringify(args[0])) as unknown,
      ...args.slice(1),
    ]);
    if (serviceMocks.saveImpl) return serviceMocks.saveImpl(...args);
    return "session.json";
  },
  REPORT_LIMITS: {
    get maxSessionJsonBytes() {
      return serviceMocks.sessionJsonByteLimit;
    },
  },
  writeTranscriptMarkdown: (...args: unknown[]) => {
    serviceMocks.transcriptCalls.push(args);
    if (serviceMocks.transcriptImpl) return serviceMocks.transcriptImpl(...args);
    return `${(args[0] as { id: string }).id}-transcript.md`;
  },
}));

import {
  SESSION_CHECKPOINT_DEBOUNCE_MS,
  VOICE_LIVE_TRANSCRIPT_LIMITS,
  VOICE_PING_INTERVAL_MS,
  VOICE_PONG_TIMEOUT_MS,
  VOICE_MODEL,
  VoiceSessionManager,
} from "../electron/services/voiceSession.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(matterId: string) {
  return {
    matterId,
    personaId: `person-${matterId}`,
    mode: "cross" as const,
  };
}

type SavedSessionSnapshot = {
  id: string;
  matterId: string;
  startedAt: string;
  endedAt?: string;
  transcript: Array<{ role: string; text: string; at: string }>;
};

function savedSessionSnapshots(): SavedSessionSnapshot[] {
  return serviceMocks.saveCalls.map((call) => call[0] as SavedSessionSnapshot);
}

function emitSocketMessage(
  socket: (typeof socketHarness.instances)[number],
  event: Record<string, unknown>
): void {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
}

type ToolOutputEvent = {
  type: "conversation.item.create";
  item: {
    type: "function_call_output";
    call_id: string;
    output: string;
  };
};

async function invokeTool(
  socket: (typeof socketHarness.instances)[number],
  name: string,
  callId: string,
  args: string
): Promise<ToolOutputEvent> {
  emitSocketMessage(socket, {
    type: "response.function_call_arguments.done",
    name,
    call_id: callId,
    arguments: args,
  });
  await Promise.resolve();
  await Promise.resolve();
  const output = socket.sent
    .map((payload) => JSON.parse(payload) as Partial<ToolOutputEvent>)
    .find(
      (event) =>
        event.type === "conversation.item.create" &&
        event.item?.type === "function_call_output" &&
        event.item.call_id === callId
    );
  expect(output).toBeDefined();
  return output as ToolOutputEvent;
}

async function openLatestSocket() {
  const socket = socketHarness.instances.at(-1);
  expect(socket).toBeDefined();
  socket!.open();
  await Promise.resolve();
  return socket!;
}

type EmittedEvent = { channel: string; payload: unknown };

function captureEvents(manager: VoiceSessionManager): EmittedEvent[] {
  const emitted: EmittedEvent[] = [];
  manager.setWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
    },
  } as never);
  return emitted;
}

function expectMinimalTerminalPayload(payload: Record<string, unknown>): void {
  const session = payload.session as Record<string, unknown> | null;
  if (session) {
    expect(Object.keys(session).sort()).toEqual(["id", "matterId"]);
    expect(session).not.toHaveProperty("transcript");
    expect(session).not.toHaveProperty("reportPath");
  }
  expect(payload).not.toHaveProperty("transcriptPath");
  expect(payload).not.toHaveProperty("reportPath");
  expect(payload).not.toHaveProperty("reportMarkdownPath");
  expect(typeof payload.needsSaveRetry).toBe("boolean");
}

beforeEach(() => {
  vi.useFakeTimers();
  socketHarness.instances.length = 0;
  socketHarness.urls.length = 0;
  socketHarness.options.length = 0;
  serviceMocks.generateCalls.length = 0;
  serviceMocks.generateImpl = undefined;
  serviceMocks.saveCalls.length = 0;
  serviceMocks.saveImpl = undefined;
  serviceMocks.transcriptCalls.length = 0;
  serviceMocks.transcriptImpl = undefined;
  serviceMocks.dossier = "Grounded dossier";
  serviceMocks.instructions = "Test instructions";
  serviceMocks.sessionJsonByteLimit = 16 * 1024 * 1024;
  serviceMocks.retrievalCalls.length = 0;
  serviceMocks.retrieveImpl = undefined;
  serviceMocks.searchCalls.length = 0;
  serviceMocks.searchImpl = undefined;
  serviceMocks.excerptCalls.length = 0;
  serviceMocks.excerptImpl = undefined;
  serviceMocks.priorCalls.length = 0;
  serviceMocks.priorImpl = undefined;
  serviceMocks.uuidSequence = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("VoiceSessionManager lifecycle ownership", () => {
  it.each(["cancel", "failure", "timeout"])(
    "contains late socket errors after a handshake ends through %s",
    async (outcome) => {
      const manager = new VoiceSessionManager();
      const start = manager.start(setup("alpha"));
      const socket = socketHarness.instances.at(-1)!;
      const rejected = expect(start).rejects.toThrow(/stopped|connection|timeout/i);
      if (outcome === "cancel") await manager.stop(false);
      else if (outcome === "failure") socket.emit("error", new Error("connection failed"));
      else vi.advanceTimersByTime(20_000);
      await rejected;

      // ws aborts a connecting handshake with an error on a later tick. It
      // still needs a listener after our user-facing start promise settles.
      expect(() => socket.emit("error", new Error("WebSocket was closed before the connection was established")))
        .not.toThrow();
      expect(manager.isActive()).toBe(false);
    }
  );

  it("uses the release-pinned xAI voice model", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    expect(socketHarness.urls).toEqual([
      `wss://api.x.ai/v1/realtime?model=${VOICE_MODEL}`,
    ]);
    await openLatestSocket();
    await start;
    await manager.stop(false);
  });

  it("waits for session.updated before sending the opening force_message", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const sentTypes = () =>
      socket.sent.map((payload) => (JSON.parse(payload) as { type?: string }).type);

    expect(sentTypes()).toEqual(["session.update"]);

    emitSocketMessage(socket, { type: "session.updated", session: {} });
    await Promise.resolve();

    expect(sentTypes()).toEqual(["session.update", "conversation.item.create"]);
    const opening = JSON.parse(socket.sent[1]!) as {
      item?: { type?: string; content?: Array<{ text?: string }> };
    };
    expect(opening.item?.type).toBe("force_message");
    expect(opening.item?.content?.[0]?.text).toBe("Please state your name.");

    await manager.stop(false);
  });

  it("holds the first hearing question until the opening force_message turn finishes", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start({
      matterId: "alpha",
      personaId: "person-alpha",
      mode: "hearing",
    });
    const socket = await openLatestSocket();
    await start;

    const sentTypes = () =>
      socket.sent.map((payload) => (JSON.parse(payload) as { type?: string }).type);

    expect(sentTypes()).toEqual(["session.update"]);
    emitSocketMessage(socket, { type: "session.updated", session: {} });
    await Promise.resolve();
    expect(sentTypes()).toEqual(["session.update", "conversation.item.create"]);
    expect(sentTypes()).not.toContain("response.create");

    emitSocketMessage(socket, { type: "response.created" });
    emitSocketMessage(socket, { type: "response.done" });
    await Promise.resolve();
    expect(sentTypes().at(-1)).toBe("response.create");

    await manager.stop(false);
  });

  it("sends function tools as the simple JSON schemas xAI Voice documents", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const update = JSON.parse(socket.sent[0]!) as {
      session?: { tools?: Array<{ parameters?: Record<string, unknown> }> };
    };
    const schemas = (update.session?.tools ?? []).map((tool) => tool.parameters ?? {});
    expect(schemas.length).toBe(3);
    for (const schema of schemas) {
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("additionalProperties");
    }

    await manager.stop(false);
  });

  it("returns a renderer-safe snapshot across connecting, live, and stopped states", async () => {
    const manager = new VoiceSessionManager();
    const initial = manager.getStateSnapshot();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(initial).toEqual({
      active: false,
      hasSession: false,
      hasUnsavedSession: false,
      matterId: null,
      sessionId: null,
    });

    const start = manager.start(setup("alpha"));
    expect(manager.getStateSnapshot()).toEqual({
      active: true,
      hasSession: false,
      hasUnsavedSession: false,
      matterId: "alpha",
      sessionId: null,
    });

    await openLatestSocket();
    const session = await start;
    expect(manager.getStateSnapshot()).toEqual({
      active: true,
      hasSession: true,
      hasUnsavedSession: true,
      matterId: "alpha",
      sessionId: session.id,
    });

    await manager.stop(false);
    expect(manager.getStateSnapshot()).toEqual({
      active: false,
      hasSession: false,
      hasUnsavedSession: false,
      matterId: null,
      sessionId: null,
    });
  });

  it("rejects a connecting start as soon as stop runs without advancing the handshake timeout", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const startOutcome = start.then(
      () => null,
      (error: unknown) => error
    );

    expect(socketHarness.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    const stop = manager.stop(false);
    const error = await startOutcome;
    const stopped = await stop;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stopped during connect/i);
    expect(stopped).toEqual({
      session: null,
      canOpenTranscript: false,
      canOpenReport: false,
      needsSaveRetry: false,
    });
    expect(socketHarness.instances[0]!.terminateCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.hasSession()).toBe(false);
    expect(manager.isActive()).toBe(false);
  });

  it("shares overlapping stops and keeps deferred report finalization from clearing a replacement", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const firstStart = manager.start(setup("alpha"));
    await openLatestSocket();
    const firstSession = await firstStart;

    const report = deferred<{ reportPath: string; markdownPath: string }>();
    serviceMocks.generateImpl = () => report.promise;

    const stopWithReport = manager.stop(true);
    const overlappingStop = manager.stop(false);

    expect(overlappingStop).toBe(stopWithReport);
    expect(serviceMocks.generateCalls).toHaveLength(1);
    expect(manager.hasSession()).toBe(true);
    expect(manager.hasUnsavedSession()).toBe(false);

    // A replacement request is allowed to queue, but cannot borrow the retiring
    // session's mutable manager slots while its report is still outstanding.
    const replacementStart = manager.start(setup("beta"));
    await Promise.resolve();
    expect(socketHarness.instances).toHaveLength(1);

    report.resolve({ reportPath: "alpha-report.json", markdownPath: "alpha-report.md" });
    const [firstResult, overlappingResult] = await Promise.all([stopWithReport, overlappingStop]);

    expect(firstResult).toBe(overlappingResult);
    expect(firstResult).toEqual({
      session: { id: firstSession.id, matterId: "alpha" },
      canOpenTranscript: true,
      canOpenReport: true,
      needsSaveRetry: false,
    });
    expectMinimalTerminalPayload(firstResult as Record<string, unknown>);
    const ended = emitted.find(
      (event) =>
        event.channel === "voice:status" &&
        (event.payload as { status?: string }).status === "ended"
    )!.payload as Record<string, unknown>;
    expect(ended).toEqual({ status: "ended", ...firstResult });
    expectMinimalTerminalPayload(ended);
    expect(serviceMocks.generateCalls).toHaveLength(1);

    await vi.waitFor(() => expect(socketHarness.instances).toHaveLength(2));
    await openLatestSocket();
    const replacement = await replacementStart;

    expect(replacement.id).not.toBe(firstSession.id);
    expect(replacement.matterId).toBe("beta");
    expect(replacement.reportPath).toBeUndefined();
    expect(manager.hasSession()).toBe(true);
    expect(manager.isActive()).toBe(true);

    // Let all deferred continuations drain: the old owner's finally/clear path must
    // not erase the replacement that now owns the manager.
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasSession()).toBe(true);
    expect(manager.isActive()).toBe(true);

    await manager.stop(false);
  });

  it("bounds websocket payloads and drops malformed output audio before renderer IPC", async () => {
    const manager = new VoiceSessionManager();
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    manager.setWindow({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
      },
    } as never);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    expect(socketHarness.options[0]).toMatchObject({ maxPayload: 2 * 1024 * 1024 });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.audio.delta", delta: {} })));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.audio.delta", delta: "AA==" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "response.audio.delta", delta: "A".repeat(512_004) })
      )
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.audio.delta", delta: "AAA=" })));

    expect(emitted.filter((event) => event.channel === "voice:audio")).toEqual([
      { channel: "voice:audio", payload: { delta: "AAA=" } },
    ]);
    await manager.stop(false);
  });

  it("ends and checkpoints the session with a visible row before aggregate transcript loss", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    for (let index = 0; index < 1_000 && manager.isActive(); index += 1) {
      emitSocketMessage(socket, {
        type: "response.audio_transcript.done",
        transcript: `${index}: ${"A".repeat(12_000)}`,
      });
    }
    await Promise.resolve();

    expect(manager.isActive()).toBe(false);
    expect(manager.hasSession()).toBe(false);
    const saved = savedSessionSnapshots().at(-1)!;
    expect(saved.endedAt).toEqual(expect.any(String));
    expect(saved.transcript.at(-1)).toMatchObject({
      role: "system",
      text: expect.stringContaining("Transcript safety limit reached"),
    });
    expect(saved.transcript.length).toBeLessThanOrEqual(
      VOICE_LIVE_TRANSCRIPT_LIMITS.maxLines
    );
    expect(saved.transcript.reduce((total, line) => total + line.text.length, 0)).toBeLessThanOrEqual(
      VOICE_LIVE_TRANSCRIPT_LIMITS.maxTotalChars
    );
    expect(
      emitted.some(
        (event) =>
          event.channel === "voice:error" &&
          String((event.payload as { message?: string }).message).includes(
            "before additional testimony could be silently dropped"
          )
      )
    ).toBe(true);
    expect(
      emitted.some(
        (event) =>
          event.channel === "voice:status" &&
          (event.payload as { status?: string }).status === "disconnected"
      )
    ).toBe(true);
  });

  it("reserves the final transcript row when the aggregate row budget is exhausted", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    for (let index = 0; index <= VOICE_LIVE_TRANSCRIPT_LIMITS.maxLines && manager.isActive(); index += 1) {
      emitSocketMessage(socket, {
        type: "response.audio_transcript.done",
        transcript: `Short unique answer ${index}`,
      });
    }
    await Promise.resolve();

    const saved = savedSessionSnapshots().at(-1)!;
    expect(saved.transcript).toHaveLength(VOICE_LIVE_TRANSCRIPT_LIMITS.maxLines);
    expect(saved.transcript.at(-1)?.text).toContain("Transcript safety limit reached");
    expect(manager.isActive()).toBe(false);
  });

  it("requires a pong for each keepalive and terminates a non-responsive socket", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    await vi.advanceTimersByTimeAsync(VOICE_PING_INTERVAL_MS);
    expect(socket.pingCalls).toBe(1);
    socket.emit("pong");
    await vi.advanceTimersByTimeAsync(VOICE_PONG_TIMEOUT_MS);
    expect(manager.isActive()).toBe(true);

    await vi.advanceTimersByTimeAsync(
      VOICE_PING_INTERVAL_MS - VOICE_PONG_TIMEOUT_MS
    );
    expect(socket.pingCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(VOICE_PONG_TIMEOUT_MS);

    expect(manager.isActive()).toBe(false);
    expect(socket.terminateCalls).toBe(1);
    expect(savedSessionSnapshots().at(-1)?.endedAt).toEqual(expect.any(String));
    expect(
      emitted.some(
        (event) =>
          event.channel === "voice:error" &&
          String((event.payload as { message?: string }).message).includes(
            "stopped responding to keepalive pings"
          )
      )
    ).toBe(true);
  });

  it("ends visibly instead of silently dropping audio when the outbound queue overflows", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;
    socket.bufferedAmount = Number.MAX_SAFE_INTEGER;

    manager.appendAudio("AAAA");
    await Promise.resolve();

    expect(manager.isActive()).toBe(false);
    expect(socket.terminateCalls).toBe(1);
    expect(savedSessionSnapshots().at(-1)?.endedAt).toEqual(expect.any(String));
    expect(
      emitted.some(
        (event) =>
          event.channel === "voice:error" &&
          String((event.payload as { message?: string }).message).includes(
            "outbound voice queue exceeded"
          )
      )
    ).toBe(true);
    expect(
      emitted.some(
        (event) =>
          event.channel === "voice:status" &&
          (event.payload as { status?: string }).status === "disconnected"
      )
    ).toBe(true);
  });

  it("rejects malformed, non-object, and byte-oversized tool arguments before services run", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const invalidArguments = [
      ["malformed", "{"],
      ["null", "null"],
      ["array", "[]"],
      ["oversized", JSON.stringify({ query: "🙂".repeat(5_000) })],
    ] as const;

    for (const [suffix, args] of invalidArguments) {
      const event = await invokeTool(socket, "search_case_record", `invalid-${suffix}`, args);
      const output = JSON.parse(event.item.output) as { error?: string };
      expect(output.error).toMatch(/invalid tool arguments/i);
      expect(Buffer.byteLength(event.item.output, "utf8")).toBeLessThanOrEqual(12 * 1024);
    }

    expect(serviceMocks.searchCalls).toEqual([]);
    expect(serviceMocks.excerptCalls).toEqual([]);
    expect(serviceMocks.priorCalls).toEqual([]);
    await manager.stop(false);
  });

  it("enforces required tool selectors and field types before calling record services", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const invalidCalls = [
      ["search_case_record", "search-missing", {}],
      ["search_case_record", "search-type", { query: "admission", witnessName: null }],
      ["get_document_excerpt", "excerpt-missing", { query: "approval" }],
      ["get_document_excerpt", "excerpt-empty", { fileName: "   " }],
      ["get_document_excerpt", "excerpt-id", { documentId: "not-a-uuid" }],
      ["get_prior_testimony", "prior-missing", {}],
      ["get_prior_testimony", "prior-empty", { witnessName: "   " }],
      ["get_prior_testimony", "prior-type", { witnessName: ["Witness alpha"] }],
    ] as const;

    for (const [name, callId, args] of invalidCalls) {
      const event = await invokeTool(socket, name, callId, JSON.stringify(args));
      const output = JSON.parse(event.item.output) as { error?: string };
      expect(output.error, `${name} ${callId}`).toEqual(expect.any(String));
    }

    expect(serviceMocks.searchCalls).toEqual([]);
    expect(serviceMocks.excerptCalls).toEqual([]);
    expect(serviceMocks.priorCalls).toEqual([]);
    await manager.stop(false);
  });

  it("returns public service errors without leaking local paths", async () => {
    serviceMocks.searchImpl = () => {
      throw new Error("EIO opening 'C:\\Users\\counsel\\Private Matter\\index.json'");
    };
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const event = await invokeTool(
      socket,
      "search_case_record",
      "public-error",
      JSON.stringify({ query: "reserve transfer" })
    );
    const output = JSON.parse(event.item.output) as { error?: string };

    expect(serviceMocks.searchCalls).toHaveLength(1);
    expect(output.error).toContain("[local path]");
    expect(output.error).not.toContain("counsel");
    expect(output.error).not.toContain("Private Matter");
    await manager.stop(false);
  });

  it("serializes oversized multibyte tool results as bounded valid UTF-8 JSON", async () => {
    serviceMocks.searchImpl = () =>
      Array.from({ length: 24 }, (_, index) => ({
        chunkId: `chunk-${index}`,
        fileName: `Exhibit ${index}.pdf`,
        docType: "exhibit",
        witnessName: "李 明",
        exhibitNo: String(index),
        pageHint: `p. ${index + 1}`,
        score: 1,
        text: "🙂".repeat(3_000),
      }));
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const event = await invokeTool(
      socket,
      "search_case_record",
      "multibyte-output",
      JSON.stringify({ query: "approval" })
    );
    const bytes = Buffer.from(event.item.output, "utf8");
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      results?: Array<{ text?: string }>;
      truncated?: boolean;
      totalResults?: number;
    };

    expect(bytes.byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(bytes.toString("utf8")).toBe(event.item.output);
    expect(parsed).toMatchObject({ truncated: true, totalResults: 24 });
    expect(parsed.results?.length).toBeGreaterThan(0);
    expect(parsed.results?.every((result) => (result.text?.length || 0) <= 800)).toBe(true);
    await manager.stop(false);
  });

  it("bounds renderer-facing tool activity arguments by entry, key, and value length", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;
    const activityArgs: Record<string, unknown> = {
      [`${"long-key-".repeat(12)}0`]: "🙂".repeat(400),
      nested: { mustNotCrossIpc: "private" },
    };
    for (let index = 1; index <= 12; index += 1) {
      activityArgs[`scalar-${index}`] = `value-${index}-${"x".repeat(400)}`;
    }

    await invokeTool(
      socket,
      "unknown_tool_with_a_name_that_is_still_bounded",
      "bounded-activity",
      JSON.stringify(activityArgs)
    );
    const activity = emitted
      .filter((event) => event.channel === "voice:tool")
      .map((event) => event.payload as { name?: string; args?: Record<string, unknown> })
      .find((event) => event.name?.startsWith("unknown_tool"));

    expect(activity).toBeDefined();
    expect(Object.keys(activity!.args || {})).toHaveLength(8);
    expect(Object.keys(activity!.args || {}).every((key) => key.length <= 80)).toBe(true);
    expect(
      Object.values(activity!.args || {}).every(
        (value) => typeof value === "number" || (typeof value === "string" && value.length <= 256)
      )
    ).toBe(true);
    expect(activity!.args).not.toHaveProperty("nested");
    await manager.stop(false);
  });

  it("caps both initial and retrieval instruction updates with explicit truncation markers", async () => {
    serviceMocks.instructions = `BASE INSTRUCTIONS\n${"B".repeat(30_000)}`;
    serviceMocks.retrieveImpl = (question) => ({
      text: `Evidence for ${question}\n${"R".repeat(30_000)}`,
      hitCount: 3,
    });
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    const initialUpdate = socket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((event) => event.type === "session.update") as {
        session: { instructions: string };
      };
    expect(initialUpdate.session.instructions.length).toBeLessThanOrEqual(22_000);
    expect(initialUpdate.session.instructions).toMatch(/Case grounding truncated.*22,000-character/s);

    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Did you approve the disputed transfer?",
    });
    await Promise.resolve();

    const updates = socket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((event) => event.type === "session.update") as Array<{
        session: { instructions: string };
      }>;
    expect(updates).toHaveLength(2);
    const retrievalInstructions = updates[1]!.session.instructions;
    expect(retrievalInstructions.length).toBeLessThanOrEqual(22_000);
    expect(retrievalInstructions).toContain("BEGIN RETRIEVED CASE RECORD");
    expect(retrievalInstructions).toMatch(/truncated.*22,000-character/s);

    await manager.stop(false);
  });

  it("drops retrieval queued during a completed response instead of leaking it into the next turn", async () => {
    serviceMocks.retrieveImpl = (question) => ({ text: `Record for ${question}`, hitCount: 1 });
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    emitSocketMessage(socket, { type: "response.created" });
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "First question whose response is already underway?",
    });
    emitSocketMessage(socket, { type: "response.done" });
    await Promise.resolve();

    expect(serviceMocks.retrievalCalls).toEqual([]);
    expect(
      socket.sent
        .map((payload) => JSON.parse(payload) as { type?: string })
        .filter((event) => event.type === "session.update")
    ).toHaveLength(1);

    emitSocketMessage(socket, { type: "input_audio_buffer.speech_started" });
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Second question that should own the current evidence?",
    });
    await Promise.resolve();

    expect(serviceMocks.retrievalCalls).toEqual([
      "Second question that should own the current evidence?",
    ]);
    const latestUpdate = socket.sent
      .map((payload) => JSON.parse(payload) as {
        type?: string;
        session?: { instructions?: string };
      })
      .filter((event) => event.type === "session.update")
      .at(-1)!;
    expect(latestUpdate.session?.instructions).toContain("Second question");
    expect(latestUpdate.session?.instructions).not.toContain("First question");

    await manager.stop(false);
  });

  it("keeps retrieval for a question that barged in before response.done", async () => {
    serviceMocks.retrieveImpl = (question) => ({ text: `Record for ${question}`, hitCount: 1 });
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    emitSocketMessage(socket, { type: "response.created" });
    emitSocketMessage(socket, { type: "input_audio_buffer.speech_started" });
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Where is the assignment buried?",
    });
    emitSocketMessage(socket, { type: "response.done", response: { status: "completed" } });
    await Promise.resolve();

    expect(serviceMocks.retrievalCalls).toEqual(["Where is the assignment buried?"]);
    await manager.stop(false);
  });

  it("flushes a cancelled response's queued question", async () => {
    serviceMocks.retrieveImpl = (question) => ({ text: `Record for ${question}`, hitCount: 1 });
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;

    emitSocketMessage(socket, { type: "response.created" });
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Did the board approve the sale?",
    });
    emitSocketMessage(socket, { type: "response.done", response: { status: "cancelled" } });
    await Promise.resolve();

    expect(serviceMocks.retrievalCalls).toEqual(["Did the board approve the sale?"]);
    await manager.stop(false);
  });

  it("saves assistant speech and a short counsel answer that had not been committed", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;

    emitSocketMessage(socket, {
      type: "response.audio_transcript.delta",
      delta: "I approved the transfer",
    });
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.updated",
      transcript: "Yes.",
    });
    await manager.stop(false);

    expect(session.transcript.map((line) => line.text)).toEqual([
      "[Case file loaded] 1 documents, 1 chunks, 1 witness dossier excerpts for Witness alpha.",
      "Witness sworn.",
      "Please state your name.",
      "[Record] Witness alpha is sworn. Counsel may proceed with examination.",
      "Yes.",
      "I approved the transfer",
    ]);
    expect(savedSessionSnapshots().at(-1)!.transcript.map((line) => line.text).slice(-2)).toEqual([
      "Yes.",
      "I approved the transfer",
    ]);
  });

  it("keeps both dossier markers when instructions are truncated", async () => {
    serviceMocks.instructions = [
      "ROLE NOTES",
      "N".repeat(12_000),
      "===== BEGIN CASE FILE DOSSIER =====",
      "E".repeat(20_000),
      "===== END CASE FILE DOSSIER =====",
    ].join("\n");
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;
    const update = socket.sent
      .map((payload) => JSON.parse(payload) as { type?: string; session?: { instructions?: string } })
      .find((event) => event.type === "session.update");
    const instructions = update?.session?.instructions ?? "";
    expect(instructions.length).toBeLessThanOrEqual(22_000);
    expect(instructions).toContain("===== BEGIN CASE FILE DOSSIER =====");
    expect(instructions).toContain("===== END CASE FILE DOSSIER =====");
    expect(instructions.indexOf("===== BEGIN CASE FILE DOSSIER =====")).toBeLessThan(
      instructions.indexOf("===== END CASE FILE DOSSIER =====")
    );
    await manager.stop(false);
  });

  it("stops a live transcript before formatted JSON can exceed the disk ceiling", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    await openLatestSocket();
    const session = await start;
    serviceMocks.sessionJsonByteLimit = 500;

    const socket = socketHarness.instances.at(-1)!;
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "界".repeat(400),
    });

    expect(session.transcript.some((line) => line.text.includes("Transcript safety limit"))).toBe(true);
    expect(session.transcript.some((line) => line.text.includes("界"))).toBe(false);
    await manager.stop(false);
  });

  it("bounds completed user and assistant transcript text before retrieval, storage, and emission", async () => {
    const manager = new VoiceSessionManager();
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    manager.setWindow({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
      },
    } as never);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;

    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "U".repeat(20_000),
    });
    emitSocketMessage(socket, {
      type: "response.audio_transcript.done",
      transcript: "A".repeat(20_000),
    });
    await Promise.resolve();

    const user = session.transcript.find((line) => line.role === "user")!;
    const assistant = session.transcript.find(
      (line) => line.role === "assistant" && line.text.startsWith("A")
    )!;
    expect(user.text.length).toBeLessThanOrEqual(12_000);
    expect(assistant.text.length).toBeLessThanOrEqual(12_000);
    expect(user.text).toContain("[transcript event truncated]");
    expect(assistant.text).toContain("[transcript event truncated]");
    expect(serviceMocks.retrievalCalls[0]!.length).toBeLessThanOrEqual(12_000);
    expect(serviceMocks.retrievalCalls[0]).toContain("[transcript event truncated]");

    const emittedSpeech = emitted
      .filter((event) => event.channel === "voice:transcript")
      .map((event) => event.payload as { role?: string; text?: string })
      .filter((line) => line.role === "user" || line.text?.startsWith("A"));
    expect(emittedSpeech.every((line) => (line.text?.length || 0) <= 12_000)).toBe(true);

    await manager.stop(false);
  });

  it("does not duplicate the forced opening or carry cancelled text into the next answer", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.audio_transcript.done",
          transcript: "Please state your name.",
        })
      )
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "response.audio_transcript.delta", delta: "stale partial" })
      )
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.cancelled" })));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.created" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "response.audio_transcript.delta", delta: "fresh answer" })
      )
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.audio_transcript.done" })));

    expect(
      session.transcript.filter(
        (line) => line.role === "assistant" && line.text === "Please state your name."
      )
    ).toHaveLength(1);
    expect(session.transcript.at(-1)).toMatchObject({
      role: "assistant",
      text: "fresh answer",
    });
    expect(session.transcript.some((line) => line.text.includes("stale partial"))).toBe(false);
    await manager.stop(false);
  });

  it("writes an immediate unfinished checkpoint before testimony and then checkpoints the opening", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    await openLatestSocket();
    const session = await start;

    expect(serviceMocks.saveCalls).toHaveLength(1);
    expect(savedSessionSnapshots()[0]).toMatchObject({
      id: session.id,
      matterId: "alpha",
      startedAt: session.startedAt,
      transcript: [],
    });
    expect(savedSessionSnapshots()[0]!.endedAt).toBeUndefined();

    // The spoken opening is a finalized assistant row and is checkpointed on the
    // same debounce path as later answers.
    expect(manager.hasUnsavedSession()).toBe(true);
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    expect(serviceMocks.saveCalls).toHaveLength(2);
    expect(savedSessionSnapshots()[1]!.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", text: "Please state your name." }),
      ])
    );
    expect(manager.hasUnsavedSession()).toBe(false);

    await manager.stop(false);
  });

  it("preserves identical counsel answers on separate speech turns", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;

    for (let turn = 0; turn < 2; turn += 1) {
      emitSocketMessage(socket, { type: "input_audio_buffer.speech_started" });
      // Duplicate delivery within this turn must still coalesce.
      for (let delivery = 0; delivery < 2; delivery += 1) {
        emitSocketMessage(socket, {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "Yes.",
        });
      }
    }

    await manager.stop(false);
    expect(session.transcript.filter((line) => line.role === "user").map((line) => line.text))
      .toEqual(["Yes.", "Yes."]);
    expect(savedSessionSnapshots().at(-1)!.transcript.filter((line) => line.role === "user"))
      .toHaveLength(2);
  });

  it("coalesces nearby finalized user and assistant rows into one disk checkpoint", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    await start;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    const baseline = serviceMocks.saveCalls.length;

    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "You approved the transfer?",
    });
    emitSocketMessage(socket, {
      type: "response.audio_transcript.done",
      transcript: "I approved it.",
    });
    await Promise.resolve();

    expect(serviceMocks.saveCalls).toHaveLength(baseline);
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS - 1);
    expect(serviceMocks.saveCalls).toHaveLength(baseline);
    vi.advanceTimersByTime(1);
    expect(serviceMocks.saveCalls).toHaveLength(baseline + 1);
    expect(savedSessionSnapshots().at(-1)!.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "You approved the transfer?" }),
        expect.objectContaining({ role: "assistant", text: "I approved it." }),
      ])
    );

    await manager.stop(false);
  });

  it("does not write for partial ASR revisions but persists an identical completed event", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    const baseline = serviceMocks.saveCalls.length;

    for (const transcript of [
      "You approved",
      "You approved the",
      "You approved the transfer",
    ]) {
      emitSocketMessage(socket, {
        type: "conversation.item.input_audio_transcription.updated",
        transcript,
      });
    }
    await Promise.resolve();
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS * 2);

    expect(serviceMocks.saveCalls).toHaveLength(baseline);
    expect(manager.hasUnsavedSession()).toBe(true);
    expect(session.transcript.filter((line) => line.role === "user")).toEqual([
      expect.objectContaining({ text: "You approved the transfer" }),
    ]);

    // xAI commonly repeats the last partial as the completed event. Completion,
    // not a text difference, is the durability boundary.
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "You approved the transfer",
    });
    await Promise.resolve();
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    expect(serviceMocks.saveCalls).toHaveLength(baseline + 1);

    await manager.stop(false);
  });

  it("cancels a retiring owner's checkpoint without letting it write into a replacement", async () => {
    const manager = new VoiceSessionManager();
    const firstStart = manager.start(setup("alpha"));
    const firstSocket = await openLatestSocket();
    await firstStart;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);

    emitSocketMessage(firstSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "This belongs to alpha only.",
    });
    await Promise.resolve();

    const replacementStart = manager.start(setup("beta"));
    await vi.waitFor(() => expect(socketHarness.instances).toHaveLength(2));
    const alphaWritesAfterStop = savedSessionSnapshots().filter(
      (session) => session.matterId === "alpha"
    ).length;

    await openLatestSocket();
    await replacementStart;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);

    expect(
      savedSessionSnapshots().filter((session) => session.matterId === "alpha")
    ).toHaveLength(alphaWritesAfterStop);
    expect(
      savedSessionSnapshots().filter((session) => session.matterId === "beta")
    ).toHaveLength(2);

    await manager.stop(false);
  });

  it("surfaces a checkpoint failure and retries the retained session on the next checkpoint", async () => {
    const manager = new VoiceSessionManager();
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    manager.setWindow({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
      },
    } as never);
    serviceMocks.saveImpl = () => {
      throw new Error("disk unavailable");
    };

    const start = manager.start(setup("alpha"));
    await openLatestSocket();
    const session = await start;

    expect(manager.hasSession()).toBe(true);
    expect(emitted).toContainEqual({
      channel: "voice:error",
      payload: expect.objectContaining({ message: expect.stringContaining("remains in memory") }),
    });

    serviceMocks.saveImpl = undefined;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    expect(savedSessionSnapshots()).toHaveLength(2);
    expect(savedSessionSnapshots().at(-1)).toMatchObject({
      id: session.id,
      matterId: "alpha",
    });
    expect(manager.hasUnsavedSession()).toBe(false);

    await manager.stop(false);
  });

  it("retains a final stop that fails to persist and clears it after an explicit retry", async () => {
    const manager = new VoiceSessionManager();
    const start = manager.start(setup("alpha"));
    await openLatestSocket();
    const session = await start;

    serviceMocks.saveImpl = () => {
      throw new Error("final write failed");
    };

    await expect(manager.stop(false)).rejects.toThrow("final write failed");
    expect(manager.hasSession()).toBe(true);
    expect(manager.hasUnsavedSession()).toBe(true);
    expect(manager.getStateSnapshot()).toEqual({
      active: false,
      hasSession: true,
      hasUnsavedSession: true,
      matterId: "alpha",
      sessionId: session.id,
    });

    serviceMocks.saveImpl = undefined;
    await expect(manager.stop(false)).resolves.toMatchObject({
      session: { id: session.id, matterId: "alpha" },
    });
    expect(manager.hasSession()).toBe(false);
    expect(manager.hasUnsavedSession()).toBe(false);
    expect(manager.getStateSnapshot()).toMatchObject({
      active: false,
      hasSession: false,
      hasUnsavedSession: false,
      matterId: null,
      sessionId: null,
    });
  });

  it("finishes a durable stop when only the optional transcript export fails", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const started = manager.start(setup("matter-export"));
    await openLatestSocket();
    await started;
    serviceMocks.transcriptImpl = () => {
      throw new Error("transcript volume unavailable");
    };

    const result = await manager.stop(false);

    expect(result).toEqual({
      session: { id: "session-1", matterId: "matter-export" },
      canOpenTranscript: false,
      canOpenReport: false,
      needsSaveRetry: false,
    });
    expect(manager.getStateSnapshot()).toMatchObject({
      active: false,
      hasSession: false,
      hasUnsavedSession: false,
    });
    expect(
      emitted.some(
        (event) =>
          event.channel === "voice:error" &&
          String((event.payload as { message?: string }).message).includes(
            "transcript export failed"
          )
      )
    ).toBe(true);
    const terminal = emitted.find(
      (event) =>
        event.channel === "voice:status" &&
        (event.payload as { status?: string }).status === "ended"
    )?.payload as Record<string, unknown>;
    expectMinimalTerminalPayload(terminal);
  });

  it("flushes the latest partial synchronously and tears down timers on disconnect", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);
    const baseline = serviceMocks.saveCalls.length;

    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.updated",
      transcript: "A final partial before the connection dropped",
    });
    socket.emit("close", 1006, Buffer.from("network lost"));
    await Promise.resolve();

    expect(serviceMocks.saveCalls).toHaveLength(baseline + 1);
    expect(savedSessionSnapshots().at(-1)).toMatchObject({
      matterId: "alpha",
      endedAt: expect.any(String),
      transcript: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text: "A final partial before the connection dropped",
        }),
      ]),
    });
    expect(manager.hasSession()).toBe(false);
    expect(manager.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const disconnected = emitted.find(
      (event) =>
        event.channel === "voice:status" &&
        (event.payload as { status?: string }).status === "disconnected"
    )!.payload as Record<string, unknown>;
    expect(disconnected).toEqual({
      status: "disconnected",
      reason: "Connection to voice service lost (code 1006: network lost).",
      session: { id: session.id, matterId: "alpha" },
      canOpenTranscript: true,
      canOpenReport: false,
      needsSaveRetry: false,
    });
    expectMinimalTerminalPayload(disconnected);
  });

  it("keeps a failed disconnect save renderer-safe while retaining testimony for retry", async () => {
    const manager = new VoiceSessionManager();
    const emitted = captureEvents(manager);
    const start = manager.start(setup("alpha"));
    const socket = await openLatestSocket();
    const session = await start;
    vi.advanceTimersByTime(SESSION_CHECKPOINT_DEBOUNCE_MS);

    serviceMocks.saveImpl = () => {
      throw new Error("disconnect disk failure");
    };
    emitSocketMessage(socket, {
      type: "conversation.item.input_audio_transcription.updated",
      transcript: "Sensitive retained testimony",
    });
    socket.emit("close", 1006, Buffer.from("network lost"));
    await Promise.resolve();

    const disconnected = emitted.find(
      (event) =>
        event.channel === "voice:status" &&
        (event.payload as { status?: string }).status === "disconnected"
    )!.payload as Record<string, unknown>;
    expect(disconnected).toEqual({
      status: "disconnected",
      reason: "Connection to voice service lost (code 1006: network lost).",
      session: { id: session.id, matterId: "alpha" },
      canOpenTranscript: false,
      canOpenReport: false,
      needsSaveRetry: true,
    });
    expectMinimalTerminalPayload(disconnected);
    expect(JSON.stringify(disconnected)).not.toContain("Sensitive retained testimony");
    expect(manager.hasSession()).toBe(true);
    expect(manager.hasUnsavedSession()).toBe(true);

    serviceMocks.saveImpl = undefined;
    await manager.stop(false);
  });
});
