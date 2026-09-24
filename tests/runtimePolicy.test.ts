import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AsyncCloseConfirmationCoordinator,
  claimSingleInstance,
  focusExistingWindow,
  hasVoiceSessionOwnership,
  isPackagedApplicationOrigin,
  isTrustedApplicationUrl,
  PACKAGED_APP_URL,
  resolveDevelopmentServerUrl,
  resolvePackagedAssetPath,
  sanitizeRendererSettingsPatch,
  SaveBeforeQuitCoordinator,
  shouldAllowAudioMedia,
  shouldBlockReloadShortcut,
} from "../electron/runtimePolicy";

describe("SaveBeforeQuitCoordinator", () => {
  it("quits only after the live session was saved", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();
    const reportFailure = vi.fn();
    const coordinator = new SaveBeforeQuitCoordinator(stop, quit, reportFailure);

    await expect(coordinator.finalize()).resolves.toBe(true);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(coordinator.isCommittedToQuit()).toBe(true);
  });

  it("stays open after a save failure and allows a later retry", async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const quit = vi.fn();
    const reportFailure = vi.fn();
    const coordinator = new SaveBeforeQuitCoordinator(stop, quit, reportFailure);

    await expect(coordinator.finalize()).resolves.toBe(false);
    expect(quit).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "disk full" }));
    expect(coordinator.isCommittedToQuit()).toBe(false);

    await expect(coordinator.finalize()).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("shares one finalization across concurrent close and before-quit events", async () => {
    let finishSave: (() => void) | undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    const quit = vi.fn();
    const coordinator = new SaveBeforeQuitCoordinator(stop, quit, vi.fn());

    const first = coordinator.finalize();
    const second = coordinator.finalize();
    expect(second).toBe(first);
    expect(stop).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    finishSave?.();
    await expect(first).resolves.toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("does not leak a rejection when error reporting itself fails", async () => {
    const coordinator = new SaveBeforeQuitCoordinator(
      () => Promise.reject(new Error("write failed")),
      vi.fn(),
      () => {
        throw new Error("dialog failed");
      }
    );

    await expect(coordinator.finalize()).resolves.toBe(false);
  });
});

describe("AsyncCloseConfirmationCoordinator", () => {
  it("shares one prompt and invokes the finalizer once after acceptance", async () => {
    let resolvePrompt: ((accepted: boolean) => void) | undefined;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePrompt = resolve;
        })
    );
    const finalize = vi.fn().mockResolvedValue(true);
    const coordinator = new AsyncCloseConfirmationCoordinator(confirm, finalize);

    const first = coordinator.requestClose();
    const repeated = coordinator.requestClose();
    expect(repeated).toBe(first);
    expect(coordinator.hasPendingRequest()).toBe(true);

    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);
    resolvePrompt?.(true);
    await expect(first).resolves.toBe(true);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(coordinator.hasPendingRequest()).toBe(false);
  });

  it("releases prompt ownership after cancellation or rejection without finalizing", async () => {
    const confirm = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("native dialog failed"))
      .mockResolvedValueOnce(true);
    const finalize = vi.fn().mockResolvedValue(true);
    const reportFailure = vi.fn();
    const coordinator = new AsyncCloseConfirmationCoordinator(
      confirm,
      finalize,
      reportFailure
    );

    await expect(coordinator.requestClose()).resolves.toBe(false);
    expect(coordinator.hasPendingRequest()).toBe(false);
    await expect(coordinator.requestClose()).resolves.toBe(false);
    expect(coordinator.hasPendingRequest()).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "native dialog failed" })
    );

    await expect(coordinator.requestClose()).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

