import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { settingsPath } from "../paths.js";
import type { AppSettings } from "../types.js";
import {
  CorruptDataFileError,
  DataFileSafetyError,
  ensureDir,
  preserveCorruptDataFile,
  publicErrorMessage,
  readJson,
  readUtf8Bounded,
  writeJson,
} from "./fsutil.js";

/** What the renderer may see — never the full key. */
export type PublicSettings = {
  hasKey: boolean;
  keyLast4: string;
  keySource: "env" | "stored" | "none";
  defaultVoice: string;
  /** Whether OS secure storage can encrypt a stored API key. */
  encryptionAvailable: boolean;
  /** Set when settings.json was corrupt/unreadable (env key may still work). */
  dataError?: string;
};

type StoredSettings = {
  /** Encrypted (`enc:…`) key. Legacy plaintext is accepted only for migration. */
  xaiApiKey?: string;
  defaultVoice?: string;
};

/** Settings are tiny; this leaves ample room for OS-encryption overhead. */
export const SETTINGS_STORAGE_LIMITS = Object.freeze({
  maxJsonBytes: 16 * 1024,
  maxPlainApiKeyChars: 512,
  maxEncryptedApiKeyChars: 8 * 1024,
  maxVoiceChars: 80,
});

const defaults: AppSettings = {
  xaiApiKey: "",
  defaultVoice: "eve",
};

function encryptForDisk(plain: string): string {
  if (!plain) return "";
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS secure storage is unavailable. Set XAI_API_KEY in the environment instead."
      );
    }
    const encrypted = safeStorage.encryptString(plain);
    const encoded = "enc:" + encrypted.toString("base64");
    // Verify round-trip in this process so we never persist unreadable ciphertext.
    const check = safeStorage.decryptString(Buffer.from(encoded.slice(4), "base64"));
    if (check !== plain) throw new Error("OS secure storage encryption verification failed.");
    return encoded;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `API key was not saved because it could not be encrypted. ${detail} Use XAI_API_KEY for env-only configuration.`
    );
  }
}

type DecryptResult =
  | { ok: true; key: string }
  | { ok: false; reason: "empty" | "decrypt_failed" | "legacy_plaintext" };

function decryptFromDisk(stored: string): DecryptResult {
  if (!stored) return { ok: false, reason: "empty" };
  if (stored.startsWith("enc:")) {
    try {
      const buf = Buffer.from(stored.slice(4), "base64");
      const key = safeStorage.decryptString(buf);
      if (!key) return { ok: false, reason: "empty" };
      if (key.length > SETTINGS_STORAGE_LIMITS.maxPlainApiKeyChars) {
        throw new Error("Decrypted API key exceeds the safety limit");
      }
      return { ok: true, key };
    } catch (err) {
      console.error("[settings] Failed to decrypt stored API key", err);
      return { ok: false, reason: "decrypt_failed" };
    }
  }
  return { ok: false, reason: "legacy_plaintext" };
}

class InvalidStoredSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStoredSettingsError";
  }
}

class LegacyPlaintextKeyError extends Error {
  constructor(detail = "") {
    super(
      `A legacy plaintext API key was found and was not used. Unlock OS secure storage and save Settings again to migrate it, clear the stored key, or set XAI_API_KEY.${
        detail ? ` ${detail}` : ""
      }`
    );
    this.name = "LegacyPlaintextKeyError";
  }
}

function validateStoredSettings(value: unknown): StoredSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidStoredSettingsError("settings.json is not a settings object");
  }
  const record = value as Record<string, unknown>;
  const rawKey = record.xaiApiKey;
  if (rawKey !== undefined && typeof rawKey !== "string") {
    throw new InvalidStoredSettingsError("settings.json has an invalid API key field");
  }
  const xaiApiKey = rawKey ?? "";
  const keyLimit = xaiApiKey.startsWith("enc:")
    ? SETTINGS_STORAGE_LIMITS.maxEncryptedApiKeyChars
    : SETTINGS_STORAGE_LIMITS.maxPlainApiKeyChars;
  if (xaiApiKey.length > keyLimit) {
    throw new InvalidStoredSettingsError("settings.json API key field is too long");
  }

  const rawVoice = record.defaultVoice;
  if (rawVoice !== undefined && typeof rawVoice !== "string") {
    throw new InvalidStoredSettingsError("settings.json has an invalid default voice field");
  }
  const defaultVoice = rawVoice ?? defaults.defaultVoice;
  if (defaultVoice.length > SETTINGS_STORAGE_LIMITS.maxVoiceChars) {
    throw new InvalidStoredSettingsError("settings.json default voice field is too long");
  }

  // Canonicalize the record so unknown persisted fields never escape this module.
  return { xaiApiKey, defaultVoice: defaultVoice || defaults.defaultVoice };
}

