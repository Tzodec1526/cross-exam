const TARGET_RATE = 24000;

export const PLAYBACK_LIMITS = Object.freeze({
  /** Roughly eight seconds of mono 24 kHz PCM16 in one server event. */
  maxBase64CharsPerChunk: 512_000,
  /** Bound retained AudioBuffers if delivery gets ahead of real-time playback. */
  maxQueuedSeconds: 12,
  /** Tiny deltas must not create an unbounded number of AudioBufferSourceNodes. */
  maxQueuedSources: 512,
  /** Bound aggregate decoded samples independently of scheduling timestamps. */
  maxQueuedSamples: TARGET_RATE * 12,
  /** Float32 bytes retained while the corresponding decoded samples are queued. */
  maxQueuedDecodedBytes: TARGET_RATE * 12 * Float32Array.BYTES_PER_ELEMENT,
});

interface QueuedSourceAllocation {
  samples: number;
  decodedBytes: number;
}

/** Convert Float32 samples to base64 PCM16 LE (little-endian). */
export function floatToBase64Pcm16(input: Float32Array): string {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    pcm[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
  }
  const bytes = new Uint8Array(pcm.buffer);
  // Avoid spread (...array) which can blow the call stack on large buffers
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

export function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}

/** Linear resample to target rate (good enough for speech). */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0]! * (1 - t) + input[i1]! * t;
  }
  return out;
}

export function rmsLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

export type MicStatus = {
  sampleRate: number;
  level: number; // 0..1-ish RMS
  framesSent: number;
  muted: boolean;
};

/**
 * Capture mic, downsample to 24 kHz PCM16, emit base64 chunks for xAI Realtime.
 */
export class MicStreamer {
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silent: GainNode | null = null;
  private stream: MediaStream | null = null;
  private muted = false;
  private framesSent = 0;
  private onStatus: ((s: MicStatus) => void) | null = null;
  /** Invalidates an in-flight start() when stop() runs during the permission prompt. */
  private lifecycle = 0;

  setStatusHandler(cb: ((s: MicStatus) => void) | null) {
    this.onStatus = cb;
  }

  async start(onPcm: (base64: string) => void): Promise<{ sampleRate: number }> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API unavailable in this window.");
    }

    const lifecycle = ++this.lifecycle;
    this.framesSent = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let silent: GainNode | null = null;

    /** Tear down only the resources acquired by this start attempt. */
    const cleanupAttempt = async () => {
      if (processor) processor.onaudioprocess = null;
      for (const node of [processor, source, silent]) {
        try {
          node?.disconnect();
        } catch {
          /* a partially connected node may already be disconnected */
        }
      }
      if (stream) {
        try {
          for (const track of stream.getTracks()) {
            try {
              track.stop();
            } catch {
              /* continue stopping the remaining tracks */
            }
          }
        } catch {
          /* malformed/retired MediaStream */
        }
      }
      try {
        if (ctx && ctx.state !== "closed") await ctx.close();
      } catch {
        /* startup cleanup must preserve the original failure */
      }

      // A newer start may already own these slots; never clear its resources.
      if (this.processor === processor) this.processor = null;
      if (this.source === source) this.source = null;
      if (this.silent === silent) this.silent = null;
      if (this.stream === stream) this.stream = null;
      if (this.ctx === ctx) this.ctx = null;
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // stop() may have run while the browser permission prompt was open.
      if (lifecycle !== this.lifecycle) {
        throw new Error("Microphone start cancelled.");
      }
      this.stream = stream;

      // Prefer 24 kHz but Chromium often runs at 48 kHz — we resample below.
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
      this.ctx = ctx;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      // stop() can also race the asynchronous AudioContext resume.
      if (lifecycle !== this.lifecycle) {
        throw new Error("Microphone start cancelled.");
      }

      const hardwareRate = ctx.sampleRate;
      source = ctx.createMediaStreamSource(stream);
      this.source = source;

      // ScriptProcessor must be connected into the graph to fire; keep output silent.
      const bufferSize = 4096;
      processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      this.processor = processor;
      silent = ctx.createGain();
      this.silent = silent;
      silent.gain.value = 0;

      processor.onaudioprocess = (e) => {
        if (this.muted || !this.ctx) return;
        const input = e.inputBuffer.getChannelData(0);
        // Copy — the buffer is reused
        const copy = new Float32Array(input.length);
        copy.set(input);

        const level = rmsLevel(copy);
        const at24k = resampleLinear(copy, this.ctx.sampleRate, TARGET_RATE);
        if (!at24k.length) return;

        try {
          const b64 = floatToBase64Pcm16(at24k);
          onPcm(b64);
          this.framesSent += 1;
          this.onStatus?.({
            sampleRate: this.ctx.sampleRate,
            level,
            framesSent: this.framesSent,
            muted: this.muted,
          });
        } catch (err) {
          console.error("[mic] encode failed", err);
        }
      };

      source.connect(processor);
      processor.connect(silent);
      silent.connect(ctx.destination);

      // Ensure tracks are live
      for (const t of stream.getAudioTracks()) {
        t.enabled = true;
        console.log("[mic] track", t.label, t.readyState, t.getSettings());
      }

      return { sampleRate: hardwareRate };
    } catch (err) {
      await cleanupAttempt();
      if (lifecycle !== this.lifecycle) {
        throw new Error("Microphone start cancelled.");
      }
      throw err;
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) t.enabled = !muted;
    }
    this.onStatus?.({
      sampleRate: this.ctx?.sampleRate ?? 0,
      level: 0,
      framesSent: this.framesSent,
      muted: this.muted,
    });
  }

  async stop() {
    // Cancel start() even if getUserMedia has not resolved and no stream exists yet.
    this.lifecycle += 1;
    const processor = this.processor;
    const source = this.source;
    const silent = this.silent;
    const stream = this.stream;
    const ctx = this.ctx;
    this.framesSent = 0;

    if (processor) processor.onaudioprocess = null;
    for (const node of [processor, source, silent]) {
      try {
        node?.disconnect();
      } catch {
        /* continue releasing the remaining graph */
      }
    }
    try {
      for (const track of stream?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          /* continue stopping the remaining tracks */
        }
      }
    } catch {
      /* malformed/retired MediaStream */
    }
    try {
      if (ctx && ctx.state !== "closed") await ctx.close();
    } catch {
      /* stop is best-effort and must still release owned slots */
    } finally {
      // A retry may have started while the old context was closing.
      if (this.processor === processor) this.processor = null;
      if (this.source === source) this.source = null;
      if (this.silent === silent) this.silent = null;
      if (this.stream === stream) this.stream = null;
      if (this.ctx === ctx) this.ctx = null;
    }
  }
}