describe("reload shortcut policy", () => {
  const keyDown = {
    type: "keyDown",
    key: "r",
    control: false,
    meta: false,
  };

  it("blocks Ctrl/Cmd+R and F5 while a live or retained session is owned", () => {
    expect(shouldBlockReloadShortcut({ ...keyDown, control: true }, true)).toBe(true);
    expect(shouldBlockReloadShortcut({ ...keyDown, key: "R", meta: true }, true)).toBe(true);
    expect(shouldBlockReloadShortcut({ ...keyDown, key: "F5" }, true)).toBe(true);
  });

  it("treats active, retained, or unsaved state as main-process ownership", () => {
    const idle = { active: false, hasSession: false, hasUnsavedSession: false };
    expect(hasVoiceSessionOwnership(idle)).toBe(false);
    expect(hasVoiceSessionOwnership({ ...idle, active: true })).toBe(true);
    expect(hasVoiceSessionOwnership({ ...idle, hasSession: true })).toBe(true);
    expect(hasVoiceSessionOwnership({ ...idle, hasUnsavedSession: true })).toBe(true);
  });

  it("allows reload keys without session ownership and ignores unrelated input", () => {
    expect(shouldBlockReloadShortcut({ ...keyDown, control: true }, false)).toBe(false);
    expect(shouldBlockReloadShortcut({ ...keyDown, key: "F5" }, false)).toBe(false);
    expect(shouldBlockReloadShortcut(keyDown, true)).toBe(false);
    expect(
      shouldBlockReloadShortcut({ ...keyDown, type: "keyUp", control: true }, true)
    ).toBe(false);
    expect(
      shouldBlockReloadShortcut({ ...keyDown, key: "p", control: true }, true)
    ).toBe(false);
  });
});

