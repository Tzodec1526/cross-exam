// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedPaths = vi.hoisted(() => ({ root: "" }));

vi.mock("../electron/paths.js", () => ({
  mattersRoot: () => path.join(mockedPaths.root, "matters"),
  matterDir: (matterId: string) => path.join(mockedPaths.root, "matters", matterId),
  matterMetaPath: (matterId: string) =>
    path.join(mockedPaths.root, "matters", matterId, "matter.json"),
  documentsDir: (matterId: string) =>
    path.join(mockedPaths.root, "matters", matterId, "documents"),
  personasPath: (matterId: string) =>
    path.join(mockedPaths.root, "matters", matterId, "personas.json"),
  sessionsDir: (matterId: string) =>
    path.join(mockedPaths.root, "matters", matterId, "sessions"),
}));

import {
  assertTrustedIndexPath,
  assertTrustedSessionsDirectory,
  createMatter,
  deleteDocument,
  deleteMatter,
  deletePersona,
  getMatter,
  findTrustedSessionsDirectory,
  IMPORT_LIMITS,
  ImportRollbackUncertainError,
  importFiles,
  listMatters,
  listPersonas,
  MATTER_STORAGE_LIMITS,
  restoreMatterMeta,
  sanitizeImportLeafName,
  savePersona,
  touchMatter,
} from "../electron/services/matters";
import { discardIndex } from "../electron/services/indexer";

const matterId = "11111111-1111-4111-8111-111111111111";

