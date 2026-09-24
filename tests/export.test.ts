// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../electron/paths.js", () => ({
  mattersRoot: () => path.join(fixture.root, "matters"),
  matterDir: (id: string) => path.join(fixture.root, "matters", id),
}));

import { exportMatterZip } from "../electron/services/export";

const matterId = "11111111-1111-4111-8111-111111111111";
const matterRoot = () => path.join(fixture.root, "matters", matterId);

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-exam-export-"));
  fs.mkdirSync(path.join(matterRoot(), "documents"), { recursive: true });
  fs.writeFileSync(path.join(matterRoot(), "matter.json"), JSON.stringify({
    id: matterId, caption: "Test matter", court: "", notes: "",
    createdAt: "2026-07-13T12:00:00.000Z", updatedAt: "2026-07-13T12:00:00.000Z",
  }));
  fs.writeFileSync(path.join(matterRoot(), "documents", "evidence.txt"), "Source evidence");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe("matter ZIP exports", () => {
  it("writes a complete ZIP before reporting success", async () => {
    const destination = path.join(fixture.root, "backup.zip");
    await expect(exportMatterZip(matterId, destination)).resolves.toBe(destination);
    const contents = fs.readFileSync(destination);
    expect(contents.readUInt32LE(0)).toBe(0x04034b50);
    expect(contents.readUInt32LE(contents.length - 22)).toBe(0x06054b50);
    expect(contents.includes(Buffer.from("Test_matter/documents/evidence.txt"))).toBe(true);
  });

  it("rejects destination write failures and preserves the previous backup", async () => {
    const destination = path.join(fixture.root, "backup.zip");
    fs.writeFileSync(destination, "previous complete backup");
    const originalCreate = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
      const output = originalCreate(file, options);
      output._write = (_chunk, _encoding, callback) => callback(new Error("disk full"));
      // Keep the regression's old implementation from crashing the test process.
      output.on("error", () => undefined);
      return output;
    });

    await expect(exportMatterZip(matterId, destination)).rejects.toThrow("disk full");
    expect(fs.readFileSync(destination, "utf8")).toBe("previous complete backup");
    expect(fs.readdirSync(fixture.root).sort()).toEqual(["backup.zip", "matters"]);
  });

  it("refuses to export over a case file or into the matter tree", async () => {
    const metadata = path.join(matterRoot(), "matter.json");
    const original = fs.readFileSync(metadata, "utf8");
    await expect(exportMatterZip(matterId, metadata)).rejects.toThrow("outside the matter folder");
    await expect(exportMatterZip(matterId, path.join(matterRoot(), "new", "backup.zip")))
      .rejects.toThrow("outside the matter folder");
    expect(fs.readFileSync(metadata, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(matterRoot(), "new"))).toBe(false);
  });

  it("detects destinations redirected into the matter by a directory link", async () => {
    const alias = path.join(fixture.root, "alias");
    fs.symlinkSync(matterRoot(), alias, process.platform === "win32" ? "junction" : "dir");
    await expect(exportMatterZip(matterId, path.join(alias, "backup.zip")))
      .rejects.toThrow("outside the matter folder");
    expect(fs.existsSync(path.join(matterRoot(), "backup.zip"))).toBe(false);
  });

  it("does not create directories inside the matter when a link hides the destination", async () => {
    const alias = path.join(fixture.root, "alias");
    fs.symlinkSync(matterRoot(), alias, process.platform === "win32" ? "junction" : "dir");
    await expect(exportMatterZip(matterId, path.join(alias, "nested", "backup.zip")))
      .rejects.toThrow("outside the matter folder");
    expect(fs.existsSync(path.join(matterRoot(), "nested"))).toBe(false);
    expect(fs.existsSync(path.join(matterRoot(), "backup.zip"))).toBe(false);
  });

  it("refuses to archive a link inside the matter", async () => {
    const outside = path.join(fixture.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET-KEY-MATERIAL");
    fs.symlinkSync(
      outside,
      path.join(matterRoot(), "documents", "linked-dir"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const destination = path.join(fixture.root, "backup.zip");
    await expect(exportMatterZip(matterId, destination)).rejects.toThrow(/link or special file/i);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET-KEY-MATERIAL");
  });

  it("preserves an existing backup if the final replacement fails", async () => {
    const destination = path.join(fixture.root, "backup.zip");
    fs.writeFileSync(destination, "previous complete backup");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("backup is locked");
    });
    await expect(exportMatterZip(matterId, destination)).rejects.toThrow("backup is locked");
    expect(fs.readFileSync(destination, "utf8")).toBe("previous complete backup");
    expect(fs.readdirSync(fixture.root).sort()).toEqual(["backup.zip", "matters"]);
  });
});
