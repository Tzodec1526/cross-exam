import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64Pcm16ToFloat32,
  floatToBase64Pcm16,
  MicStreamer,
  PcmPlayer,
  PLAYBACK_LIMITS,
  resampleLinear,
  rmsLevel,
} from "../src/audio";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function trackHarness(label: string, stopImpl?: () => void) {
  const stop = vi.fn(stopImpl);
  const track = {
    enabled: false,
    label,
    readyState: "live",
    getSettings: vi.fn(() => ({})),
    stop,
  } as unknown as MediaStreamTrack;
  return { track, stop };
}

function streamHarness(...tracks: MediaStreamTrack[]) {
  return {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks),
  } as unknown as MediaStream;
}

function contextHarness(options: {
  state?: AudioContextState;
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
  processorConnect?: () => void;
  processorDisconnect?: () => void;
} = {}) {
  let state: AudioContextState = options.state ?? "running";
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const processor = {
    connect: vi.fn(options.processorConnect),
    disconnect: vi.fn(options.processorDisconnect),
    onaudioprocess: null,
  };
  const silent = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
  };
  const resume = vi.fn(options.resume ?? (async () => {
    state = "running";
  }));
  const close = vi.fn(options.close ?? (async () => {
    state = "closed";
  }));
  const ctx = {
    sampleRate: 48_000,
    get state() {
      return state;
    },
    destination: {},
    resume,
    close,
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => silent),
  } as unknown as AudioContext;
  return { ctx, source, processor, silent, resume, close };
}