function validMatter(overrides: Record<string, unknown> = {}) {
  return {
    id: matterId,
    caption: "Test matter",
    court: "Test court",
    notes: "",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function validPersona(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    matterId,
    fullName: "Test Witness",
    role: "Witness",
    attitude: "neutral",
    notes: "",
    keyterms: ["approval"],
    voice: "eve",
    createdAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function linkDirectory(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function documentsEntries(): string[] {
  const destination = path.join(mockedPaths.root, "matters", matterId, "documents");
  return fs.existsSync(destination) ? fs.readdirSync(destination) : [];
}

function mockSourceSizes(sizes: Map<string, number>): void {
  const originalLstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation(
    ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stat =
        options === undefined
          ? originalLstat(target)
          : (originalLstat as unknown as (
              path: fs.PathLike,
              options: fs.StatSyncOptions
            ) => fs.Stats | fs.BigIntStats)(target, options);
      const size = sizes.get(path.resolve(String(target)));
      if (size !== undefined) {
        if (typeof stat.size === "bigint") stat.size = BigInt(size);
        else stat.size = size;
      }
      return stat;
    }) as typeof fs.lstatSync
  );
}

beforeEach(() => {
  mockedPaths.root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-exam-matters-"));
  const dir = path.join(mockedPaths.root, "matters", matterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "matter.json"),
    JSON.stringify(validMatter()),
    "utf8"
  );
});

afterEach(() => {
  fs.rmSync(mockedPaths.root, { recursive: true, force: true });
});

describe("document imports", () => {
  it("preflights every source before copying an earlier valid file", () => {
    const source = path.join(mockedPaths.root, "first.txt");
    const missing = path.join(mockedPaths.root, "missing.txt");
    fs.writeFileSync(source, "first record", "utf8");
    const copy = vi.spyOn(fs, "copyFileSync");

    expect(() => importFiles(matterId, [source, missing])).toThrow(
      "Import source is not a readable file"
    );

    expect(copy).not.toHaveBeenCalled();
    expect(documentsEntries()).toEqual([]);
  });

  it("rejects more than 500 selected files before creating a destination", () => {
    const sources = Array.from(
      { length: IMPORT_LIMITS.maxFiles + 1 },
      (_, index) => path.join(mockedPaths.root, `source-${index}.txt`)
    );

    expect(() => importFiles(matterId, sources)).toThrow(
      `Cannot import more than ${IMPORT_LIMITS.maxFiles} files`
    );
    expect(documentsEntries()).toEqual([]);
  });

  it("rejects a file over 100 MiB before creating a destination", () => {
    const source = path.join(mockedPaths.root, "oversize.pdf");
    fs.writeFileSync(source, "record", "utf8");
    mockSourceSizes(new Map([[path.resolve(source), IMPORT_LIMITS.maxFileBytes + 1]]));

    expect(() => importFiles(matterId, [source])).toThrow("100 MiB file limit");
    expect(documentsEntries()).toEqual([]);
  });

  it("rejects a batch over 1 GiB before creating a destination", () => {
    const sourceCount = Math.floor(
      IMPORT_LIMITS.maxTotalBytes / IMPORT_LIMITS.maxFileBytes
    ) + 1;
    const sources = Array.from({ length: sourceCount }, (_, index) => {
      const source = path.join(mockedPaths.root, `large-${index}.pdf`);
      fs.writeFileSync(source, "record", "utf8");
      return source;
    });
    mockSourceSizes(
      new Map(sources.map((source) => [path.resolve(source), IMPORT_LIMITS.maxFileBytes]))
    );

    expect(() => importFiles(matterId, sources)).toThrow("1024 MiB total limit");
    expect(documentsEntries()).toEqual([]);
  });

  it("does not copy through a dangling symlink already in the documents folder", () => {
    const documents = path.join(mockedPaths.root, "matters", matterId, "documents");
    fs.mkdirSync(documents, { recursive: true });
    const outside = path.join(mockedPaths.root, "outside");
    fs.mkdirSync(outside);
    const escaped = path.join(outside, "escaped.txt");
    fs.symlinkSync(escaped, path.join(documents, "evidence.txt"), "file");
    const source = path.join(mockedPaths.root, "evidence.txt");
    fs.writeFileSync(source, "INSIDE-BYTES", "utf8");

    expect(importFiles(matterId, [source])).toEqual(["evidence (1).txt"]);
    expect(fs.readFileSync(path.join(documents, "evidence (1).txt"), "utf8")).toBe("INSIDE-BYTES");
    expect(fs.existsSync(escaped)).toBe(false);
    expect(fs.lstatSync(path.join(documents, "evidence.txt")).isSymbolicLink()).toBe(true);
  });

  it("rejects a source symlink and an unreadable source before copying anything", () => {
    const ordinary = path.join(mockedPaths.root, "ordinary.txt");
    const linkedDirectory = path.join(mockedPaths.root, "linked-source");
    const external = path.join(mockedPaths.root, "external-source");
    fs.writeFileSync(ordinary, "record", "utf8");
    fs.mkdirSync(external);
    linkDirectory(external, linkedDirectory);

    expect(() => importFiles(matterId, [ordinary, linkedDirectory])).toThrow(
      "Import source is not a readable file"
    );
    expect(documentsEntries()).toEqual([]);

    const originalAccess = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
      if (path.resolve(String(target)) === path.resolve(ordinary)) {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      }
      return originalAccess(target, mode);
    });
    expect(() => importFiles(matterId, [ordinary])).toThrow(
      "Import source is not a readable file"
    );
    expect(documentsEntries()).toEqual([]);
  });

  it("rolls back completed copies when a later exclusive copy fails", () => {
    const first = path.join(mockedPaths.root, "first.txt");
    const second = path.join(mockedPaths.root, "second.txt");
    fs.writeFileSync(first, "first record", "utf8");
    fs.writeFileSync(second, "second record", "utf8");
    const originalCopy = fs.copyFileSync.bind(fs);
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (path.resolve(String(source)) === path.resolve(second)) {
        throw Object.assign(new Error("injected copy failure"), { code: "EIO" });
      }
      return originalCopy(source, destination, mode);
    });

    expect(() => importFiles(matterId, [first, second])).toThrow("injected copy failure");
    expect(documentsEntries()).toEqual([]);
  });

  it("removes both completed and partial destinations after a copy failure", () => {
    const first = path.join(mockedPaths.root, "first.txt");
    const second = path.join(mockedPaths.root, "second.txt");
    fs.writeFileSync(first, "first record", "utf8");
    fs.writeFileSync(second, "second record", "utf8");
    const originalCopy = fs.copyFileSync.bind(fs);
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (path.resolve(String(source)) === path.resolve(second)) {
        fs.writeFileSync(String(destination), "partial second record", "utf8");
        throw Object.assign(new Error("injected partial copy failure"), { code: "EIO" });
      }
      return originalCopy(source, destination, mode);
    });

    expect(() => importFiles(matterId, [first, second])).toThrow(
      "injected partial copy failure"
    );
    expect(documentsEntries()).toEqual([]);
  });

  it("surfaces an uncertain rollback when a partial destination cannot be removed", () => {
    const source = path.join(mockedPaths.root, "partial.txt");
    fs.writeFileSync(source, "source record", "utf8");
    const destination = path.join(
      mockedPaths.root,
      "matters",
      matterId,
      "documents",
      "partial.txt"
    );
    vi.spyOn(fs, "copyFileSync").mockImplementation((_source, target) => {
      fs.writeFileSync(String(target), "partial destination", "utf8");
      throw Object.assign(new Error("injected copy failure"), { code: "EIO" });
    });
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(destination)) {
        throw Object.assign(new Error("destination locked"), { code: "EPERM" });
      }
      return originalUnlink(target);
    });

    let failure: unknown;
    try {
      importFiles(matterId, [source]);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(ImportRollbackUncertainError);
    expect((failure as Error).message).toContain("destination cleanup could not be verified");
    expect(fs.readFileSync(destination, "utf8")).toBe("partial destination");
  });

  it("does not create a documents folder for an unknown matter", () => {
    const unknown = "22222222-2222-4222-8222-222222222222";
    const source = path.join(mockedPaths.root, "source.txt");
    fs.writeFileSync(source, "record", "utf8");

    expect(() => importFiles(unknown, [source])).toThrow("Matter not found");
    expect(
      fs.existsSync(path.join(mockedPaths.root, "matters", unknown, "documents"))
    ).toBe(false);
  });

  it("retries an exclusively claimed collision without overwriting the competing file", () => {
    const source = path.join(mockedPaths.root, "record.txt");
    fs.writeFileSync(source, "our record", "utf8");
    const destination = path.join(mockedPaths.root, "matters", matterId, "documents");
    const originalCopy = fs.copyFileSync.bind(fs);
    let raced = false;
    vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest, mode) => {
      if (!raced) {
        raced = true;
        fs.mkdirSync(path.dirname(String(dest)), { recursive: true });
        fs.writeFileSync(String(dest), "competing record", "utf8");
        throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
      }
      return originalCopy(src, dest, mode);
    });

    expect(importFiles(matterId, [source])).toEqual(["record (1).txt"]);
    expect(fs.readFileSync(path.join(destination, "record.txt"), "utf8")).toBe(
      "competing record"
    );
    expect(fs.readFileSync(path.join(destination, "record (1).txt"), "utf8")).toBe(
      "our record"
    );
  });

  it("imports into an ordinary documents directory under the matter", () => {
    const source = path.join(mockedPaths.root, "ordinary.txt");
    fs.writeFileSync(source, "ordinary record", "utf8");

    expect(importFiles(matterId, [source])).toEqual(["ordinary.txt"]);
    expect(
      fs.readFileSync(
        path.join(mockedPaths.root, "matters", matterId, "documents", "ordinary.txt"),
        "utf8"
      )
    ).toBe("ordinary record");
  });

  it("rejects a Windows-style matter junction instead of copying outside matters", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-matter-import");
    const source = path.join(mockedPaths.root, "source.txt");
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(path.join(external, "documents"), { recursive: true });
    fs.writeFileSync(path.join(external, "matter.json"), JSON.stringify(validMatter()), "utf8");
    fs.writeFileSync(source, "must not escape", "utf8");
    linkDirectory(external, matter);

    expect(() => importFiles(matterId, [source])).toThrow("not a trusted directory");
    expect(fs.existsSync(path.join(external, "documents", "source.txt"))).toBe(false);
  });

  it("rejects a Windows-style documents junction instead of copying outside the matter", () => {
    const documents = path.join(mockedPaths.root, "matters", matterId, "documents");
    const external = path.join(mockedPaths.root, "external-documents-import");
    const source = path.join(mockedPaths.root, "source.txt");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(source, "must not escape", "utf8");
    linkDirectory(external, documents);

    expect(() => importFiles(matterId, [source])).toThrow("not a trusted directory");
    expect(fs.existsSync(path.join(external, "source.txt"))).toBe(false);
  });
});