describe("single-instance policy", () => {
  it("exits a denied secondary instance before initialization", () => {
    const exitSecondary = vi.fn();
    expect(claimSingleInstance(() => false, exitSecondary)).toBe(false);
    expect(exitSecondary).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary instance and restores its window", () => {
    const exitSecondary = vi.fn();
    expect(claimSingleInstance(() => true, exitSecondary)).toBe(true);
    expect(exitSecondary).not.toHaveBeenCalled();

    const win = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      focus: vi.fn(),
    };
    expect(focusExistingWindow(win)).toBe(true);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("does not touch a destroyed primary window", () => {
    const win = {
      isDestroyed: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      focus: vi.fn(),
    };
    expect(focusExistingWindow(win)).toBe(false);
    expect(win.focus).not.toHaveBeenCalled();
  });
});

describe("trusted application and microphone policy", () => {
  const packagedIndex = path.resolve("dist", "index.html");

  it("accepts only the exact development or packaged document", () => {
    const dev = "http://127.0.0.1:5173/app/";
    expect(isTrustedApplicationUrl("http://127.0.0.1:5173/app/?hmr=1", dev, packagedIndex)).toBe(
      true
    );
    expect(isTrustedApplicationUrl("http://127.0.0.1:5173/other", dev, packagedIndex)).toBe(
      false
    );
    expect(isTrustedApplicationUrl("http://127.0.0.1:51730/app/", dev, packagedIndex)).toBe(
      false
    );

    const exactFileUrl = pathToFileURL(packagedIndex).href;
    const siblingFileUrl = pathToFileURL(path.join(path.dirname(packagedIndex), "other.html")).href;
    expect(isTrustedApplicationUrl(exactFileUrl, undefined, packagedIndex)).toBe(true);
    expect(isTrustedApplicationUrl(siblingFileUrl, undefined, packagedIndex)).toBe(false);

    expect(isTrustedApplicationUrl(PACKAGED_APP_URL, undefined, PACKAGED_APP_URL)).toBe(true);
    expect(
      isTrustedApplicationUrl("app://bundle/other.html", undefined, PACKAGED_APP_URL)
    ).toBe(false);
    expect(
      isTrustedApplicationUrl("app://other/index.html", undefined, PACKAGED_APP_URL)
    ).toBe(false);
  });

  it("enables development rendering only for unpackaged loopback servers", () => {
    expect(
      resolveDevelopmentServerUrl({ candidate: "http://127.0.0.1:5173/", isPackaged: false })
    ).toBe("http://127.0.0.1:5173/");
    expect(
      resolveDevelopmentServerUrl({ candidate: "https://localhost:5173/app/", isPackaged: false })
    ).toBe("https://localhost:5173/app/");
    expect(
      resolveDevelopmentServerUrl({ candidate: "http://[::1]:5173/", isPackaged: false })
    ).toBe("http://[::1]:5173/");
    expect(
      resolveDevelopmentServerUrl({ candidate: "http://127.0.0.1:5173/", isPackaged: true })
    ).toBeUndefined();
    expect(
      resolveDevelopmentServerUrl({ candidate: "https://example.com/", isPackaged: false })
    ).toBeUndefined();
    expect(
      resolveDevelopmentServerUrl({
        candidate: "http://user@localhost:5173/",
        isPackaged: false,
      })
    ).toBeUndefined();
  });

  it("keeps packaged assets inside the renderer root", () => {
    const root = path.resolve("dist");
    expect(isPackagedApplicationOrigin("app://bundle/assets/app.js")).toBe(true);
    expect(isPackagedApplicationOrigin("app://attacker/assets/app.js")).toBe(false);
    expect(resolvePackagedAssetPath("app://bundle/index.html", root)).toBe(
      path.join(root, "index.html")
    );
    expect(resolvePackagedAssetPath("app://bundle/assets/app.js?v=1", root)).toBe(
      path.join(root, "assets", "app.js")
    );
    expect(resolvePackagedAssetPath("app://attacker/index.html", root)).toBeUndefined();
    expect(
      resolvePackagedAssetPath("app://bundle/%2e%2e%5cpackage.json", root)
    ).toBeUndefined();
  });

  it("allows declared audio only from the trusted main frame", () => {
    const valid = {
      permission: "media",
      isMainWindow: true,
      isMainFrame: true,
      currentUrlTrusted: true,
      requestingUrlTrusted: true,
      mediaTypes: ["audio"],
    };
    expect(shouldAllowAudioMedia(valid)).toBe(true);
    expect(shouldAllowAudioMedia({ ...valid, isMainFrame: false })).toBe(false);
    expect(shouldAllowAudioMedia({ ...valid, requestingUrlTrusted: false })).toBe(false);
    expect(shouldAllowAudioMedia({ ...valid, mediaTypes: ["audio", "video"] })).toBe(false);
    expect(shouldAllowAudioMedia({ ...valid, mediaTypes: [] })).toBe(false);
    expect(shouldAllowAudioMedia({ ...valid, permission: "mediaKeySystem" })).toBe(false);
  });

  it("supports Electron's singular mediaType check without granting omissions", () => {
    const base = {
      permission: "media",
      isMainWindow: true,
      isMainFrame: true,
      currentUrlTrusted: true,
      requestingUrlTrusted: true,
    };
    expect(shouldAllowAudioMedia({ ...base, mediaType: "audio" })).toBe(true);
    expect(shouldAllowAudioMedia({ ...base, mediaType: "video" })).toBe(false);
    expect(shouldAllowAudioMedia(base)).toBe(false);
  });
});

describe("renderer settings boundary", () => {
  it("allows only non-secret settings fields", () => {
    expect(
      sanitizeRendererSettingsPatch({ defaultVoice: "eve", clearApiKey: true })
    ).toEqual({ defaultVoice: "eve", clearApiKey: true });
    expect(() =>
      sanitizeRendererSettingsPatch({ xaiApiKey: "must-not-cross-renderer" })
    ).toThrow("Invalid settings update");
    expect(() => sanitizeRendererSettingsPatch({ defaultVoice: 1 })).toThrow(
      "Invalid default voice"
    );
    expect(() => sanitizeRendererSettingsPatch(null)).toThrow("Invalid settings update");
  });
});
