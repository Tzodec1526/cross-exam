// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ root: "" }));
const secureStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn<() => boolean>(),
  encryptString: vi.fn<(value: string) => Buffer>(),
  decryptString: vi.fn<(value: Buffer) => string>(),
}));

vi.mock("electron", () => ({ safeStorage: secureStorage }));
vi.mock("../electron/paths.js", () => ({
  settingsPath: () => path.join(harness.root, "settings.json"),
}));

import {
  getPublicSettings,
  loadSettings,
  saveSettings,
  SETTINGS_STORAGE_LIMITS,
} from "../electron/services/settings";

function settingsFile(): string {
  return path.join(harness.root, "settings.json");
}

beforeEach(() => {
  harness.root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-exam-settings-"));
  delete process.env.XAI_API_KEY;
  secureStorage.isEncryptionAvailable.mockReset().mockReturnValue(true);
  secureStorage.encryptString.mockReset().mockImplementation((value) =>
    Buffer.from(`cipher:${value}`, "utf8")
  );
  secureStorage.decryptString.mockReset().mockImplementation((value) =>
    value.toString("utf8").replace(/^cipher:/, "")
  );
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
  fs.rmSync(harness.root, { recursive: true, force: true });
});

describe("API-key storage", () => {
  it.each([undefined, "", "xai-env-only"])(
    "preserves temporarily undecryptable ciphertext on an unrelated settings save (%s)",
    (incoming) => {
      saveSettings({ xaiApiKey: "xai-recoverable", defaultVoice: "eve" });
      const encrypted = JSON.parse(fs.readFileSync(settingsFile(), "utf8")).xaiApiKey;
      secureStorage.decryptString.mockImplementation(() => { throw new Error("keychain locked"); });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.env.XAI_API_KEY = "xai-env-only";

      saveSettings({ defaultVoice: "ara", xaiApiKey: incoming });
      saveSettings({ defaultVoice: "leo" });

      expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")))
        .toEqual({ defaultVoice: "leo", xaiApiKey: encrypted });
      delete process.env.XAI_API_KEY;
      secureStorage.decryptString.mockImplementation((value) => value.toString("utf8").replace(/^cipher:/, ""));
      expect(loadSettings().xaiApiKey).toBe("xai-recoverable");
    }
  );

  it("can explicitly clear or replace temporarily undecryptable ciphertext", () => {
    saveSettings({ xaiApiKey: "xai-old" });
    const originalDecrypt = secureStorage.decryptString.getMockImplementation()!;
    secureStorage.decryptString.mockImplementation((value) => {
      if (value.toString().includes("xai-old")) throw new Error("old key unavailable");
      return originalDecrypt(value);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    saveSettings({ xaiApiKey: "xai-new" });
    expect(loadSettings().xaiApiKey).toBe("xai-new");
    secureStorage.decryptString.mockImplementation(() => { throw new Error("keychain locked"); });
    saveSettings({ clearApiKey: true });
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).xaiApiKey).toBe("");
  });

  it("never writes a new key as plaintext when secure storage is unavailable", () => {
    secureStorage.isEncryptionAvailable.mockReturnValue(false);

    expect(() => saveSettings({ xaiApiKey: "xai-super-secret", defaultVoice: "eve" }))
      .toThrow("could not be encrypted");

    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it("does not persist a key after encryption throws or fails verification", () => {
    secureStorage.encryptString.mockImplementationOnce(() => {
      throw new Error("keychain locked");
    });
    expect(() => saveSettings({ xaiApiKey: "xai-first-secret" })).toThrow(
      "could not be encrypted"
    );
    expect(fs.existsSync(settingsFile())).toBe(false);

    secureStorage.decryptString.mockReturnValueOnce("different key");
    expect(() => saveSettings({ xaiApiKey: "xai-second-secret" })).toThrow(
      "verification failed"
    );
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it("keeps an environment key off disk while saving other settings", () => {
    process.env.XAI_API_KEY = "xai-env-only";

    saveSettings({ xaiApiKey: "xai-env-only", defaultVoice: "ara" });

    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toEqual({
      defaultVoice: "ara",
      xaiApiKey: "",
    });
    expect(loadSettings()).toMatchObject({ xaiApiKey: "xai-env-only", defaultVoice: "ara" });
  });

  it("migrates a legacy plaintext key on load when secure storage becomes available", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: "xai-legacy-secret", defaultVoice: "eve" }),
      "utf8"
    );
    fs.writeFileSync(
      `${settingsFile()}.bak`,
      JSON.stringify({ xaiApiKey: "xai-legacy-secret", defaultVoice: "eve" }),
      "utf8"
    );

    expect(loadSettings().xaiApiKey).toBe("xai-legacy-secret");
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false);

    saveSettings({ defaultVoice: "leo" });

    const stored = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    expect(stored.defaultVoice).toBe("leo");
    expect(stored.xaiApiKey).toMatch(/^enc:/);
    expect(JSON.stringify(stored)).not.toContain("xai-legacy-secret");
    expect(loadSettings().xaiApiKey).toBe("xai-legacy-secret");
  });

  it("migrates a legacy plaintext key during Save without creating a plaintext backup", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: "xai-save-migration", defaultVoice: "eve" }),
      "utf8"
    );

    saveSettings({ defaultVoice: "leo" });

    const live = fs.readFileSync(settingsFile(), "utf8");
    expect(live).not.toContain("xai-save-migration");
    expect(JSON.parse(live)).toMatchObject({ defaultVoice: "leo", xaiApiKey: expect.stringMatching(/^enc:/) });
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false);
  });

  it("purges a stale plaintext backup left beside an already encrypted live key", () => {
    const encrypted = `enc:${Buffer.from("cipher:xai-encrypted-live", "utf8").toString("base64")}`;
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: encrypted, defaultVoice: "eve" }),
      "utf8"
    );
    fs.writeFileSync(
      `${settingsFile()}.bak`,
      JSON.stringify({ xaiApiKey: "xai-stale-plaintext", defaultVoice: "eve" }),
      "utf8"
    );

    expect(loadSettings().xaiApiKey).toBe("xai-encrypted-live");
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false);
  });

  it("rejects legacy plaintext with actionable guidance when migration is unavailable", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: "xai-legacy-secret", defaultVoice: "ara" }),
      "utf8"
    );
    fs.writeFileSync(`${settingsFile()}.bak`, "xai-legacy-secret", "utf8");
    secureStorage.isEncryptionAvailable.mockReturnValue(false);

    expect(() => loadSettings()).toThrow(/legacy plaintext API key.*was not used/i);
    expect(getPublicSettings()).toMatchObject({
      hasKey: false,
      keySource: "none",
      defaultVoice: "ara",
      dataError: expect.stringMatching(/unlock OS secure storage.*clear the stored key/i),
    });
    expect(() => saveSettings({ defaultVoice: "leo" })).toThrow(
      /legacy plaintext API key.*was not used/i
    );
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false);
    expect(fs.readFileSync(settingsFile(), "utf8")).toContain("xai-legacy-secret");
  });

  it("can clear a legacy key even when secure storage is unavailable", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: "xai-legacy-secret", defaultVoice: "eve" }),
      "utf8"
    );
    fs.writeFileSync(`${settingsFile()}.bak`, "xai-legacy-secret", "utf8");
    secureStorage.isEncryptionAvailable.mockReturnValue(false);

    saveSettings({ clearApiKey: true });

    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).xaiApiKey).toBe("");
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false);
  });

  it("loads valid persisted values at their field boundaries", () => {
    const key = "k".repeat(SETTINGS_STORAGE_LIMITS.maxPlainApiKeyChars);
    const voice = "v".repeat(SETTINGS_STORAGE_LIMITS.maxVoiceChars);
    fs.writeFileSync(settingsFile(), JSON.stringify({ xaiApiKey: key, defaultVoice: voice }));

    expect(loadSettings()).toEqual({ xaiApiKey: key, defaultVoice: voice });
    expect(getPublicSettings()).toMatchObject({
      hasKey: true,
      keyLast4: "kkkk",
      keySource: "stored",
      defaultVoice: voice,
    });
  });

  it("bounds oversized settings before reading and repairs them without rereading the live file", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.XAI_API_KEY = "xai-env-fallback";
    fs.writeFileSync(
      settingsFile(),
      "x".repeat(SETTINGS_STORAGE_LIMITS.maxJsonBytes + 1),
      "utf8"
    );

    expect(loadSettings()).toEqual({
      xaiApiKey: "xai-env-fallback",
      defaultVoice: "eve",
    });
    expect(getPublicSettings()).toMatchObject({
      hasKey: true,
      keySource: "env",
      defaultVoice: "eve",
      dataError: expect.stringContaining("Settings JSON exceeds"),
    });

    expect(() =>
      saveSettings({
        defaultVoice: "v".repeat(SETTINGS_STORAGE_LIMITS.maxVoiceChars + 1),
      })
    ).toThrow("Default voice id is too long");
    expect(fs.existsSync(settingsFile())).toBe(true);
    expect(
      fs.readdirSync(harness.root).some((name) => name.startsWith("settings.json.corrupt-"))
    ).toBe(false);

    const unboundedRead = vi.spyOn(fs, "readFileSync");
    saveSettings({ defaultVoice: "ara" });
    expect(unboundedRead).not.toHaveBeenCalled();
    unboundedRead.mockRestore();

    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toEqual({
      defaultVoice: "ara",
      xaiApiKey: "",
    });
    const preserved = fs
      .readdirSync(harness.root)
      .find((name) => name.startsWith("settings.json.corrupt-"));
    expect(preserved).toBeTruthy();
    expect(fs.statSync(path.join(harness.root, preserved!)).size).toBe(
      SETTINGS_STORAGE_LIMITS.maxJsonBytes + 1
    );
  });

  it.each([
    ["non-object", []],
    ["non-text API key", { xaiApiKey: { secret: true }, defaultVoice: "eve" }],
    ["non-text voice", { xaiApiKey: "", defaultVoice: 42 }],
    [
      "oversized legacy API key",
      {
        xaiApiKey: "k".repeat(SETTINGS_STORAGE_LIMITS.maxPlainApiKeyChars + 1),
        defaultVoice: "eve",
      },
    ],
    [
      "oversized voice",
      { xaiApiKey: "", defaultVoice: "v".repeat(SETTINGS_STORAGE_LIMITS.maxVoiceChars + 1) },
    ],
  ])("keeps %s settings values out of runtime types and lets Save repair them", (_label, value) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fs.writeFileSync(settingsFile(), JSON.stringify(value), "utf8");

    expect(loadSettings()).toEqual({ xaiApiKey: "", defaultVoice: "eve" });
    expect(getPublicSettings()).toMatchObject({
      hasKey: false,
      keySource: "none",
      defaultVoice: "eve",
      dataError: expect.stringContaining("settings.json"),
    });

    saveSettings({ defaultVoice: "leo" });
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toEqual({
      defaultVoice: "leo",
      xaiApiKey: "",
    });
    expect(
      fs.readdirSync(harness.root).some((name) => name.startsWith("settings.json.corrupt-"))
    ).toBe(true);
  });

  it("rolls invalid live settings back when the repaired record cannot be published", () => {
    const invalid = JSON.stringify({ xaiApiKey: { secret: true }, defaultVoice: "eve" });
    fs.writeFileSync(settingsFile(), invalid, "utf8");
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (
        String(source).includes(".repair-tmp-") &&
        path.resolve(String(destination)) === path.resolve(settingsFile())
      ) {
        throw Object.assign(new Error("injected repair publish failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    expect(() => saveSettings({ defaultVoice: "ara" })).toThrow(
      "injected repair publish failure"
    );
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe(invalid);
    expect(fs.readdirSync(harness.root).some((name) => name.includes(".repair-tmp-"))).toBe(
      false
    );
    expect(fs.readdirSync(harness.root).some((name) => name.includes(".corrupt-"))).toBe(false);
    expect(getPublicSettings().dataError).toContain("invalid API key field");
  });

  it("refuses to read or repair a link-like settings leaf", () => {
    const external = path.join(harness.root, "external-settings");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "secret.txt"), "must survive", "utf8");
    fs.symlinkSync(
      external,
      settingsFile(),
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(getPublicSettings().dataError).toContain("not a regular file");
    expect(() => saveSettings({ defaultVoice: "ara" })).toThrow("not a regular file");
    expect(fs.readFileSync(path.join(external, "secret.txt"), "utf8")).toBe("must survive");
  });
});