describe("workspace root containment", () => {
  it("creates an ordinary matter under the validated matters root", () => {
    const created = createMatter({ caption: "New matter" });
    const createdDir = path.join(mockedPaths.root, "matters", created.id);

    expect(JSON.parse(fs.readFileSync(path.join(createdDir, "matter.json"), "utf8"))).toMatchObject({
      id: created.id,
      caption: "New matter",
    });
    expect(fs.statSync(path.join(createdDir, "documents")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(createdDir, "sessions")).isDirectory()).toBe(true);
  });

  it("rejects a Windows-style matters-root junction instead of creating outside data", () => {
    const root = path.join(mockedPaths.root, "matters");
    const external = path.join(mockedPaths.root, "external-matters-root");
    fs.rmSync(root, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    linkDirectory(external, root);

    expect(() => createMatter({ caption: "Must not escape" })).toThrow(
      "Matters directory is not a trusted directory"
    );
    expect(fs.readdirSync(external)).toEqual([]);
  });
});

describe("session directory containment", () => {
  it("preserves missing-session semantics and creates only under a trusted matter", () => {
    expect(findTrustedSessionsDirectory(matterId)).toBeNull();

    const created = assertTrustedSessionsDirectory(matterId, true);

    expect(created).toBe(
      fs.realpathSync.native(path.join(mockedPaths.root, "matters", matterId, "sessions"))
    );
    expect(findTrustedSessionsDirectory(matterId)).toBe(created);
  });

  it("rejects a Windows-style sessions junction instead of trusting its target", () => {
    const sessions = path.join(mockedPaths.root, "matters", matterId, "sessions");
    const external = path.join(mockedPaths.root, "external-sessions");
    fs.mkdirSync(external, { recursive: true });
    linkDirectory(external, sessions);

    expect(() => assertTrustedSessionsDirectory(matterId)).toThrow(
      "Matter sessions folder is not a trusted directory"
    );
    expect(() => findTrustedSessionsDirectory(matterId)).toThrow(
      "Matter sessions folder is not a trusted directory"
    );
    expect(fs.readdirSync(external)).toEqual([]);
  });
});

describe("matter deletion containment", () => {
  it("deletes an ordinary matter directory and nothing above it", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const sibling = path.join(mockedPaths.root, "matters", "keep.txt");
    fs.writeFileSync(sibling, "keep", "utf8");

    expect(deleteMatter(matterId)).toEqual({ deleted: matterId });
    expect(fs.existsSync(matter)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("keep");
  });

  it("rejects a Windows-style matter junction without deleting its target", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-matter-delete");
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "victim.txt"), "must survive", "utf8");
    linkDirectory(external, matter);

    expect(() => assertTrustedIndexPath(matterId)).toThrow("not a trusted directory");
    expect(() => discardIndex(matterId)).toThrow("not a trusted directory");
    expect(() => deleteMatter(matterId)).toThrow("not a trusted directory");
    expect(fs.existsSync(path.join(external, "index.json.discarded"))).toBe(false);
    expect(fs.readFileSync(path.join(external, "victim.txt"), "utf8")).toBe("must survive");
  });
});

