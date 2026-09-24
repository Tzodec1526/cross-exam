import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  systemPreferences,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cancelReindex,
  discardIndex,
} from "./services/indexer.js";
import {
  createMatter,
  deleteMatter,
  deletePersona,
  getMatter,
  ImportRollbackUncertainError,
  listMatters,
  listPersonas,
  restoreMatterMeta,
  savePersona,
  updateMatter,
} from "./services/matters.js";
import {
  deleteIndexedDocument,
  DocumentRollbackUncertainError,
  DocumentMutationCoordinator,
  importMatterDocuments,
  listPublicDocuments,
  reindexPublicDocuments,
} from "./services/documents.js";
import { exportMatterZip } from "./services/export.js";
import { getPublicSettings, saveSettings } from "./services/settings.js";
import { publicErrorMessage } from "./services/fsutil.js";
import {
  deleteSession,
  generateSavedSessionReport,
  getSessionReview,
  listSessions,
  resolveSessionArtifact,
  restoreSession,
} from "./services/report.js";
import { voiceSessions } from "./services/voiceSession.js";
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
} from "./runtimePolicy.js";
import type { ExamMode } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stable identity for safeStorage (DPAPI / keychain) across launches
app.setName("cross-examination");

// Registration must happen before app.ready. The custom standard scheme keeps
// production renderer files away from file:// and its legacy extra privileges.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      codeCache: true,
    },
  },
]);

const developmentServerUrl = resolveDevelopmentServerUrl({
  candidate: process.env.VITE_DEV_SERVER_URL,
  isPackaged: app.isPackaged,
});
const smokeTestMode = process.argv.includes("--smoke-test");
if (smokeTestMode) {
  // Chromium's --user-data-dir switch does not remap Electron's userData path.
  // Honor it explicitly (smoke only) so packaged QA runs are isolated from the
  // real profile: no diagnostics writes, no shared single-instance lock.
  const userDataArg = process.argv.find((arg) => arg.startsWith("--user-data-dir="));
  const smokeUserData = userDataArg?.slice("--user-data-dir=".length);
  if (smokeUserData) app.setPath("userData", path.resolve(smokeUserData));
}
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function diagnosticsDirectory(): string {
  return path.join(app.getPath("userData"), "diagnostics");
}

function recordDiagnostic(event: string, detail = ""): void {
  try {
    const directory = diagnosticsDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const logPath = path.join(directory, "events.jsonl");
    const existingSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    if (existingSize > 1024 * 1024) {
      const previous = `${logPath}.previous`;
      try {
        fs.rmSync(previous, { force: true });
        fs.renameSync(logPath, previous);
      } catch {
        // Diagnostics must never interfere with the app's primary workflow.
      }
    }
    const safeEvent = event.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100);
    const safeDetail = detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000);
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), event: safeEvent, detail: safeDetail })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {
    // A read-only/full profile must remain usable even without diagnostics.
  }
}

function initializeCrashDiagnostics(): void {
  const crashDirectory = path.join(diagnosticsDirectory(), "crashes");
  fs.mkdirSync(crashDirectory, { recursive: true, mode: 0o700 });
  app.setPath("crashDumps", crashDirectory);
  crashReporter.start({
    productName: "Cross Examination",
    uploadToServer: false,
    compress: true,
    globalExtra: { release: app.getVersion() },
  });
  recordDiagnostic("app.start", `version=${app.getVersion()} packaged=${String(app.isPackaged)}`);
}

process.on("uncaughtExceptionMonitor", (error) => {
  recordDiagnostic("main.uncaughtException", error.stack ?? error.message);
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertMatterId(matterId: unknown): string {
  if (typeof matterId !== "string" || !UUID_RE.test(matterId)) {
    throw new Error("Invalid matter id");
  }
  return matterId;
}

function assertPersonaId(personaId: unknown): string {
  if (typeof personaId !== "string" || !UUID_RE.test(personaId)) {
    throw new Error("Invalid persona id");
  }
  return personaId;
}

function assertSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    throw new Error("Invalid session id");
  }
  return sessionId;
}

function assertDocumentId(documentId: unknown): string {
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) {
    throw new Error("Invalid document id");
  }
  return documentId;
}

function publicIpcError(error: unknown): never {
  throw new Error(publicErrorMessage(error));
}

let mainWindow: BrowserWindow | null = null;
const documentMutations = new DocumentMutationCoordinator();