function installAudioMocks(streams: MediaStream[], contexts: AudioContext[]) {
  const streamQueue = [...streams];
  const contextQueue = [...contexts];
  const getUserMedia = vi.fn(async () => streamQueue.shift()!);
  const AudioContextMock = vi.fn(() => contextQueue.shift()!);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", AudioContextMock);
  return { getUserMedia, AudioContextMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio conversion", () => {
  it("round-trips PCM boundary and midpoint samples", () => {
    const source = new Float32Array([-1, -0.5, 0, 0.5, 1]);
    const decoded = base64Pcm16ToFloat32(floatToBase64Pcm16(source));

    expect(Array.from(decoded)).toEqual([
      -1,
      -0.5,
      0,
      0.499969482421875,
      0.999969482421875,
    ]);
  });

  it("encodes large microphone buffers without overflowing the call stack", () => {
    const source = new Float32Array(200_000).fill(0.25);
    const decoded = base64Pcm16ToFloat32(floatToBase64Pcm16(source));

    expect(decoded).toHaveLength(source.length);
    expect(decoded[199_999]).toBeCloseTo(0.25, 4);
  });

  it("resamples and measures edge cases deterministically", () => {
    const source = new Float32Array([0, 1, 0, -1]);

    expect(resampleLinear(source, 48_000, 24_000)).toEqual(new Float32Array([0, 0]));
    expect(resampleLinear(source, 24_000, 24_000)).toBe(source);
    expect(resampleLinear(new Float32Array(), 48_000, 24_000)).toHaveLength(0);
    expect(rmsLevel(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rmsLevel(new Float32Array())).toBe(0);
  });

  it("releases the stream and context after resume failure, then allows a retry", async () => {
    const firstTrack = trackHarness("first");
    const secondTrack = trackHarness("second");
    const firstStream = streamHarness(firstTrack.track);
    const secondStream = streamHarness(secondTrack.track);
    const failed = contextHarness({
      state: "suspended",
      resume: async () => {
        throw new Error("resume failed");
      },
    });
    const retry = contextHarness();
    installAudioMocks([firstStream, secondStream], [failed.ctx, retry.ctx]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const mic = new MicStreamer();
    await expect(mic.start(vi.fn())).rejects.toThrow("resume failed");

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(failed.close).toHaveBeenCalledOnce();

    await expect(mic.start(vi.fn())).resolves.toEqual({ sampleRate: 48_000 });
    await mic.stop();

    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(retry.processor.disconnect).toHaveBeenCalledOnce();
    expect(retry.source.disconnect).toHaveBeenCalledOnce();
    expect(retry.silent.disconnect).toHaveBeenCalledOnce();
    expect(retry.close).toHaveBeenCalledOnce();
  });

  it("fully tears down a partially connected graph without masking its startup error", async () => {
    const firstTrack = trackHarness("throws-on-stop", () => {
      throw new Error("track stop failed");
    });
    const secondTrack = trackHarness("still-stops");
    const stream = streamHarness(firstTrack.track, secondTrack.track);
    const graph = contextHarness({
      processorConnect: () => {
        throw new Error("graph connect failed");
      },
      processorDisconnect: () => {
        throw new Error("processor disconnect failed");
      },
      close: async () => {
        throw new Error("context close failed");
      },
    });
    installAudioMocks([stream], [graph.ctx]);

    const mic = new MicStreamer();
    await expect(mic.start(vi.fn())).rejects.toThrow("graph connect failed");

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(graph.processor.disconnect).toHaveBeenCalledOnce();
    expect(graph.source.disconnect).toHaveBeenCalledOnce();
    expect(graph.silent.disconnect).toHaveBeenCalledOnce();
    expect(graph.close).toHaveBeenCalledOnce();
    expect(graph.processor.onaudioprocess).toBeNull();
  });

  it("keeps permission-prompt cancellation semantics and stops the late stream", async () => {
    const pendingStream = deferred<MediaStream>();
    const track = trackHarness("late");
    const stream = streamHarness(track.track);
    const getUserMedia = vi.fn(() => pendingStream.promise);
    const AudioContextMock = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", AudioContextMock);

    const mic = new MicStreamer();
    const start = mic.start(vi.fn());
    const cancelled = expect(start).rejects.toThrow("Microphone start cancelled.");
    await mic.stop();
    pendingStream.resolve(stream);

    await cancelled;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(AudioContextMock).not.toHaveBeenCalled();
  });

  it("never clears resources owned by a newer start attempt", async () => {
    const firstResume = deferred<void>();
    const firstTrack = trackHarness("superseded");
    const currentTrack = trackHarness("current");
    const first = contextHarness({ state: "suspended", resume: () => firstResume.promise });
    const current = contextHarness();
    installAudioMocks(
      [streamHarness(firstTrack.track), streamHarness(currentTrack.track)],
      [first.ctx, current.ctx]
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const mic = new MicStreamer();
    const supersededStart = mic.start(vi.fn());
    await vi.waitFor(() => expect(first.resume).toHaveBeenCalledOnce());

    await expect(mic.start(vi.fn())).resolves.toEqual({ sampleRate: 48_000 });
    firstResume.resolve();
    await expect(supersededStart).rejects.toThrow("Microphone start cancelled.");

    await mic.stop();
    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(currentTrack.stop).toHaveBeenCalledOnce();
    expect(current.processor.disconnect).toHaveBeenCalledOnce();
    expect(current.source.disconnect).toHaveBeenCalledOnce();
    expect(current.silent.disconnect).toHaveBeenCalledOnce();
    expect(current.close).toHaveBeenCalledOnce();
  });

  it("continues stop cleanup when graph, track, and context teardown throw", async () => {
    const firstTrack = trackHarness("throws", () => {
      throw new Error("track stop failed");
    });
    const secondTrack = trackHarness("still stops");
    const graph = contextHarness({
      processorDisconnect: () => {
        throw new Error("processor disconnect failed");
      },
      close: async () => {
        throw new Error("context close failed");
      },
    });
    installAudioMocks([streamHarness(firstTrack.track, secondTrack.track)], [graph.ctx]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const mic = new MicStreamer();
    await mic.start(vi.fn());
    await expect(mic.stop()).resolves.toBeUndefined();

    expect(graph.processor.disconnect).toHaveBeenCalledOnce();
    expect(graph.source.disconnect).toHaveBeenCalledOnce();
    expect(graph.silent.disconnect).toHaveBeenCalledOnce();
    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(graph.close).toHaveBeenCalledOnce();
  });

  it("keeps a newer start alive while an older stop awaits context close", async () => {
    const closeGate = deferred<void>();
    const oldTrack = trackHarness("old");
    const newTrack = trackHarness("new");
    const oldGraph = contextHarness({ close: () => closeGate.promise });
    const newGraph = contextHarness();
    installAudioMocks(
      [streamHarness(oldTrack.track), streamHarness(newTrack.track)],
      [oldGraph.ctx, newGraph.ctx]
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const mic = new MicStreamer();
    await mic.start(vi.fn());
    const stopping = mic.stop();
    await vi.waitFor(() => expect(oldGraph.close).toHaveBeenCalledOnce());
    await expect(mic.start(vi.fn())).resolves.toEqual({ sampleRate: 48_000 });
    closeGate.resolve();
    await stopping;
    await mic.stop();

    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).toHaveBeenCalledOnce();
    expect(newGraph.close).toHaveBeenCalledOnce();
  });
});

describe("PCM playback boundaries", () => {
  function installPlayerContext() {
    let state: AudioContextState = "running";
    let currentTime = 0;
    const sources: Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    }));
    const createBufferSource = vi.fn(() => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    });
    const close = vi.fn(async () => {
      state = "closed";
    });
    const ctx = {
      sampleRate: 24_000,
      get currentTime() {
        return currentTime;
      },
      destination: {},
      get state() {
        return state;
      },
      resume: vi.fn(async () => undefined),
      close,
      createBuffer,
      createBufferSource,
    } as unknown as AudioContext;
    vi.stubGlobal("AudioContext", vi.fn(() => ctx));
    return {
      sources,
      createBuffer,
      createBufferSource,
      close,
      setCurrentTime(value: number) {
        currentTime = value;
      },
    };
  }

  it("drops malformed, odd-byte, and oversized audio without throwing", () => {
    const playerContext = installPlayerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const player = new PcmPlayer();

    expect(player.enqueueBase64("not valid base64!!")).toBe(false);
    expect(player.enqueueBase64("AA==")).toBe(false);
    expect(player.enqueueBase64("A".repeat(PLAYBACK_LIMITS.maxBase64CharsPerChunk + 1))).toBe(false);
    expect(playerContext.createBuffer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("caps queued playback and refuses new audio after close", async () => {
    const playerContext = installPlayerContext();
    const player = new PcmPlayer();
    const oneSecond = floatToBase64Pcm16(new Float32Array(24_000));
    let accepted = 0;
    for (let index = 0; index < 20; index += 1) {
      if (player.enqueueBase64(oneSecond)) accepted += 1;
    }

    expect(accepted).toBe(12);
    expect(playerContext.sources.length).toBe(accepted);
    await player.close();
    expect(player.enqueueBase64(oneSecond)).toBe(false);
    expect(playerContext.close).toHaveBeenCalledOnce();
  });

  it("hard-caps tiny source bursts and reuses a completed source slot", () => {
    const playerContext = installPlayerContext();
    const player = new PcmPlayer();
    const oneSample = floatToBase64Pcm16(new Float32Array([0]));
    let accepted = 0;

    for (let index = 0; index < PLAYBACK_LIMITS.maxQueuedSources + 64; index += 1) {
      if (player.enqueueBase64(oneSample)) accepted += 1;
    }

    expect(accepted).toBe(PLAYBACK_LIMITS.maxQueuedSources);
    expect(playerContext.createBufferSource).toHaveBeenCalledTimes(
      PLAYBACK_LIMITS.maxQueuedSources
    );

    playerContext.sources[0]!.onended?.();
    expect(playerContext.sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(player.enqueueBase64(oneSample)).toBe(true);
    expect(playerContext.createBufferSource).toHaveBeenCalledTimes(
      PLAYBACK_LIMITS.maxQueuedSources + 1
    );
  });

  it("hard-caps aggregate decoded samples and bytes across a burst", () => {
    const playerContext = installPlayerContext();
    const player = new PcmPlayer();
    const chunkSamples = PLAYBACK_LIMITS.maxQueuedSamples / 4;
    const threeSeconds = floatToBase64Pcm16(new Float32Array(chunkSamples));

    expect(chunkSamples * 4 * Float32Array.BYTES_PER_ELEMENT).toBe(
      PLAYBACK_LIMITS.maxQueuedDecodedBytes
    );
    for (let index = 0; index < 4; index += 1) {
      expect(player.enqueueBase64(threeSeconds)).toBe(true);
    }
    expect(player.enqueueBase64(threeSeconds)).toBe(false);
    expect(playerContext.createBufferSource).toHaveBeenCalledTimes(4);

    playerContext.setCurrentTime(3);
    playerContext.sources[0]!.onended?.();
    expect(player.enqueueBase64(threeSeconds)).toBe(true);
    expect(playerContext.createBufferSource).toHaveBeenCalledTimes(5);
  });
});