describe("matter metadata containment", () => {
  it("rejects a matter junction instead of reading metadata from its target", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-matter-read");
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(
      path.join(external, "matter.json"),
      JSON.stringify(validMatter({ caption: "Outside secret" })),
      "utf8"
    );
    linkDirectory(external, matter);

    expect(() => getMatter(matterId)).toThrow("Matter directory is not a trusted directory");
  });

  it("rejects a matter junction instead of touching metadata in its target", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-matter-touch");
    const externalMeta = path.join(external, "matter.json");
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(externalMeta, JSON.stringify(validMatter()), "utf8");
    const original = fs.readFileSync(externalMeta, "utf8");
    linkDirectory(external, matter);

    expect(() => touchMatter(matterId)).toThrow("Matter directory is not a trusted directory");
    expect(fs.readFileSync(externalMeta, "utf8")).toBe(original);
    expect(fs.existsSync(`${externalMeta}.bak`)).toBe(false);
  });

  it("rejects an oversized matter record before reading and leaves it available for recovery", () => {
    const live = path.join(mockedPaths.root, "matters", matterId, "matter.json");
    fs.writeFileSync(live, "x".repeat(MATTER_STORAGE_LIMITS.maxMatterJsonBytes + 1), "utf8");
    const read = vi.spyOn(fs, "readSync");

    const result = listMatters();

    expect(read).not.toHaveBeenCalled();
    expect(result.matters).toEqual([]);
    expect(result.dataErrors.join(" ")).toContain(`Matter ${matterId}:`);
    expect(result.dataErrors.join(" ")).toContain("Matter metadata exceeds");
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.readdirSync(path.dirname(live)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("rejects persisted matter fields beyond the write caps and canonicalizes valid records", () => {
    const live = path.join(mockedPaths.root, "matters", matterId, "matter.json");
    fs.writeFileSync(
      live,
      JSON.stringify(validMatter({ notes: "n".repeat(MATTER_STORAGE_LIMITS.maxNotesChars + 1) })),
      "utf8"
    );

    expect(listMatters().dataErrors.join(" ")).toContain("notes are too long");
    expect(fs.existsSync(live)).toBe(true);

    fs.writeFileSync(live, JSON.stringify(validMatter({ ignored: "do not expose" })), "utf8");
    expect(getMatter(matterId)).toEqual(validMatter());
  });

  it("rejects a link-like matter metadata leaf without following it", () => {
    const live = path.join(mockedPaths.root, "matters", matterId, "matter.json");
    const external = path.join(mockedPaths.root, "external-matter-json");
    fs.unlinkSync(live);
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "secret.json"), JSON.stringify(validMatter()), "utf8");
    linkDirectory(external, live);

    expect(() => getMatter(matterId)).toThrow("not a regular file");
    expect(fs.existsSync(path.join(external, "secret.json"))).toBe(true);
  });
});