/** Remove the old recovery copy before any plaintext-to-ciphertext transition. */
function removeLegacySettingsBackup(): void {
  const backup = `${settingsPath()}.bak`;
  try {
    fs.unlinkSync(backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new LegacyPlaintextKeyError(
      `The plaintext settings backup could not be removed (${publicErrorMessage(err)}).`
    );
  }
}

/**
 * Best-effort removal for a settings artifact that could not be verified free of
 * key material. Failing hard here would brick every settings read (and with it
 * exams that only need the env key) while removing nothing; the purge retries on
 * the next read instead.
 */
function removeUnverifiableSettingsArtifact(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(
      `[settings] Could not remove unverifiable settings artifact ${path.basename(file)}; will retry on the next read`,
      err
    );
  }
}

/** True when raw settings text plausibly contains xAI key material. */
function containsPlaintextKeyMaterial(raw: string): boolean {
  return /xai-/i.test(raw);
}

/**
 * Older versions could leave plaintext in settings.json.bak after encrypting the
 * live record. Retain verified encrypted/empty backups and purge every unsafe or
 * unverifiable backup leaf without ever following it. Removal is fail-hard only
 * when the leaf is confirmed to hold key material; an unreadable leaf is purged
 * best-effort so a transient share lock cannot make settings unreadable forever.
 */
function purgeLegacySettingsBackup(): void {
  const backup = `${settingsPath()}.bak`;
  let raw: string;
  try {
    raw = readUtf8Bounded(
      backup,
      SETTINGS_STORAGE_LIMITS.maxJsonBytes,
      "Settings backup JSON"
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    removeUnverifiableSettingsArtifact(backup);
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    if (containsPlaintextKeyMaterial(raw)) removeLegacySettingsBackup();
    else removeUnverifiableSettingsArtifact(backup);
    return;
  }
  const rawKey =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).xaiApiKey
      : undefined;
  if (typeof rawKey === "string" && rawKey && !rawKey.startsWith("enc:")) {
    // Confirmed plaintext key: refuse to run normally until it is gone.
    removeLegacySettingsBackup();
  } else if (typeof rawKey !== "string") {
    removeUnverifiableSettingsArtifact(backup);
  }
}

const SETTINGS_CORRUPT_RE = /^settings\.json\.corrupt-\d+(?:-\d+)?$/;
const SETTINGS_CORRUPT_SCAN_LIMIT = 64;

/**
 * Corrupt-preserved settings copies are diagnostic artifacts, but a legacy
 * plaintext key must not survive inside one. Retain copies verified free of key
 * material; remove the rest best-effort on every read.
 */
function purgeLegacySettingsCorruptCopies(): void {
  const directory = path.dirname(settingsPath());
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names.filter((n) => SETTINGS_CORRUPT_RE.test(n)).slice(
    0,
    SETTINGS_CORRUPT_SCAN_LIMIT
  )) {
    const candidate = path.join(directory, name);
    let raw: string;
    try {
      raw = readUtf8Bounded(candidate, SETTINGS_STORAGE_LIMITS.maxJsonBytes, name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      // An oversized quarantine is the only remaining copy of a repaired key.
      // A size miss is not proof the file is harmless, and it is not proof we
      // should delete it.
      if (err instanceof DataFileSafetyError && err.reason === "too_large") continue;
      removeUnverifiableSettingsArtifact(candidate);
      continue;
    }
    let verifiedKeyFree = false;
    try {
      const value = JSON.parse(raw) as unknown;
      const rawKey =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).xaiApiKey
          : undefined;
      const hasStringSecret =
        typeof rawKey === "string" && rawKey !== "" && !rawKey.startsWith("enc:");
      verifiedKeyFree = !hasStringSecret && !containsPlaintextKeyMaterial(raw);
    } catch {
      // Unparsable text is unverifiable. A missing "xai-" substring is not
      // evidence that the file has no key. Delete it, same as a bad .bak.
      verifiedKeyFree = false;
    }
    if (!verifiedKeyFree) removeUnverifiableSettingsArtifact(candidate);
  }
}

