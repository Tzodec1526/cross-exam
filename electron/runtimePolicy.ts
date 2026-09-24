import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_APP_ORIGIN = "app://bundle";
export const PACKAGED_APP_URL = `${PACKAGED_APP_ORIGIN}/index.html`;

type DevelopmentServerCandidate = {
  candidate: string | undefined;
  isPackaged: boolean;
};

/**
 * Development rendering is an explicit, loopback-only capability. Packaged
 * builds never inherit it from their launcher environment.
 */
export function resolveDevelopmentServerUrl({
  candidate,
  isPackaged,
}: DevelopmentServerCandidate): string | undefined {
  if (isPackaged || !candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !["localhost", "127.0.0.1", "[::1]"].includes(host) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function isPackagedApplicationOrigin(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "app:" &&
      parsed.hostname === "bundle" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/** Resolve an app://bundle asset without permitting encoded path traversal. */
export function resolvePackagedAssetPath(
  requestUrl: string,
  rendererRoot: string
): string | undefined {
  try {
    const parsed = new URL(requestUrl);
    if (!isPackagedApplicationOrigin(requestUrl)) return undefined;
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath.includes("\0")) return undefined;
    // A decoded `..\` is a parent segment on Windows and an ordinary filename on
    // Linux, where `path.sep` is `/`. Split on both separators and reject `.`
    // and `..` before `path.resolve`, which will not walk `..\` on Linux.
    const segments = decodedPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
    if (
      segments.length === 0 ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      return undefined;
    }
    const root = path.resolve(rendererRoot);
    const candidate = path.resolve(root, ...segments);
    const relative = path.relative(root, candidate);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * One coordinator owns every user-requested quit. A failed persistence attempt
 * deliberately resolves `false` and stays retryable instead of letting a second
 * app.quit() bypass the live-session guard.
 */
export class SaveBeforeQuitCoordinator {
  private inFlight: Promise<boolean> | null = null;
  private committed = false;

  constructor(
    private readonly stopAndSave: () => Promise<unknown>,
    private readonly quit: () => void,
    private readonly reportFailure: (error: unknown) => void
  ) {}

  isCommittedToQuit(): boolean {
    return this.committed;
  }

  finalize(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;

    const operation = Promise.resolve()
      .then(() => this.stopAndSave())
      .then(() => {
        // Set this before app.quit(): Electron emits before-quit synchronously.
        this.committed = true;
        this.quit();
        return true;
      })
      .catch((error: unknown) => {
        this.committed = false;
        try {
          this.reportFailure(error);
        } catch {
          // Error reporting must never turn a handled save failure into an
          // unhandled main-process rejection.
        }
        return false;
      });

    let shared: Promise<boolean>;
    shared = operation.finally(() => {
      if (this.inFlight === shared) this.inFlight = null;
    });
    this.inFlight = shared;
    return shared;
  }
}

/**
 * Own one asynchronous live-close confirmation at a time. Cancellation and
 * prompt failures resolve safely and release ownership so a later close can
 * ask again; only an explicit acceptance reaches the retry-safe finalizer.
 */
export class AsyncCloseConfirmationCoordinator {
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly confirmClose: () => Promise<boolean>,
    private readonly finalizeClose: () => Promise<boolean>,
    private readonly reportFailure: (error: unknown) => void = () => undefined
  ) {}

  hasPendingRequest(): boolean {
    return this.inFlight !== null;
  }

  requestClose(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;

    const operation = Promise.resolve()
      .then(() => this.confirmClose())
      .then((accepted) => (accepted ? this.finalizeClose() : false))
      .catch((error: unknown) => {
        try {
          this.reportFailure(error);
        } catch {
          // A failed diagnostic must not become an unhandled main-process error.
        }
        return false;
      });

    let shared: Promise<boolean>;
    shared = operation.finally(() => {
      if (this.inFlight === shared) this.inFlight = null;
    });
    this.inFlight = shared;
    return shared;
  }
}

export type ReloadShortcutInput = {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
};

export type VoiceOwnershipState = {
  active: boolean;
  hasSession: boolean;
  hasUnsavedSession: boolean;
};

export type RendererSettingsPatch = {
  defaultVoice?: string;
  clearApiKey?: boolean;
};

/** The ordinary renderer may change preferences or clear, but never submit a secret. */
export function sanitizeRendererSettingsPatch(value: unknown): RendererSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid settings update.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "defaultVoice" && key !== "clearApiKey")) {
    throw new Error("Invalid settings update.");
  }
  const patch: RendererSettingsPatch = {};
  if (record.defaultVoice !== undefined) {
    if (typeof record.defaultVoice !== "string") throw new Error("Invalid default voice.");
    patch.defaultVoice = record.defaultVoice;
  }
  if (record.clearApiKey !== undefined) {
    if (typeof record.clearApiKey !== "boolean") throw new Error("Invalid key action.");
    patch.clearApiKey = record.clearApiKey;
  }
  return patch;
}