describe("document deletion containment", () => {
  it("rejects a Windows-style documents-root junction without deleting its target", () => {
    const documents = path.join(mockedPaths.root, "matters", matterId, "documents");
    const external = path.join(mockedPaths.root, "external-documents-delete");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "victim.txt"), "must survive", "utf8");
    linkDirectory(external, documents);

    expect(() => deleteDocument(matterId, "victim.txt")).toThrow("not a trusted directory");
    expect(fs.readFileSync(path.join(external, "victim.txt"), "utf8")).toBe("must survive");
  });

  it("rejects a file reached through an out-of-root directory junction", () => {
    const documents = path.join(mockedPaths.root, "matters", matterId, "documents");
    const external = path.join(mockedPaths.root, "external");
    fs.mkdirSync(documents, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "victim.txt"), "must survive", "utf8");
    fs.symlinkSync(external, path.join(documents, "linked"), process.platform === "win32" ? "junction" : "dir");

    expect(() => deleteDocument(matterId, "linked/victim.txt")).toThrow(
      "resolves outside"
    );
    expect(fs.readFileSync(path.join(external, "victim.txt"), "utf8")).toBe("must survive");
  });

  it("rejects a file reached through a Windows-style matter junction", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-matter-document-delete");
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(path.join(external, "documents"), { recursive: true });
    fs.writeFileSync(path.join(external, "matter.json"), JSON.stringify(validMatter()), "utf8");
    fs.writeFileSync(path.join(external, "documents", "victim.txt"), "must survive", "utf8");
    linkDirectory(external, matter);

    expect(() => deleteDocument(matterId, "victim.txt")).toThrow("not a trusted directory");
    expect(fs.readFileSync(path.join(external, "documents", "victim.txt"), "utf8")).toBe(
      "must survive"
    );
  });

  it("allows a valid in-root filename that begins with two dots", () => {
    const documents = path.join(mockedPaths.root, "matters", matterId, "documents");
    fs.mkdirSync(documents, { recursive: true });
    fs.writeFileSync(path.join(documents, "..notes.txt"), "notes", "utf8");

    expect(deleteDocument(matterId, "..notes.txt")).toEqual({ deleted: "..notes.txt" });
    expect(fs.existsSync(path.join(documents, "..notes.txt"))).toBe(false);
  });

  it("does not unlink a document when the pre-delete metadata update fails", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const documents = path.join(matter, "documents");
    const target = path.join(documents, "evidence.txt");
    const metadata = path.join(matter, "matter.json");
    fs.mkdirSync(documents, { recursive: true });
    fs.writeFileSync(target, "must remain", "utf8");

    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(metadata)) {
        throw new Error("injected metadata publication failure");
      }
      return originalRename(source, destination);
    });

    expect(() => deleteDocument(matterId, "evidence.txt")).toThrow(
      "injected metadata publication failure"
    );
    expect(fs.readFileSync(target, "utf8")).toBe("must remain");
  });
});