/** Keep an encrypted key when one other field makes the record invalid. */
function recoverableEncryptedKey(): string {
  let raw: string;
  try {
    raw = readUtf8Bounded(
      settingsPath(),
      SETTINGS_STORAGE_LIMITS.maxJsonBytes,
      "Settings JSON"
    );
  } catch {
    return "";
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const key = (value as Record<string, unknown>).xaiApiKey;
    if (
      typeof key === "string" &&
      key.startsWith("enc:") &&
      key.length <= SETTINGS_STORAGE_LIMITS.maxEncryptedApiKeyChars
    ) {
      return key;
    }
  } catch {
    return "";
  }
  return "";
}

function readStored(): StoredSettings {
  ensureDir(path.dirname(settingsPath()));
  purgeLegacySettingsBackup();
  purgeLegacySettingsCorruptCopies();
  return validateStoredSettings(
    readJson<unknown>(settingsPath(), {}, {
      maxBytes: SETTINGS_STORAGE_LIMITS.maxJsonBytes,
      label: "Settings JSON",
    })
  );
}

/**
 * Upgrade legacy input immediately. The atomic publish explicitly skips the
 * ordinary backup path so plaintext is never copied to settings.json.bak.
 */
function migrateLegacyPlaintextKey(stored: StoredSettings): StoredSettings {
  const rawKey = stored.xaiApiKey || "";
  if (!rawKey || rawKey.startsWith("enc:")) return stored;

  removeLegacySettingsBackup();
  let encrypted: string;
  try {
    encrypted = encryptForDisk(rawKey);
  } catch (err) {
    throw new LegacyPlaintextKeyError(publicErrorMessage(err));
  }

  const migrated: StoredSettings = {
    defaultVoice: stored.defaultVoice || defaults.defaultVoice,
    xaiApiKey: encrypted,
  };
  try {
    writeJson(settingsPath(), migrated, {
      backup: false,
      maxBytes: SETTINGS_STORAGE_LIMITS.maxJsonBytes,
      label: "Settings JSON",
    });
    // A concurrent or interrupted older build must not leave a plaintext copy.
    removeLegacySettingsBackup();
    return migrated;
  } catch (err) {
    if (err instanceof LegacyPlaintextKeyError) throw err;
    throw new LegacyPlaintextKeyError(
      `Migration could not be published (${publicErrorMessage(err)}).`
    );
  }
}

/**
 * Stage and fsync a repaired settings record before moving invalid live data.
 * If the final publish fails, restore the invalid file to its original path so
 * the next launch still reports the same actionable data error.
 */