describe("audit hardening regressions", () => {
  it("keeps settings readable when an unverifiable backup cannot be read or removed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const encrypted = `enc:${Buffer.from("cipher:xai-live-key", "utf8").toString("base64")}`;
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: encrypted, defaultVoice: "eve" }),
      "utf8"
    );
    // A directory where the backup file belongs is unreadable as a settings
    // leaf and cannot be unlinked — the shape of a transient share lock.
    fs.mkdirSync(`${settingsFile()}.bak`);

    expect(loadSettings()).toMatchObject({ xaiApiKey: "xai-live-key", defaultVoice: "eve" });
    expect(getPublicSettings()).toMatchObject({ hasKey: true, keySource: "stored" });
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to the environment key when a confirmed plaintext backup cannot be removed", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.XAI_API_KEY = "xai-env-key";
    const encrypted = `enc:${Buffer.from("cipher:xai-live-key", "utf8").toString("base64")}`;
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: encrypted, defaultVoice: "eve" }),
      "utf8"
    );
    fs.writeFileSync(
      `${settingsFile()}.bak`,
      JSON.stringify({ xaiApiKey: "xai-stale-plaintext", defaultVoice: "eve" }),
      "utf8"
    );
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(`${settingsFile()}.bak`)) {
        throw Object.assign(new Error("backup is locked"), { code: "EACCES" });
      }
      return originalUnlink(target);
    });

    expect(loadSettings()).toMatchObject({ xaiApiKey: "xai-env-key" });

    delete process.env.XAI_API_KEY;
    expect(() => loadSettings()).toThrow(/legacy plaintext API key/i);
  });

  it("leaves undecryptable ciphertext on disk and recovers it when decryption returns", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const encrypted = `enc:${Buffer.from("cipher:xai-recoverable", "utf8").toString("base64")}`;
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: encrypted, defaultVoice: "ara" }),
      "utf8"
    );
    secureStorage.decryptString.mockImplementation(() => {
      throw new Error("DPAPI unavailable");
    });

    expect(loadSettings()).toMatchObject({ xaiApiKey: "", defaultVoice: "ara" });
    expect(getPublicSettings()).toMatchObject({
      hasKey: false,
      keySource: "none",
      dataError: expect.stringMatching(/could not be decrypted.*left in place/i),
    });
    // The stored ciphertext must survive the failed read untouched.
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).xaiApiKey).toBe(encrypted);

    secureStorage.decryptString.mockImplementation((value) =>
      value.toString("utf8").replace(/^cipher:/, "")
    );
    expect(loadSettings()).toMatchObject({ xaiApiKey: "xai-recoverable" });
    expect(getPublicSettings()).toMatchObject({ hasKey: true, keySource: "stored" });
  });

  it("purges corrupt-preserved settings copies that contain key material and keeps the rest", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: "", defaultVoice: "eve" }),
      "utf8"
    );
    const plaintextCopy = `${settingsFile()}.corrupt-1700000000000`;
    const harmlessCopy = `${settingsFile()}.corrupt-1700000000001`;
    const malformedKeyCopy = `${settingsFile()}.corrupt-1700000000002`;
    fs.writeFileSync(
      plaintextCopy,
      JSON.stringify({ xaiApiKey: "xai-forgotten-secret", defaultVoice: "eve" }),
      "utf8"
    );
    fs.writeFileSync(harmlessCopy, JSON.stringify({ defaultVoice: 42 }), "utf8");
    fs.writeFileSync(malformedKeyCopy, "{ truncated json with xai-partial-secret", "utf8");

    loadSettings();

    expect(fs.existsSync(plaintextCopy)).toBe(false);
    expect(fs.existsSync(malformedKeyCopy)).toBe(false);
    expect(fs.existsSync(harmlessCopy)).toBe(true);

    const malformedOtherSecret = `${settingsFile()}.corrupt-1700000000003`;
    fs.writeFileSync(malformedOtherSecret, "{ truncated json with sk-live-secret", "utf8");
    loadSettings();
    expect(fs.existsSync(malformedOtherSecret)).toBe(false);
    expect(fs.existsSync(harmlessCopy)).toBe(true);
  });

  it("keeps an encrypted key when repairing an unrelated invalid field", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const encrypted = `enc:${Buffer.from("cipher:xai-recoverable-key", "utf8").toString("base64")}`;
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ xaiApiKey: encrypted, defaultVoice: 42 }),
      "utf8"
    );

    saveSettings({ defaultVoice: "leo" });

    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toEqual({
      defaultVoice: "leo",
      xaiApiKey: encrypted,
    });
    expect(loadSettings().xaiApiKey).toBe("xai-recoverable-key");
  });

  it("retains an oversized settings quarantine after the following read", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fs.writeFileSync(
      settingsFile(),
      "x".repeat(SETTINGS_STORAGE_LIMITS.maxJsonBytes + 1),
      "utf8"
    );
    saveSettings({ defaultVoice: "ara" });
    getPublicSettings();
    const preserved = fs
      .readdirSync(harness.root)
      .find((name) => name.startsWith("settings.json.corrupt-"));
    expect(preserved).toBeTruthy();
    expect(fs.statSync(path.join(harness.root, preserved!)).size).toBe(
      SETTINGS_STORAGE_LIMITS.maxJsonBytes + 1
    );
  });

  it("never discloses local paths through the settings data error", () => {
    const external = path.join(harness.root, "external-settings-dir");
    fs.mkdirSync(external);
    fs.symlinkSync(
      external,
      settingsFile(),
      process.platform === "win32" ? "junction" : "dir"
    );

    const publicSettings = getPublicSettings();
    expect(publicSettings.dataError).toBeTruthy();
    expect(publicSettings.dataError).not.toContain(harness.root);
  });
});