describe("matter metadata recovery", () => {
  it("rejects a matter junction without restoring metadata outside matters", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-matter-restore");
    const damaged = "{broken live";
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "matter.json"), damaged, "utf8");
    fs.writeFileSync(
      path.join(external, "matter.json.bak"),
      JSON.stringify(validMatter()),
      "utf8"
    );
    linkDirectory(external, matter);

    const result = restoreMatterMeta(matterId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a trusted directory");
    expect(fs.readFileSync(path.join(external, "matter.json"), "utf8")).toBe(damaged);
    expect(fs.readdirSync(external).some((name) => name.includes(".restore-tmp-"))).toBe(false);
  });

  it("falls back to an older valid copy without mutating an invalid candidate", () => {
    const dir = path.join(mockedPaths.root, "matters", matterId);
    const live = path.join(dir, "matter.json");
    const valid = fs.readFileSync(live, "utf8");
    fs.unlinkSync(live);
    fs.writeFileSync(`${live}.corrupt-100`, valid, "utf8");
    fs.writeFileSync(`${live}.corrupt-200`, "{malformed", "utf8");

    const result = restoreMatterMeta(matterId);

    expect(result.ok).toBe(true);
    expect(result.restoredFrom).toContain("corrupt-100");
    expect(JSON.parse(fs.readFileSync(live, "utf8"))).toMatchObject({ id: matterId });
    expect(fs.readFileSync(`${live}.corrupt-200`, "utf8")).toBe("{malformed");
  });

  it("skips an oversized recovery candidate without reading or mutating it", () => {
    const dir = path.join(mockedPaths.root, "matters", matterId);
    const live = path.join(dir, "matter.json");
    const valid = fs.readFileSync(live, "utf8");
    const oversized = `${live}.corrupt-200`;
    fs.unlinkSync(live);
    fs.writeFileSync(`${live}.corrupt-100`, valid, "utf8");
    fs.writeFileSync(
      oversized,
      "x".repeat(MATTER_STORAGE_LIMITS.maxMatterJsonBytes + 1),
      "utf8"
    );

    const result = restoreMatterMeta(matterId);

    expect(result).toMatchObject({ ok: true, restoredFrom: "matter.json.corrupt-100" });
    expect(fs.statSync(oversized).size).toBe(MATTER_STORAGE_LIMITS.maxMatterJsonBytes + 1);
    expect(JSON.parse(fs.readFileSync(live, "utf8"))).toMatchObject({ id: matterId });
  });

  it("refuses to roll a valid live record back to an older backup", () => {
    const live = path.join(mockedPaths.root, "matters", matterId, "matter.json");
    fs.writeFileSync(
      `${live}.bak`,
      JSON.stringify(validMatter({ caption: "Older caption" })),
      "utf8"
    );

    expect(restoreMatterMeta(matterId)).toEqual({
      ok: false,
      error: "The live matter metadata is valid; restore is not needed.",
    });
    expect(JSON.parse(fs.readFileSync(live, "utf8"))).toMatchObject({
      caption: "Test matter",
    });
  });

  it.each([
    ["malformed", "{broken metadata"],
    ["semantically invalid", JSON.stringify({ id: matterId, caption: 42 })],
  ])("preserves a %s live record before atomically restoring its backup", (_label, damaged) => {
    const dir = path.join(mockedPaths.root, "matters", matterId);
    const live = path.join(dir, "matter.json");
    fs.writeFileSync(`${live}.bak`, JSON.stringify(validMatter()), "utf8");
    fs.writeFileSync(live, damaged, "utf8");

    const result = restoreMatterMeta(matterId);

    expect(result).toMatchObject({ ok: true, matter: { id: matterId } });
    expect(JSON.parse(fs.readFileSync(live, "utf8"))).toMatchObject({ id: matterId });
    const preserved = fs
      .readdirSync(dir)
      .find((name) => name.startsWith("matter.json.corrupt-"));
    expect(preserved).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, preserved!), "utf8")).toBe(damaged);
    expect(fs.readdirSync(dir).some((name) => name.includes(".restore-tmp-"))).toBe(false);
  });

  it("rolls the damaged live file back and cleans its temp when final rename fails", () => {
    const dir = path.join(mockedPaths.root, "matters", matterId);
    const live = path.join(dir, "matter.json");
    const damaged = "{broken metadata";
    fs.writeFileSync(`${live}.bak`, JSON.stringify(validMatter()), "utf8");
    fs.writeFileSync(live, damaged, "utf8");
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(source).includes(".restore-tmp-") && path.resolve(String(destination)) === path.resolve(live)) {
        throw Object.assign(new Error("injected final rename failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    const result = restoreMatterMeta(matterId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("injected final rename failure");
    expect(fs.readFileSync(live, "utf8")).toBe(damaged);
    expect(fs.readFileSync(`${live}.bak`, "utf8")).toBe(JSON.stringify(validMatter()));
    expect(fs.readdirSync(dir).some((name) => name.includes(".restore-tmp-"))).toBe(false);
  });

  it("leaves the live file and every invalid recovery candidate untouched", () => {
    const live = path.join(mockedPaths.root, "matters", matterId, "matter.json");
    const damaged = "{broken live";
    fs.writeFileSync(live, damaged, "utf8");
    fs.writeFileSync(`${live}.bak`, "{broken backup", "utf8");
    fs.writeFileSync(`${live}.corrupt-100`, JSON.stringify({ id: matterId }), "utf8");

    const result = restoreMatterMeta(matterId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No valid matter metadata backup found");
    expect(fs.readFileSync(live, "utf8")).toBe(damaged);
    expect(fs.readFileSync(`${live}.bak`, "utf8")).toBe("{broken backup");
    expect(fs.readFileSync(`${live}.corrupt-100`, "utf8")).toBe(JSON.stringify({ id: matterId }));
  });
});

describe("saved people validation", () => {
  it("rejects a matter junction before a corrupt personas read can mutate its target", () => {
    const matter = path.join(mockedPaths.root, "matters", matterId);
    const external = path.join(mockedPaths.root, "external-personas-read");
    const externalPersonas = path.join(external, "personas.json");
    fs.rmSync(matter, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "matter.json"), JSON.stringify(validMatter()), "utf8");
    fs.writeFileSync(externalPersonas, "{broken personas", "utf8");
    linkDirectory(external, matter);

    expect(() => listPersonas(matterId)).toThrow("Matter directory is not a trusted directory");
    expect(fs.readFileSync(externalPersonas, "utf8")).toBe("{broken personas");
    expect(fs.readdirSync(external).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("rejects a non-array personas file without overwriting it", () => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    fs.writeFileSync(file, JSON.stringify({ unexpected: true }), "utf8");

    expect(() => listPersonas(matterId)).toThrow("expected a list of people");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ unexpected: true });
  });

  it("rejects oversized people metadata before reading and leaves it untouched", () => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    fs.writeFileSync(
      file,
      "x".repeat(MATTER_STORAGE_LIMITS.maxPersonasJsonBytes + 1),
      "utf8"
    );
    const read = vi.spyOn(fs, "readSync");

    expect(() => listPersonas(matterId)).toThrow("Saved people metadata exceeds");
    expect(read).not.toHaveBeenCalled();
    expect(fs.statSync(file).size).toBe(MATTER_STORAGE_LIMITS.maxPersonasJsonBytes + 1);
  });

  it("rejects pathological row and keyterm counts without overwriting the record", () => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    const tooManyPeople = Array.from(
      { length: MATTER_STORAGE_LIMITS.maxPersonas + 1 },
      () => null
    );
    fs.writeFileSync(file, JSON.stringify(tooManyPeople), "utf8");
    expect(() => listPersonas(matterId)).toThrow("cannot contain more than");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(tooManyPeople.length);

    const tooManyKeyterms = Array.from(
      { length: MATTER_STORAGE_LIMITS.maxKeyterms + 1 },
      (_, index) => `term-${index}`
    );
    fs.writeFileSync(file, JSON.stringify([validPersona({ keyterms: tooManyKeyterms })]), "utf8");
    expect(() => listPersonas(matterId)).toThrow("too many keyterms");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))[0].keyterms).toHaveLength(
      tooManyKeyterms.length
    );
  });

  it.each([
    ["name", { fullName: "n".repeat(MATTER_STORAGE_LIMITS.maxNameChars + 1) }],
    ["notes", { notes: "n".repeat(MATTER_STORAGE_LIMITS.maxNotesChars + 1) }],
    ["keyterm", { keyterms: ["k".repeat(MATTER_STORAGE_LIMITS.maxKeytermChars + 1)] }],
    ["voice", { voice: "v".repeat(MATTER_STORAGE_LIMITS.maxVoiceChars + 1) }],
    ["createdAt", { createdAt: "not-a-date" }],
    ["non-text role", { role: 42 }],
    ["attitude", { attitude: "combative" }],
  ])("rejects an invalid persisted persona %s field", (_label, overrides) => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    fs.writeFileSync(file, JSON.stringify([validPersona(overrides)]), "utf8");
    const original = fs.readFileSync(file, "utf8");

    expect(() => listPersonas(matterId)).toThrow("Invalid personas.json");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("prevents savePersona from creating an unreadable over-count record", () => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    const people = Array.from({ length: MATTER_STORAGE_LIMITS.maxPersonas }, (_, index) =>
      validPersona({
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      })
    );
    fs.writeFileSync(file, JSON.stringify(people), "utf8");

    expect(() =>
      savePersona(matterId, {
        fullName: "One too many",
        role: "Witness",
        attitude: "neutral",
        notes: "",
        keyterms: [],
        voice: "eve",
      })
    ).toThrow(`more than ${MATTER_STORAGE_LIMITS.maxPersonas} people`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(
      MATTER_STORAGE_LIMITS.maxPersonas
    );
  });

  it("checks the exact pretty-printed byte size before rewriting people metadata", () => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    const notes = "漢".repeat(5_500);
    const people = Array.from({ length: MATTER_STORAGE_LIMITS.maxPersonas }, (_, index) =>
      validPersona({
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        notes,
      })
    );
    const compact = JSON.stringify(people);
    const pretty = JSON.stringify(people, null, 2);
    expect(Buffer.byteLength(compact, "utf8")).toBeLessThanOrEqual(
      MATTER_STORAGE_LIMITS.maxPersonasJsonBytes
    );
    expect(Buffer.byteLength(pretty, "utf8")).toBeGreaterThan(
      MATTER_STORAGE_LIMITS.maxPersonasJsonBytes
    );
    fs.writeFileSync(file, compact, "utf8");

    expect(() =>
      savePersona(matterId, {
        id: people[0]!.id,
        fullName: people[0]!.fullName,
        role: people[0]!.role,
        attitude: "neutral",
        notes,
        keyterms: people[0]!.keyterms,
        voice: people[0]!.voice,
      })
    ).toThrow("Saved people metadata exceeds");
    expect(fs.readFileSync(file, "utf8")).toBe(compact);
    expect(listPersonas(matterId)).toHaveLength(MATTER_STORAGE_LIMITS.maxPersonas);
  });

  it("rejects a link-like personas leaf without reading its target", () => {
    const file = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    const external = path.join(mockedPaths.root, "external-personas-json");
    fs.mkdirSync(external);
    linkDirectory(external, file);

    expect(() => listPersonas(matterId)).toThrow("not a regular file");
    expect(fs.readdirSync(external)).toEqual([]);
  });
});

