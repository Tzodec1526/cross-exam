/** Minimal Electron stub for Vitest (avoids downloading the Electron binary in CI). */
export const app = {
  isPackaged: false,
  getPath: (name: string) => `/tmp/cross-examination-${name}`,
  requestSingleInstanceLock: () => true,
  quit: () => undefined,
  whenReady: () => Promise.resolve(),
  on: () => undefined,
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (plain: string) => Buffer.from(plain, "utf8"),
  decryptString: (buf: Buffer) => buf.toString("utf8"),
};

export class BrowserWindow {
  webContents = { id: 1, send: () => undefined, getURL: () => "" };
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  restore() {
    return undefined;
  }
  focus() {
    return undefined;
  }
  loadURL() {
    return Promise.resolve();
  }
  loadFile() {
    return Promise.resolve();
  }
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
};

export const ipcMain = { handle: () => undefined, on: () => undefined };
export const session = {
  defaultSession: {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    webRequest: { onHeadersReceived: () => undefined },
  },
};
export const shell = { openPath: async () => "" };
export const systemPreferences = {
  getMediaAccessStatus: () => "granted",
  askForMediaAccess: async () => true,
};
export const contextBridge = { exposeInMainWorld: () => undefined };
export const ipcRenderer = {
  invoke: async () => undefined,
  send: () => undefined,
  on: () => undefined,
  removeListener: () => undefined,
};