// Claim the shared user-data/workspace owner before registering IPC or opening
// a window. All write coordination is process-local, so a second instance must
// never operate on the same matter tree.
const ownsSingleInstance = claimSingleInstance(
  () => app.requestSingleInstanceLock(),
  () => {
    // A smoke run that lost the lock proved nothing about the renderer. Exit
    // nonzero so the packaging gate cannot report a false pass (app.quit()
    // would exit 0).
    if (smokeTestMode) app.exit(3);
    else app.quit();
  }
);

function resolvePreload(): string {
  // Prefer .cjs (CJS under "type":"module"); fall back to older names
  for (const name of ["preload.cjs", "preload.js", "preload.mjs"]) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, "preload.cjs");
}

function resolveIcon(): string | undefined {
  for (const candidate of [
    path.join(__dirname, "../public/logo.jpg"),
    path.join(__dirname, "../dist/logo.jpg"),
    path.join(app.getAppPath(), "public", "logo.jpg"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function installPackagedApplicationProtocol(): void {
  const rendererRoot = path.join(__dirname, "../dist");
  protocol.handle("app", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const assetPath = resolvePackagedAssetPath(request.url, rendererRoot);
    if (!assetPath) return new Response("Not found", { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(assetPath).href);
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", PRODUCTION_CSP);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Permissions-Policy", "camera=(), geolocation=(), display-capture=(), microphone=(self)");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error("[main] packaged asset load failed", error);
      return new Response("Not found", { status: 404 });
    }
  });
}

async function verifySmokeRenderer(win: BrowserWindow): Promise<void> {
  const ready = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        const root = document.getElementById("root");
        if (window.api && root && root.childElementCount > 0) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(check, 50);
      };
      check();
    })
  `);
  if (ready !== true) throw new Error("renderer or preload did not become ready");
}

function createWindow() {
  const preloadPath = resolvePreload();
  console.log("[main] preload:", preloadPath);

  const iconPath = resolveIcon();
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#040607",
    title: "Cross Examination",
    icon: iconPath,
    show: !smokeTestMode,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  voiceSessions.setWindow(mainWindow);

  // Accidental close during a live exam: prevent synchronously while the native
  // confirmation runs asynchronously, keeping WebSocket/checkpoint work alive.
  mainWindow.on("close", (event) => {
    if (quitCoordinator.isCommittedToQuit()) return;
    const needsConfirmation =
      voiceSessions.isActive() || voiceSessions.hasUnsavedSession();
    if (!needsConfirmation && !closeConfirmationCoordinator.hasPendingRequest()) return;
    event.preventDefault();
    void closeConfirmationCoordinator.requestClose();
  });

  // Windows shutdown/logoff may skip app.before-quit. stop(false) performs its
  // transcript writes synchronously before its resolved promise is returned.
  mainWindow.on("query-session-end", (event) => {
    if (!voiceSessions.isActive() && !voiceSessions.hasUnsavedSession()) return;
    event.preventDefault();
    // Windows gives us a chance to delay shutdown. Use the same retry-safe
    // finalizer as every other quit path; a failed save must not force exit.
    void finalizeUserRequestedQuit();
  });
  mainWindow.on("session-end", () => {
    if (voiceSessions.isActive() || voiceSessions.hasUnsavedSession()) {
      // The OS is already ending the session, so this is best effort only. The
      // terminal catch prevents a write failure becoming an unhandled rejection.
      void voiceSessions
        .stop(false)
        .catch((err) => console.error("[main] final session-end save failed", err));
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    recordDiagnostic(
      "renderer.gone",
      `reason=${details.reason} exitCode=${String(details.exitCode)}`
    );
    if (!voiceSessions.isActive() && !voiceSessions.hasUnsavedSession()) return;
    console.error("[main] renderer exited during an exam", details.reason);
    void voiceSessions
      .stop(false)
      .catch((err) => console.error("[main] emergency transcript save failed", err));
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const ownsVoiceSession = hasVoiceSessionOwnership(voiceSessions.getStateSnapshot());
    if (shouldBlockReloadShortcut(input, ownsVoiceSession)) event.preventDefault();
  });

  // Harden navigation / popups — preload bridge must not follow off-app URLs
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });

  mainWindow.webContents.on("preload-error", (_event, preload, err) => {
    recordDiagnostic("renderer.preloadError", `${path.basename(preload)}: ${err.message}`);
    console.error("[main] preload-error", preload, err);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    recordDiagnostic("renderer.loadFailed", `code=${String(code)} ${desc} ${url}`);
    console.error("[main] did-fail-load", code, desc, url);
  });
  mainWindow.webContents.on("console-message", (event) => {
    const { level, message, lineNumber, sourceId } = event;
    if (level === "warning" || level === "error") {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
    }
  });

  const uiLoad = developmentServerUrl
    ? mainWindow.loadURL(developmentServerUrl)
    : mainWindow.loadURL(PACKAGED_APP_URL);

  void uiLoad
    .then(async () => {
      if (smokeTestMode) {
        await verifySmokeRenderer(mainWindow!);
        console.log(`[smoke] renderer loaded from ${developmentServerUrl ?? PACKAGED_APP_URL}`);
        app.exit(0);
      }
    })
    .catch((err) => {
      console.error(
        developmentServerUrl
          ? "[main] could not load the development UI"
          : "[main] could not load the packaged UI",
        err
      );
      if (smokeTestMode) app.exit(1);
    });

  if (developmentServerUrl) {
    // DevTools only when explicitly requested
    if (process.env.CROSS_EXAM_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }
}

const quitCoordinator = new SaveBeforeQuitCoordinator(
  () => voiceSessions.stop(false),
  () => app.quit(),
  (err) => {
    console.error("[main] could not save transcript before quit", err);
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      dialog.showErrorBox(
        "Could not save the live exam",
        `The app stayed open so the transcript is not discarded. Try End only again.\n\n${String(err)}`
      );
    }
  }
);

function finalizeUserRequestedQuit(): Promise<boolean> {
  return quitCoordinator.finalize();
}

const closeConfirmationCoordinator = new AsyncCloseConfirmationCoordinator(
  async () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    const result = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Keep exam open", "End exam and quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Exam in progress",
      message: "A live exam is still in progress.",
      detail:
        "Closing now will end the session and save the transcript (without generating a report). Continue?",
    });
    return result.response === 1;
  },
  finalizeUserRequestedQuit,
  (err) => console.error("[main] live-close confirmation failed", err)
);

type MainFrameIpcEvent = {
  sender: Electron.WebContents;
  senderFrame: Electron.WebFrameMain | null;
};

function isIpcFromMainWindow(e: MainFrameIpcEvent): boolean {
  return Boolean(
    isMainWindowContents(e.sender) &&
      e.senderFrame &&
      e.senderFrame === e.sender.mainFrame &&
      isTrustedAppUrl(e.senderFrame.url)
  );
}

/** Reject IPC from any webContents other than the trusted app main frame. */
function assertIpcFromMainWindow(e: MainFrameIpcEvent): void {
  if (!isIpcFromMainWindow(e)) {
    throw new Error("IPC denied: not the trusted main application frame");
  }
}

function registerIpc() {
  ipcMain.handle("app:getInfo", (e) => {
    assertIpcFromMainWindow(e);
    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle("app:openDiagnostics", async (e) => {
    assertIpcFromMainWindow(e);
    const directory = diagnosticsDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const result = await shell.openPath(directory);
    if (result) throw new Error("Could not open the diagnostics folder.");
    return { opened: true };
  });
  ipcMain.handle("settings:get", (e) => {
    assertIpcFromMainWindow(e);
    return getPublicSettings();
  });
  ipcMain.handle("settings:importApiKeyFromClipboard", async (e) => {
    assertIpcFromMainWindow(e);
    const win = mainWindow;
    if (!win || win.isDestroyed()) throw new Error("The application window is unavailable.");
    const confirmation = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Import clipboard key"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Import xAI API key",
      message: "Import the current clipboard text as your xAI API key?",
      detail:
        "The key stays in the main process, is encrypted with OS secure storage, and is never exposed to this page. After a successful import, the matching clipboard text will be cleared.",
    });
    if (confirmation.response !== 1) {
      return { imported: false, settings: getPublicSettings() };
    }

    const key = clipboard.readText("clipboard").trim();
    if (!key) throw new Error("The clipboard does not contain an API key.");
    try {
      saveSettings({ xaiApiKey: key });
      if (clipboard.readText("clipboard").trim() === key) clipboard.clear("clipboard");
      return { imported: true, settings: getPublicSettings() };
    } catch (error) {
      return publicIpcError(error);
    }
  });
  ipcMain.handle(
    "settings:save",
    (
      e,
      patch: { defaultVoice?: string; clearApiKey?: boolean }
    ) => {
      assertIpcFromMainWindow(e);
      try {
        saveSettings(sanitizeRendererSettingsPatch(patch));
        return getPublicSettings();
      } catch (err) {
        return publicIpcError(err);
      }
    }
  );

  ipcMain.handle("matters:list", (e) => {
    assertIpcFromMainWindow(e);
    try {
      return listMatters();
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("matters:create", (e, input: { caption: string; court?: string; notes?: string }) => {
    assertIpcFromMainWindow(e);
    try {
      return createMatter(input);
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("matters:get", (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return getMatter(assertMatterId(matterId));
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle(
    "matters:update",
    (e, matterId: string, patch: { caption?: string; court?: string; notes?: string }) => {
      assertIpcFromMainWindow(e);
      try {
        return updateMatter(assertMatterId(matterId), patch ?? {});
      } catch (err) {
        return publicIpcError(err);
      }
    }
  );
  ipcMain.handle("matters:delete", async (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      if (voiceSessions.isActive() || voiceSessions.hasSession()) {
        throw new Error("End the live exam before deleting a matter.");
      }
      const id = assertMatterId(matterId);
      // Same queue as import and reindex so a rebuild cannot publish an index
      // after this delete has discarded it.
      return await documentMutations.run(id, () => {
        discardIndex(id);
        return deleteMatter(id);
      });
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("matters:export", async (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      const id = assertMatterId(matterId);
      const matter = getMatter(id);
      if (!matter) throw new Error("Matter not found");
      const result = await dialog.showSaveDialog({
        title: "Export matter",
        defaultPath: `${matter.caption.replace(/[^\w.-]+/g, "_") || "matter"}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (result.canceled || !result.filePath) return null;
      return await exportMatterZip(id, result.filePath);
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("matters:restoreMeta", (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return restoreMatterMeta(assertMatterId(matterId));
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle("personas:list", (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return listPersonas(assertMatterId(matterId));
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle(
    "personas:save",
    (
      e,
      matterId: string,
      input: {
        id?: string;
        fullName: string;
        role: string;
        attitude: "hostile" | "evasive" | "cooperative" | "neutral" | "expert";
        notes: string;
        keyterms: string[];
        voice: string;
      }
    ) => {
      assertIpcFromMainWindow(e);
      try {
        return savePersona(assertMatterId(matterId), input);
      } catch (err) {
        return publicIpcError(err);
      }
    }
  );
  ipcMain.handle("personas:delete", (e, matterId: string, personaId: string) => {
    assertIpcFromMainWindow(e);
    try {
      deletePersona(assertMatterId(matterId), assertPersonaId(personaId));
      return true;
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle("docs:pickAndImport", async (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      const id = assertMatterId(matterId);
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error("Main window is not available");
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Import case documents",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Case files", extensions: ["pdf", "docx", "txt", "md", "csv", "json", "html"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { imported: [], needsReindex: false };
      }
      const imported = await documentMutations.run(id, () =>
        importMatterDocuments(id, result.filePaths)
      );
      // importFiles copies sources in order, one destination name per source.
      // Report exactly which files landed under a different name (collision
      // suffix or sanitization) instead of letting the renderer guess from
      // name shape.
      const renamed = imported.filter(
        (name, index) => name !== path.basename(result.filePaths[index] ?? "")
      );
      return { imported, renamed, needsReindex: imported.length > 0 };
    } catch (err) {
      if (err instanceof ImportRollbackUncertainError) {
        return {
          imported: [],
          renamed: [],
          needsReindex: true,
          error: publicErrorMessage(err),
        };
      }
      return publicIpcError(err);
    }
  });

  ipcMain.handle("docs:reindex", async (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      const id = assertMatterId(matterId);
      // Returns bounded public metadata + counts only (never paths or chunk text).
      return await documentMutations.run(id, () => reindexPublicDocuments(id));
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("docs:cancelReindex", (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    const id = assertMatterId(matterId);
    cancelReindex(id);
    return { cancelled: id };
  });
  ipcMain.handle("docs:list", (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return listPublicDocuments(assertMatterId(matterId));
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("docs:delete", async (e, matterId: string, documentId: string) => {
    assertIpcFromMainWindow(e);
    try {
      const id = assertMatterId(matterId);
      const validDocumentId = assertDocumentId(documentId);
      return await documentMutations.run(id, () =>
        deleteIndexedDocument(id, validDocumentId)
      );
    } catch (err) {
      if (err instanceof DocumentRollbackUncertainError) {
        return {
          deleted: null,
          needsReindex: true,
          error: publicErrorMessage(err),
        };
      }
      return publicIpcError(err);
    }
  });
  ipcMain.handle("sessions:list", (e, matterId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return listSessions(assertMatterId(matterId));
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle("sessions:get", (e, matterId: string, sessionId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return getSessionReview(assertMatterId(matterId), assertSessionId(sessionId));
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle("sessions:generateReport", async (e, matterId: string, sessionId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return await generateSavedSessionReport(
        assertMatterId(matterId),
        assertSessionId(sessionId)
      );
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle("sessions:restore", (e, matterId: string, sessionId: string) => {
    assertIpcFromMainWindow(e);
    try {
      return restoreSession(assertMatterId(matterId), assertSessionId(sessionId));
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle("sessions:delete", (e, matterId: string, sessionId: string) => {
    assertIpcFromMainWindow(e);
    try {
      const validMatterId = assertMatterId(matterId);
      const validSessionId = assertSessionId(sessionId);
      if (hasVoiceSessionOwnership(voiceSessions.getStateSnapshot())) {
        throw new Error("End and save the current exam before deleting a saved session.");
      }
      return deleteSession(validMatterId, validSessionId);
    } catch (err) {
      return publicIpcError(err);
    }
  });

  ipcMain.handle(
    "sessions:openArtifact",
    async (e, matterId: string, sessionId: string, kind: "transcript" | "report") => {
      assertIpcFromMainWindow(e);
      try {
        const safe = resolveSessionArtifact(
          assertMatterId(matterId),
          assertSessionId(sessionId),
          kind
        );
        const result = await shell.openPath(safe);
        return result ? publicErrorMessage(result) : "";
      } catch (err) {
        return publicIpcError(err);
      }
    }
  );

  ipcMain.handle(
    "voice:start",
    async (
      e,
      setup: { matterId: string; personaId: string; mode: ExamMode; voice?: string }
    ) => {
      assertIpcFromMainWindow(e);
      const mode = setup?.mode;
      if (mode !== "cross" && mode !== "deposition" && mode !== "hearing") {
        throw new Error("Invalid exam mode");
      }
      const voice =
        typeof setup.voice === "string" && setup.voice.trim()
          ? setup.voice.trim().slice(0, 80)
          : undefined;
      try {
        const session = await voiceSessions.start({
          matterId: assertMatterId(setup.matterId),
          personaId: assertPersonaId(setup.personaId),
          mode,
          voice,
        });
        return { id: session.id, matterId: session.matterId };
      } catch (err) {
        return publicIpcError(err);
      }
    }
  );
  ipcMain.handle("voice:stop", async (e, generateReport: boolean) => {
    assertIpcFromMainWindow(e);
    try {
      return await voiceSessions.stop(generateReport);
    } catch (err) {
      return publicIpcError(err);
    }
  });
  ipcMain.handle("voice:getState", (e) => {
    assertIpcFromMainWindow(e);
    return voiceSessions.getStateSnapshot();
  });
  ipcMain.on("voice:audio-in", (e, base64Pcm: string) => {
    // Event-style IPC has no rejected invoke promise to contain an exception,
    // so silently drop untrusted subframe/navigation traffic.
    if (!isIpcFromMainWindow(e)) return;
    voiceSessions.appendAudio(base64Pcm);
  });

}

/** Only the main BrowserWindow may request media — not arbitrary webContents. */
function isMainWindowContents(wc: Electron.WebContents | null | undefined): boolean {
  return Boolean(
    wc && mainWindow && !mainWindow.isDestroyed() && wc.id === mainWindow.webContents.id
  );
}

/**
 * Exact origin allowlist:
 * - Dev: exact origin and document path of VITE_DEV_SERVER_URL
 * - Packaged: the built dist/index.html document only
 */
function isTrustedAppUrl(url: string): boolean {
  return isTrustedApplicationUrl(url, developmentServerUrl, PACKAGED_APP_URL);
}

function isTrustedMediaOrigin(origin: string | undefined, requestingUrl: string): boolean {
  const candidate = origin || requestingUrl;
  const dev = developmentServerUrl;
  if (dev) {
    try {
      return new URL(candidate).origin === new URL(dev).origin;
    } catch {
      return false;
    }
  }
  return isPackagedApplicationOrigin(candidate);
}

function allowMediaPermissions() {
  // Microphone only, trusted main frame only — never subframes, camera, or
  // mediaKeySystem. Every omitted detail fails closed.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaDetails = details as Electron.MediaAccessPermissionRequest;
    const currentUrl = wc.getURL() || "";
    const requestingUrl = mediaDetails.requestingUrl || "";
    callback(
      isTrustedMediaOrigin(mediaDetails.securityOrigin, requestingUrl) &&
        shouldAllowAudioMedia({
          permission,
          isMainWindow: isMainWindowContents(wc),
          isMainFrame: mediaDetails.isMainFrame === true,
          currentUrlTrusted: isTrustedAppUrl(currentUrl),
          requestingUrlTrusted: isTrustedAppUrl(requestingUrl),
          mediaTypes: mediaDetails.mediaTypes,
        })
    );
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const mediaDetails = details as Electron.PermissionCheckHandlerHandlerDetails & {
      mediaTypes?: string[];
    };
    const currentUrl = wc?.getURL() || "";
    // Electron provides requestingUrl for the main frame and documents its
    // omission for cross-origin subframes. Those frames are denied below, so an
    // unexpected omission here must also fail closed rather than use currentUrl.
    const requestingUrl = mediaDetails.requestingUrl || "";
    return (
      isTrustedMediaOrigin(requestingOrigin || mediaDetails.securityOrigin, requestingUrl) &&
      shouldAllowAudioMedia({
        permission,
        isMainWindow: isMainWindowContents(wc ?? undefined),
        isMainFrame: mediaDetails.isMainFrame === true,
        currentUrlTrusted: isTrustedAppUrl(currentUrl),
        requestingUrlTrusted: isTrustedAppUrl(requestingUrl),
        mediaType: mediaDetails.mediaType,
        mediaTypes: mediaDetails.mediaTypes,
      })
    );
  });
}

/**
 * Apply CSP as a response header (covers the whole document).
 * Meta CSP only governs elements after the meta tag — Vite's HMR preamble
 * injects before it in dev, so we skip header injection when the dev server is up.
 * Packaged/prod: no sockets needed in the renderer (xAI lives in main).
 */
function applyContentSecurityPolicy() {
  if (developmentServerUrl) {
    // Dev: rely on index.html meta (relaxed for localhost HMR). Header would fight Vite.
    return;
  }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers["Content-Security-Policy"] = [PRODUCTION_CSP];
    headers["Cross-Origin-Opener-Policy"] = ["same-origin"];
    headers["Permissions-Policy"] = [
      "camera=(), geolocation=(), display-capture=(), microphone=(self)",
    ];
    headers["Referrer-Policy"] = ["no-referrer"];
    headers["X-Content-Type-Options"] = ["nosniff"];
    callback({ responseHeaders: headers });
  });
}

function startPrimaryInstance(): void {
  app.on("second-instance", () => {
    if (
      !focusExistingWindow(mainWindow) &&
      app.isReady() &&
      BrowserWindow.getAllWindows().length === 0
    ) {
      createWindow();
    }
  });

  void app
    .whenReady()
    .then(async () => {
      initializeCrashDiagnostics();
      if (!developmentServerUrl) installPackagedApplicationProtocol();
      if (process.platform === "win32") {
        app.setAppUserModelId("com.cedoz.cross-examination");
      }
      allowMediaPermissions();
      applyContentSecurityPolicy();

      // macOS: prompt for mic; Windows uses OS privacy settings + permission handlers above.
      if (process.platform === "darwin") {
        try {
          const status = systemPreferences.getMediaAccessStatus("microphone");
          console.log("[main] mic access status:", status);
          if (status !== "granted") {
            await systemPreferences.askForMediaAccess("microphone");
          }
        } catch (err) {
          console.warn("[main] mic permission prompt failed", err);
        }
      }

      registerIpc();
      createWindow();
      app.on("child-process-gone", (_event, details) => {
        recordDiagnostic(
          "child.gone",
          `type=${details.type} reason=${details.reason} exitCode=${String(details.exitCode)}`
        );
      });
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((err) => {
      console.error("[main] application startup failed", err);
      try {
        dialog.showErrorBox("Cross Examination could not start", String(err));
      } finally {
        app.quit();
      }
    });

  /** Persist any live exam before the process exits (window close / Cmd+Q). */
  app.on("before-quit", (event) => {
    if (quitCoordinator.isCommittedToQuit()) return;
    // An optional report may still be awaiting the network, but the transcript is
    // already durable. Never make quit appear hung for the report timeout.
    if (!voiceSessions.isActive() && !voiceSessions.hasUnsavedSession()) return;
    event.preventDefault();
    void finalizeUserRequestedQuit();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

if (ownsSingleInstance) startPrimaryInstance();