describe("audit hardening regressions", () => {
  it("keeps a completed import when only the matter timestamp update fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = path.join(mockedPaths.root, "evidence.txt");
    fs.writeFileSync(source, "evidence body", "utf8");
    const metaPath = path.join(mockedPaths.root, "matters", matterId, "matter.json");
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (path.resolve(String(to)) === path.resolve(metaPath)) {
        throw Object.assign(new Error("matter.json is locked"), { code: "EPERM" });
      }
      return originalRename(from, to);
    });

    expect(importFiles(matterId, [source])).toEqual(["evidence.txt"]);
    expect(documentsEntries()).toEqual(["evidence.txt"]);
    expect(warn).toHaveBeenCalled();
  });

  it("sanitizes Windows-reserved and unstorable import names", () => {
    expect(sanitizeImportLeafName("con.pdf")).toBe("_con.pdf");
    expect(sanitizeImportLeafName("NUL.txt")).toBe("_NUL.txt");
    expect(sanitizeImportLeafName("COM1")).toBe("_COM1");
    expect(sanitizeImportLeafName("depo.pdf.")).toBe("depo.pdf");
    expect(sanitizeImportLeafName("depo.pdf   ")).toBe("depo.pdf");
    expect(sanitizeImportLeafName('bad<file>"name.txt')).toBe("bad_file__name.txt");
    expect(sanitizeImportLeafName("...")).toBe("document");
    expect(sanitizeImportLeafName("Gaudino Deposition Transcript.pdf")).toBe(
      "Gaudino Deposition Transcript.pdf"
    );
    expect(sanitizeImportLeafName("25.11.04 Gaudino - Full Profile.docx")).toBe(
      "25.11.04 Gaudino - Full Profile.docx"
    );
  });

  it("surfaces a junction where a matter directory belongs instead of hiding the matter", () => {
    const linkId = "33333333-3333-4333-8333-333333333333";
    const external = path.join(mockedPaths.root, "external-matter");
    fs.mkdirSync(external);
    linkDirectory(external, path.join(mockedPaths.root, "matters", linkId));

    const listed = listMatters();
    expect(listed.matters.map((m) => m.id)).toEqual([matterId]);
    expect(
      listed.dataErrors.some(
        (message) =>
          message.includes(linkId) && message.includes("not a trusted matter directory")
      )
    ).toBe(true);
  });

  it("does not rewrite the people file or bump the matter for an absent persona", () => {
    const personasFile = path.join(mockedPaths.root, "matters", matterId, "personas.json");
    fs.writeFileSync(personasFile, JSON.stringify([validPersona()]), "utf8");
    const personasBefore = fs.readFileSync(personasFile, "utf8");
    const matterBefore = fs.readFileSync(
      path.join(mockedPaths.root, "matters", matterId, "matter.json"),
      "utf8"
    );

    deletePersona(matterId, "44444444-4444-4444-8444-444444444444");

    expect(fs.readFileSync(personasFile, "utf8")).toBe(personasBefore);
    expect(
      fs.readFileSync(path.join(mockedPaths.root, "matters", matterId, "matter.json"), "utf8")
    ).toBe(matterBefore);

    deletePersona(matterId, validPersona().id as string);
    expect(listPersonas(matterId)).toEqual([]);
  });

  it("removes the partial matter skeleton when creation fails midway", () => {
    const originalMkdir = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
      if (String(target).endsWith("sessions")) {
        throw Object.assign(new Error("injected sessions mkdir failure"), { code: "EPERM" });
      }
      return originalMkdir(target, options);
    }) as typeof fs.mkdirSync);

    expect(() => createMatter({ caption: "Partial matter" })).toThrow(
      "injected sessions mkdir failure"
    );
    vi.restoreAllMocks();

    const roots = fs.readdirSync(path.join(mockedPaths.root, "matters"));
    expect(roots).toEqual([matterId]);
    expect(listMatters().dataErrors).toEqual([]);
  });
});