function writeRepairedSettings(data: StoredSettings): void {
  const file = settingsPath();
  const tmp = `${file}.repair-tmp-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  let preservedPath: string | null = null;
  try {
    ensureDir(path.dirname(file));
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    try {
      fs.lstatSync(file);
      preservedPath = preserveCorruptDataFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* preserve the original write/fsync error */
      }
      fd = null;
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* preserve the original repair error */
    }
    if (preservedPath && !fs.existsSync(file)) {
      const rollbackSource = preservedPath;
      try {
        fs.renameSync(rollbackSource, file);
        preservedPath = null;
      } catch (rollbackErr) {
        throw new Error(
          `Settings repair failed and rollback also failed; invalid data remains at ${path.basename(
            rollbackSource
          )}: ${publicErrorMessage(err)}; rollback: ${publicErrorMessage(rollbackErr)}`
        );
      }
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/** Full settings for main-process use only (never send to renderer). */
export function loadSettings(): AppSettings {
  const envKey = process.env.XAI_API_KEY || "";
  try {
    const read = readStored();
    let stored: StoredSettings;
    try {
      stored = migrateLegacyPlaintextKey(read);
    } catch (err) {
      if (err instanceof LegacyPlaintextKeyError && envKey) {
        console.error("[settings] legacy plaintext key rejected; using environment key", err);
        return {
          ...defaults,
          defaultVoice: read.defaultVoice || defaults.defaultVoice,
          xaiApiKey: envKey,
        };
      }
      throw err;
    }
    // A ciphertext that fails to decrypt is deliberately left on disk: the
    // failure may be transient (locked keychain, DPAPI hiccup, wrong session
    // token), and a later launch or an explicit re-import can still recover or
    // replace it. Only Save ever rewrites the stored key.
    const disk = decryptFromDisk(stored.xaiApiKey || "");
    const diskKey = disk.ok ? disk.key : "";
    return {
      ...defaults,
      defaultVoice: stored.defaultVoice || defaults.defaultVoice,
      // env wins so counsel can keep the key off disk entirely
      xaiApiKey: envKey || diskKey || "",
    };
  } catch (err) {
    if (err instanceof LegacyPlaintextKeyError) {
      // A confirmed-but-unremovable plaintext artifact must not block exams
      // that never read the stored key. Without an env key it stays fatal.
      if (envKey) {
        console.error("[settings] legacy plaintext key issue; using environment key", err);
        return { ...defaults, xaiApiKey: envKey };
      }
      throw err;
    }
    // Corrupt settings.json — fall back to env-only so exams still work
    console.error("[settings] loadSettings failed; using env/defaults", err);
    return {
      ...defaults,
      xaiApiKey: envKey,
    };
  }
}

export function getPublicSettings(): PublicSettings {
  const envKey = process.env.XAI_API_KEY || "";
  let read: StoredSettings | null = null;
  try {
    read = readStored();
    const stored = migrateLegacyPlaintextKey(read);
    const disk = decryptFromDisk(stored.xaiApiKey || "");
    if (disk.ok === false && disk.reason === "decrypt_failed") {
      // The ciphertext stays on disk for a later recovery or explicit re-import.
      return {
        hasKey: Boolean(envKey),
        keyLast4: envKey ? envKey.slice(-4) : "",
        keySource: envKey ? "env" : "none",
        defaultVoice: stored.defaultVoice || defaults.defaultVoice,
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        dataError:
          "Stored API key could not be decrypted (OS secure storage may be locked). It was left in place; a later launch may recover it, or import the key again in Settings, or set XAI_API_KEY.",
      };
    }
    const diskKey = disk.ok ? disk.key : "";
    const effective = envKey || diskKey;
    let keySource: PublicSettings["keySource"] = "none";
    if (envKey) keySource = "env";
    else if (diskKey) keySource = "stored";
    return {
      hasKey: Boolean(effective),
      keyLast4: effective ? effective.slice(-4) : "",
      keySource,
      defaultVoice: stored.defaultVoice || defaults.defaultVoice,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  } catch (err) {
    return {
      hasKey: Boolean(envKey),
      keyLast4: envKey ? envKey.slice(-4) : "",
      keySource: envKey ? "env" : "none",
      defaultVoice: read?.defaultVoice || defaults.defaultVoice,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      // Renderer-facing: never disclose local filesystem paths.
      dataError: publicErrorMessage(err),
    };
  }
}

/**
 * Persist a settings patch.
 * - Never writes `XAI_API_KEY` env value to disk.
 * - Omitting `xaiApiKey` leaves the stored key unchanged.
 * - Empty string `xaiApiKey` leaves the stored key unchanged; `clearApiKey` clears it.
 * - When env key is set, an explicit patch that equals the env key is ignored for disk.
 */
export function saveSettings(patch: {
  xaiApiKey?: string;
  defaultVoice?: string;
  clearApiKey?: boolean;
}): void {
  // If settings.json is corrupt, start fresh rather than blocking Save forever
  let stored: StoredSettings = {};
  let repairInvalidLive = false;
  try {
    stored = readStored();
  } catch (err) {
    const repairable =
      err instanceof InvalidStoredSettingsError ||
      err instanceof CorruptDataFileError ||
      (err instanceof DataFileSafetyError && err.reason === "too_large");
    if (!repairable) throw err;
    // Malformed JSON may already have been moved by readJson. Semantic and size
    // failures remain live until all patch validation/encryption succeeds.
    // A still-readable encrypted key is part of the repair, not collateral.
    repairInvalidLive = true;
    const preservedKey = recoverableEncryptedKey();
    stored = preservedKey ? { xaiApiKey: preservedKey } : {};
  }
  const envKey = process.env.XAI_API_KEY || "";
  const storedRawKey = stored.xaiApiKey || "";
  const hasLegacyPlaintext = Boolean(storedRawKey && !storedRawKey.startsWith("enc:"));
  if (hasLegacyPlaintext) removeLegacySettingsBackup();
  const existing = decryptFromDisk(stored.xaiApiKey || "");
  // Decryption failure means plaintext is unavailable, not that the encrypted
  // credential should be erased by an unrelated preference save.
  let nextDiskKey = existing.ok
    ? existing.key
    : existing.reason === "legacy_plaintext"
      ? storedRawKey
      : "";

  let replacementRequested = false;
  if (patch.clearApiKey) {
    nextDiskKey = "";
  } else if (patch.xaiApiKey !== undefined) {
    const incoming = patch.xaiApiKey.trim();
    if (incoming.length > SETTINGS_STORAGE_LIMITS.maxPlainApiKeyChars) {
      throw new Error("API key is too long (max 512 characters)");
    }
    // Empty means "leave unchanged" from the UI (masked field not re-typed)
    if (incoming === "") {
      // keep nextDiskKey
    } else if (envKey && incoming === envKey) {
      // Do not persist env-only secret
    } else {
      nextDiskKey = incoming;
      replacementRequested = true;
    }
  }

  const nextVoice = (
    patch.defaultVoice !== undefined
      ? patch.defaultVoice
      : stored.defaultVoice || defaults.defaultVoice
  ).trim();
  if (nextVoice.length > SETTINGS_STORAGE_LIMITS.maxVoiceChars) {
    throw new Error("Default voice id is too long (max 80 characters)");
  }

  let serializedKey =
    !patch.clearApiKey && !replacementRequested && storedRawKey.startsWith("enc:")
      ? storedRawKey
      : "";
  if (nextDiskKey) {
    if (!replacementRequested && storedRawKey) {
      if (storedRawKey.startsWith("enc:")) {
        // Unrelated settings saves do not needlessly rotate working ciphertext.
        serializedKey = storedRawKey;
      } else {
        // Legacy plaintext is migration input only and is never used or copied.
        try {
          serializedKey = encryptForDisk(nextDiskKey);
        } catch (err) {
          throw new LegacyPlaintextKeyError(publicErrorMessage(err));
        }
      }
    } else {
      // New/replaced credentials are fail-closed: never fall back to plaintext.
      serializedKey = encryptForDisk(nextDiskKey);
    }
  }
  if (serializedKey.length > SETTINGS_STORAGE_LIMITS.maxEncryptedApiKeyChars) {
    throw new Error("Encrypted API key exceeds the settings storage safety limit");
  }

  const toWrite: StoredSettings = {
    defaultVoice: nextVoice || defaults.defaultVoice,
    xaiApiKey: serializedKey,
  };
  if (repairInvalidLive) writeRepairedSettings(toWrite);
  else if (hasLegacyPlaintext) {
    writeJson(settingsPath(), toWrite, {
      backup: false,
      maxBytes: SETTINGS_STORAGE_LIMITS.maxJsonBytes,
      label: "Settings JSON",
    });
    removeLegacySettingsBackup();
  } else {
    writeJson(settingsPath(), toWrite, {
      maxBytes: SETTINGS_STORAGE_LIMITS.maxJsonBytes,
      label: "Settings JSON",
    });
  }
  // Deliberately returns nothing: the decrypted key must never ride a return
  // value toward an IPC boundary. Callers use loadSettings/getPublicSettings.
}