/** Live, connecting, and retained sessions all remain owned by the main process. */
export function hasVoiceSessionOwnership(state: VoiceOwnershipState): boolean {
  return state.active || state.hasSession || state.hasUnsavedSession;
}

/** Block Electron's standard reload accelerators only while main owns an exam. */
export function shouldBlockReloadShortcut(
  input: ReloadShortcutInput,
  hasVoiceOwnership: boolean
): boolean {
  if (!hasVoiceOwnership || input.type !== "keyDown") return false;
  const key = input.key.toLowerCase();
  return key === "f5" || (key === "r" && (input.control || input.meta));
}

/** Claim the Electron singleton before any window, IPC, or workspace setup. */
export function claimSingleInstance(
  requestLock: () => boolean,
  exitSecondary: () => void
): boolean {
  if (requestLock()) return true;
  exitSecondary();
  return false;
}

export type FocusableWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
};

/** Bring the primary window forward when the user launches the app again. */
export function focusExistingWindow(win: FocusableWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false;
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return true;
  } catch {
    // The native window may have been destroyed between the checks above.
    return false;
  }
}

export function isTrustedApplicationUrl(
  url: string,
  devServerUrl: string | undefined,
  packagedIndexPathOrUrl: string
): boolean {
  if (!url) return false;
  if (devServerUrl) {
    try {
      const actual = new URL(url);
      const expected = new URL(devServerUrl);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    } catch {
      return false;
    }
  }

  if (packagedIndexPathOrUrl.startsWith("app:")) {
    try {
      const actual = new URL(url);
      const expected = new URL(packagedIndexPathOrUrl);
      return (
        isPackagedApplicationOrigin(url) &&
        actual.pathname === expected.pathname &&
        actual.search === "" &&
        actual.hash === ""
      );
    } catch {
      return false;
    }
  }

  // Retained for callers/tests that validate migration from the former file://
  // renderer. Production now uses the least-privilege app:// protocol.
  if (!url.startsWith("file:")) return false;
  try {
    return path.normalize(fileURLToPath(url)) === path.normalize(packagedIndexPathOrUrl);
  } catch {
    return false;
  }
}

type MediaAccessCandidate = {
  permission: string;
  isMainWindow: boolean;
  isMainFrame: boolean;
  currentUrlTrusted: boolean;
  requestingUrlTrusted: boolean;
  mediaType?: string;
  mediaTypes?: readonly string[];
};

/** Fail closed unless the trusted main frame requests audio and audio only. */
export function shouldAllowAudioMedia(candidate: MediaAccessCandidate): boolean {
  if (
    candidate.permission !== "media" ||
    !candidate.isMainWindow ||
    !candidate.isMainFrame ||
    !candidate.currentUrlTrusted ||
    !candidate.requestingUrlTrusted
  ) {
    return false;
  }

  const hasSingleType = candidate.mediaType !== undefined;
  const hasTypeList = candidate.mediaTypes !== undefined;
  if (!hasSingleType && !hasTypeList) return false;
  if (hasSingleType && candidate.mediaType !== "audio") return false;
  if (
    hasTypeList &&
    (!candidate.mediaTypes?.length || candidate.mediaTypes.some((type) => type !== "audio"))
  ) {
    return false;
  }
  return true;
}