export class PcmPlayer {
  private ctx: AudioContext;
  private nextTime = 0;
  private readonly rate = TARGET_RATE;
  private readonly sources = new Map<AudioBufferSourceNode, QueuedSourceAllocation>();
  private queuedSamples = 0;
  private queuedDecodedBytes = 0;
  private closed = false;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
  }

  async resume() {
    if (this.closed || this.ctx.state === "closed") return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Drop all queued/playing chunks (barge-in when counsel interrupts). */
  flush() {
    const sources = Array.from(this.sources.keys());
    this.sources.clear();
    this.queuedSamples = 0;
    this.queuedDecodedBytes = 0;
    this.nextTime = 0;
    for (const src of sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  private releaseSource(src: AudioBufferSourceNode) {
    const allocation = this.sources.get(src);
    if (!allocation) return;
    this.sources.delete(src);
    this.queuedSamples = Math.max(0, this.queuedSamples - allocation.samples);
    this.queuedDecodedBytes = Math.max(
      0,
      this.queuedDecodedBytes - allocation.decodedBytes
    );
    try {
      src.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  enqueueBase64(base64: string): boolean {
    if (
      this.closed ||
      this.ctx.state === "closed" ||
      typeof base64 !== "string" ||
      !base64 ||
      base64.length > PLAYBACK_LIMITS.maxBase64CharsPerChunk
    ) {
      return false;
    }
    void this.resume().catch((err) => console.error("[player] resume failed", err));
    let samples: Float32Array;
    try {
      samples = base64Pcm16ToFloat32(base64);
    } catch (err) {
      console.warn("[player] dropped malformed PCM audio", err);
      return false;
    }
    if (!samples.length) return false;
    // Play at whatever the context actually is; resample if needed
    const play = resampleLinear(samples, this.rate, this.ctx.sampleRate);
    const decodedBytes = samples.byteLength;
    if (
      this.sources.size >= PLAYBACK_LIMITS.maxQueuedSources ||
      this.queuedSamples + samples.length > PLAYBACK_LIMITS.maxQueuedSamples ||
      this.queuedDecodedBytes + decodedBytes > PLAYBACK_LIMITS.maxQueuedDecodedBytes
    ) {
      // A remote burst is intentionally dropped as a whole. Partially scheduling
      // it would corrupt PCM boundaries and flushing healthy queued speech would
      // make the failure less predictable.
      return false;
    }
    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.02;
    const duration = play.length / this.ctx.sampleRate;
    if (this.nextTime + duration - now > PLAYBACK_LIMITS.maxQueuedSeconds) {
      return false;
    }
    const buffer = this.ctx.createBuffer(1, play.length, this.ctx.sampleRate);
    // Decoder/resampler buffers are locally allocated ArrayBuffers; retain the
    // zero-copy path despite TypeScript's broader Float32Array generic.
    buffer.copyToChannel(play as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.onended = () => {
      src.onended = null;
      this.releaseSource(src);
    };
    this.sources.set(src, { samples: samples.length, decodedBytes });
    this.queuedSamples += samples.length;
    this.queuedDecodedBytes += decodedBytes;
    try {
      src.connect(this.ctx.destination);
      src.start(this.nextTime);
      this.nextTime += buffer.duration;
    } catch (err) {
      src.onended = null;
      this.releaseSource(src);
      console.warn("[player] dropped unschedulable PCM audio", err);
      return false;
    }
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    if (this.ctx.state !== "closed") await this.ctx.close();
  }
}
