import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJson, writeJson } from "./fsutil.js";

describe("fsutil", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("writes and reads json atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-fs-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "test.json");
    writeJson(file, { ok: true, n: 1 });
    writeJson(file, { ok: true, n: 2 });
    expect(readJson(file, { ok: false })).toEqual({ ok: true, n: 2 });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });

  it("throws on corrupt json and preserves file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-fs-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{not json", "utf8");
    expect(() => readJson(file, {})).toThrow(/Corrupt data file/);
    const corrupt = fs.readdirSync(dir).find((n) => n.startsWith("bad.json.corrupt-"));
    expect(corrupt).toBeTruthy();
  });
});
