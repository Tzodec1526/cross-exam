// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
}));

import "../electron/preload";

type ExposedApi = {
  getVoiceState(): Promise<unknown>;
  stopVoice(generateReport: boolean): Promise<unknown>;
  pickAndImportDocs(matterId: string): Promise<unknown>;
  deleteSession(matterId: string, sessionId: string): Promise<unknown>;
  deleteDoc(matterId: string, documentId: string): Promise<unknown>;
  cancelReindexDocs(matterId: string): Promise<unknown>;
};

const api = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as ExposedApi;

beforeEach(() => {
  electronMocks.invoke.mockReset();
});

describe("preload lifecycle bridge", () => {
  it("reads voice ownership through the invoke-only state channel", async () => {
    const state = {
      active: true,
      hasSession: true,
      hasUnsavedSession: false,
      matterId: "matter-id",
      sessionId: "session-id",
    };
    electronMocks.invoke.mockResolvedValueOnce(state);

    await expect(api.getVoiceState()).resolves.toBe(state);
    expect(electronMocks.invoke).toHaveBeenCalledWith("voice:getState");
  });

  it("stops voice through a decision-only channel and returns capabilities", async () => {
    const terminal = {
      session: { id: "session-id", matterId: "matter-id" },
      canOpenTranscript: true,
      canOpenReport: false,
      needsSaveRetry: false,
    };
    electronMocks.invoke.mockResolvedValueOnce(terminal);

    await expect(api.stopVoice(true)).resolves.toBe(terminal);
    expect(electronMocks.invoke).toHaveBeenCalledWith("voice:stop", true);
  });

  it("passes only matter and session identity to session deletion", async () => {
    electronMocks.invoke.mockResolvedValueOnce({ deleted: "session-id" });

    await expect(api.deleteSession("matter-id", "session-id")).resolves.toEqual({
      deleted: "session-id",
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "sessions:delete",
      "matter-id",
      "session-id"
    );
  });

  it("cancels indexing through an invoke-only matter channel", async () => {
    electronMocks.invoke.mockResolvedValueOnce({ cancelled: "matter-id" });

    await expect(api.cancelReindexDocs("matter-id")).resolves.toEqual({
      cancelled: "matter-id",
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith("docs:cancelReindex", "matter-id");
  });

  it("returns the structured document import recovery result without exposing search IPC", async () => {
    const result = {
      imported: ["Exhibit 1.pdf"],
      needsReindex: true,
    };
    electronMocks.invoke.mockResolvedValueOnce(result);

    await expect(api.pickAndImportDocs("matter-id")).resolves.toBe(result);
    expect(electronMocks.invoke).toHaveBeenCalledWith("docs:pickAndImport", "matter-id");
    expect("searchDocs" in api).toBe(false);
  });

  it("passes only matter and current document identity to document deletion", async () => {
    electronMocks.invoke.mockResolvedValueOnce({ deleted: "document-id" });

    await expect(api.deleteDoc("matter-id", "document-id")).resolves.toEqual({
      deleted: "document-id",
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "docs:delete",
      "matter-id",
      "document-id"
    );
  });
});
