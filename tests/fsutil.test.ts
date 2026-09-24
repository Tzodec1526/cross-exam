// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publicErrorMessage,
  readJson,
  writeFileAtomic,
  writeJson,
} from "../electron/services/fsutil";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-exam-fsutil-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("JSON persistence boundaries", () => {
  it("redacts local paths and bounds renderer-facing diagnostics", () => {
    const diagnostic = publicErrorMessage(
      new Error(
        `EIO: failed to open '${path.join(root, "private matter", "session.json")}' ${"x".repeat(3_000)}`
      )
    );

    expect(diagnostic).toContain("[local path]");
    expect(diagnostic).not.toContain(root);
    expect(diagnostic).not.toContain("private matter");
    expect(diagnostic.length).toBeLessThanOrEqual(2_000);
  });

  it("does not rename a valid record after a transient read failure", () => {
    const file = path.join(root, "record.json");
    fs.writeFileSync(file, JSON.stringify({ valid: true }), "utf8");
    vi.spyOn(fs, "readSync").mockImplementation(() => {
      throw Object.assign(new Error("device busy"), { code: "EBUSY" });
    });

    expect(() => readJson(file, null)).toThrow("Could not read data file");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.includes(".corrupt-"))).toEqual([]);
  });

  it("accepts the byte-limit boundary and rejects one byte over without parsing or moving", () => {
    const file = path.join(root, "record.json");
    fs.writeFileSync(file, "null", "utf8");

    expect(readJson(file, "fallback", { maxBytes: 4, label: "Test JSON" })).toBeNull();
    expect(() => readJson(file, null, { maxBytes: 3, label: "Test JSON" })).toThrow(
      "Test JSON exceeds the 3-byte safety limit"
    );
    expect(fs.readFileSync(file, "utf8")).toBe("null");
    expect(fs.readdirSync(root).filter((name) => name.includes(".corrupt-"))).toEqual([]);
  });

  it("detects growth after the descriptor size check", () => {
    const file = path.join(root, "record.json");
    fs.writeFileSync(file, "0", "utf8");
    const originalRead = fs.readSync.bind(fs);
    let grew = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (!grew) {
        grew = true;
        fs.appendFileSync(file, "0", "utf8");
      }
      return originalRead(...args);
    });

    expect(() => readJson(file, null, { maxBytes: 1, label: "Growing JSON" })).toThrow(
      "Growing JSON exceeds the 1-byte safety limit"
    );
    expect(fs.existsSync(file)).toBe(true);
  });

  it("never preserves a different file that replaced the path after open", () => {
    const file = path.join(root, "record.json");
    const old = path.join(root, "old.json");
    fs.writeFileSync(file, "{broken", "utf8");
    const originalRead = fs.readSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(file, old);
        fs.writeFileSync(file, JSON.stringify({ replacement: true }), "utf8");
      }
      return originalRead(...args);
    });

    expect(() => readJson(file, null)).toThrow("changed");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ replacement: true });
    expect(fs.readFileSync(old, "utf8")).toBe("{broken");
    expect(fs.readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("does not classify an in-place change during reading as corrupt JSON", () => {
    const file = path.join(root, "record.json");
    fs.writeFileSync(file, "{broken", "utf8");
    const originalRead = fs.readSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const bytesRead = originalRead(...args);
      if (!replaced && bytesRead > 0) {
        replaced = true;
        fs.writeFileSync(file, "null   ", "utf8");
      }
      return bytesRead;
    });

    expect(() => readJson(file, null)).toThrow("changed while it was being read");
    expect(fs.readFileSync(file, "utf8")).toBe("null   ");
    expect(fs.readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("rejects a link-like JSON leaf without reading from its target", () => {
    const external = path.join(root, "external-json");
    const file = path.join(root, "record.json");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "secret.json"), JSON.stringify({ secret: true }));
    fs.symlinkSync(external, file, process.platform === "win32" ? "junction" : "dir");

    expect(() => readJson(file, null, { maxBytes: 1024 })).toThrow("not a regular file");
    expect(fs.readFileSync(path.join(external, "secret.json"), "utf8")).toContain("secret");
  });

  it("preserves syntactically malformed JSON as a corrupt copy", () => {
    const file = path.join(root, "record.json");
    fs.writeFileSync(file, "{not json", "utf8");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => readJson(file, null)).toThrow("Corrupt data file");
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([
      expect.stringMatching(/^record\.json\.corrupt-\d+$/),
    ]);
  });

  it("leaves reconstructable corrupt JSON in place when preservation is disabled", () => {
    const file = path.join(root, "index.json");
    fs.writeFileSync(file, "{not json", "utf8");

    expect(() =>
      readJson(file, null, {
        label: "Case record index",
        preserveCorrupt: false,
      })
    ).toThrow("original left in place");
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
    expect(fs.readdirSync(root).filter((name) => name.includes(".corrupt-"))).toEqual([]);
  });

  it("bounds a no-backup JSON write before mutating or reading the live record", () => {
    const file = path.join(root, "index.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
    const replacement = { version: 2, label: "évidence" };
    const serialized = JSON.stringify(replacement, null, 2);
    const exactBytes = Buffer.byteLength(serialized, "utf8");
    const readSpy = vi.spyOn(fs, "readFileSync");

    expect(() =>
      writeJson(file, replacement, {
        backup: false,
        maxBytes: exactBytes - 1,
        label: "Case record index",
      })
    ).toThrow(`Case record index exceeds the ${exactBytes - 1}-byte safety limit`);
    expect(readSpy).not.toHaveBeenCalled();

    writeJson(file, replacement, {
      backup: false,
      maxBytes: exactBytes,
      label: "Case record index",
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    readSpy.mockRestore();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(replacement);
  });

  it("removes a failed temporary write without damaging the live record", () => {
    const file = path.join(root, "record.json");
    writeJson(file, { version: 1 });
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(source).includes(".tmp-") && path.resolve(String(destination)) === path.resolve(file)) {
        throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
      }
      return originalRename(source, destination);
    });

    expect(() => writeJson(file, { version: 2 })).toThrow("rename blocked");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1 });
    expect(fs.readdirSync(root).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("replaces a hardlink atomically without writing through to its victim", () => {
    const victim = path.join(root, "victim.txt");
    const artifact = path.join(root, "artifact.txt");
    fs.writeFileSync(victim, "must survive", "utf8");
    fs.linkSync(victim, artifact);

    writeFileAtomic(artifact, "replacement");

    expect(fs.readFileSync(victim, "utf8")).toBe("must survive");
    expect(fs.readFileSync(artifact, "utf8")).toBe("replacement");
  });

  it("rejects a link-like target without writing into its external directory", () => {
    const external = path.join(root, "external");
    const artifact = path.join(root, "artifact.txt");
    fs.mkdirSync(external);
    fs.symlinkSync(external, artifact, process.platform === "win32" ? "junction" : "dir");

    expect(() => writeFileAtomic(artifact, "replacement")).toThrow(
      "Refusing to replace non-regular file"
    );
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it("cleans its exclusive temp and preserves the live file when fsync fails", () => {
    const file = path.join(root, "artifact.txt");
    fs.writeFileSync(file, "original", "utf8");
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    });

    expect(() => writeFileAtomic(file, "replacement")).toThrow("injected fsync failure");
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(fs.readdirSync(root).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("stages a JSON backup instead of following an existing backup hardlink", () => {
    const file = path.join(root, "record.json");
    const victim = path.join(root, "victim.json");
    writeJson(file, { version: 1 });
    fs.writeFileSync(victim, "must survive", "utf8");
    fs.linkSync(victim, `${file}.bak`);

    writeJson(file, { version: 2 });

    expect(fs.readFileSync(victim, "utf8")).toBe("must survive");
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ version: 1 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 2 });
  });
});
