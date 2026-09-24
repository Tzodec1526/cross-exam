// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedPaths = vi.hoisted(() => ({
  root: "",
  existingMatters: new Set<string>(),
  blockedMatters: new Set<string>(),
  blockedDocuments: new Set<string>(),
}));
const fsutilCalls = vi.hoisted(() => ({ readJson: vi.fn(), writeJson: vi.fn() }));

vi.mock("../electron/paths.js", () => ({
  documentsDir: (id: string) => path.join(mockedPaths.root, id, "documents"),
  indexPath: (id: string) => path.join(mockedPaths.root, id, "index.json"),
}));

vi.mock("../electron/services/matters.js", () => ({
  assertTrustedIndexPath: (matterId: string) => {
    if (mockedPaths.blockedMatters.has(matterId)) {
      throw new Error("Matter directory is not a trusted directory");
    }
    if (!mockedPaths.existingMatters.has(matterId)) throw new Error("Matter not found");
    return path.join(mockedPaths.root, matterId, "index.json");
  },
  findTrustedIndexPath: (matterId: string) => {
    if (mockedPaths.blockedMatters.has(matterId)) {
      throw new Error("Matter directory is not a trusted directory");
    }
    return mockedPaths.existingMatters.has(matterId)
      ? path.join(mockedPaths.root, matterId, "index.json")
      : null;
  },
  assertTrustedDocumentsDirectory: (matterId: string) => {
    if (mockedPaths.blockedDocuments.has(matterId)) {
      throw new Error("Matter documents folder is not a trusted directory");
    }
    return path.join(mockedPaths.root, matterId, "documents");
  },
  getMatter: (matterId: string) =>
    mockedPaths.existingMatters.has(matterId) ? { id: matterId } : null,
  touchMatter: vi.fn(),
}));

vi.mock("../electron/services/fsutil.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../electron/services/fsutil")>();
  return {
    ...actual,
    readJson: <T>(
      file: string,
      fallback: T,
      options?: Parameters<typeof actual.readJson>[2]
    ): T => {
      fsutilCalls.readJson(file, options);
      return actual.readJson(file, fallback, options);
    },
    writeJson: (...args: Parameters<typeof actual.writeJson>): void => {
      fsutilCalls.writeJson(args[0], args[2]);
      actual.writeJson(...args);
    },
  };
});

import {
  beginIndexInvalidation,
  cancelReindex,
  discardIndex,
  getDocumentExcerpt,
  getPriorTestimony,
  INDEX_LIMITS,
  INDEX_STORAGE_LIMITS,
  invalidateSearchCache,
  loadIndex,
  preflightDocxArchive,
  reindexMatter,
  resolveIndexedDocument,
  SEARCH_INPUT_LIMITS,
  searchCaseRecord,
} from "../electron/services/indexer";

const matterId = "11111111-1111-4111-8111-111111111111";
const cacheMatterIds = [
  matterId,
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

function documentsDir(id = matterId): string {
  return path.join(mockedPaths.root, id, "documents");
}

function zipCentralDirectory(
  entries: Array<{ compressedBytes: number; uncompressedBytes: number }>
): Buffer {
  const centralEntries = entries.map((entry, index) => {
    const fileName = Buffer.from(`word/item-${index}.xml`, "utf8");
    const record = Buffer.alloc(46 + fileName.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(entry.compressedBytes, 20);
    record.writeUInt32LE(entry.uncompressedBytes, 24);
    record.writeUInt16LE(fileName.length, 28);
    fileName.copy(record, 46);
    return record;
  });
  const central = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([central, end]);
}

function pdfWithEmptyPages(pageCount: number): Buffer {
  const contentId = pageCount + 3;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from(
      { length: pageCount },
      (_, index) => `${index + 3} 0 R`
    ).join(" ")}] >>`,
    ...Array.from(
      { length: pageCount },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R >>`
    ),
    "<< /Length 0 >>\nstream\n\nendstream",
  ];

  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

beforeEach(() => {
  mockedPaths.root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-exam-indexer-"));
  mockedPaths.existingMatters = new Set(cacheMatterIds);
  mockedPaths.blockedMatters = new Set();
  mockedPaths.blockedDocuments = new Set();
  fs.mkdirSync(documentsDir(), { recursive: true });
  fsutilCalls.readJson.mockClear();
  fsutilCalls.writeJson.mockClear();
  for (const id of cacheMatterIds) invalidateSearchCache(id);
});

afterEach(() => {
  for (const id of cacheMatterIds) invalidateSearchCache(id);
  fs.rmSync(mockedPaths.root, { recursive: true, force: true });
});

describe("resilient matter indexing", () => {
  it("does not create an invalidation marker for an unknown matter", () => {
    const unknownMatterId = "55555555-5555-4555-8555-555555555555";

    expect(() => discardIndex(unknownMatterId)).toThrow("Matter not found");
    expect(fs.existsSync(path.join(mockedPaths.root, unknownMatterId))).toBe(false);
  });

  it("refuses an untrusted documents directory before reading or writing evidence", async () => {
    fs.writeFileSync(path.join(documentsDir(), "outside.txt"), "external secret", "utf8");
    mockedPaths.blockedDocuments.add(matterId);

    await expect(reindexMatter(matterId)).rejects.toThrow("not a trusted directory");
    expect(fs.existsSync(path.join(mockedPaths.root, matterId, "index.json"))).toBe(false);
  });

  it("commits valid documents when another imported file has no extractable text", async () => {
    fs.writeFileSync(
      path.join(documentsDir(), "admission.txt"),
      "The witness approved the reserve transfer on April 3.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(documentsDir(), "scanned.bin"),
      Buffer.from([0, 1, 2, 3])
    );

    const result = await reindexMatter(matterId);

    expect(result.documentCount).toBe(1);
    expect(result.documents[0]?.fileName).toBe("admission.txt");
    expect(result.issues).toEqual([
      expect.objectContaining({
        fileName: "scanned.bin",
        message: expect.stringContaining("No extractable text"),
      }),
    ]);
    expect(searchCaseRecord(matterId, "reserve transfer")[0]?.fileName).toBe("admission.txt");
  });

  it("persists the derived index with a byte bound and without reading or backing up the old index", async () => {
    const evidence = path.join(documentsDir(), "version.txt");
    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    fs.writeFileSync(evidence, "first version evidence", "utf8");
    await reindexMatter(matterId);
    fs.writeFileSync(evidence, "second version evidence", "utf8");
    fsutilCalls.writeJson.mockClear();
    const readSpy = vi.spyOn(fs, "readFileSync");

    await reindexMatter(matterId);

    expect(fsutilCalls.writeJson).toHaveBeenCalledWith(indexFile, {
      backup: false,
      maxBytes: INDEX_STORAGE_LIMITS.maxJsonBytes,
      label: "Case record index",
    });
    expect(
      readSpy.mock.calls.some(([target]) => path.resolve(String(target)) === path.resolve(indexFile))
    ).toBe(false);
    expect(fs.existsSync(`${indexFile}.bak`)).toBe(false);
  });

  it("skips oversized files without reading them or aborting the rebuild", async () => {
    const oversized = path.join(documentsDir(), "oversized.txt");
    fs.writeFileSync(oversized, "x", "utf8");
    fs.truncateSync(oversized, INDEX_LIMITS.maxFileBytes + 1);
    fs.writeFileSync(path.join(documentsDir(), "usable.txt"), "usable evidence", "utf8");
    const openSpy = vi.spyOn(fs.promises, "open");

    const result = await reindexMatter(matterId);

    expect(result.documents.map((document) => document.fileName)).toEqual(["usable.txt"]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        fileName: "oversized.txt",
        message: expect.stringContaining("per-file indexing limit"),
      }),
    ]);
    expect(
      openSpy.mock.calls.some(
        ([file]) => path.resolve(String(file)) === path.resolve(oversized)
      )
    ).toBe(false);
  });

  it("caps PDF page parsing before extracted-text limits are evaluated", async () => {
    const pdf = path.join(documentsDir(), "too-many-pages.pdf");
    fs.writeFileSync(pdf, pdfWithEmptyPages(INDEX_LIMITS.maxPdfPages + 1));

    const result = await reindexMatter(matterId);

    expect(result.documentCount).toBe(0);
    expect(result.issues).toEqual([
      expect.objectContaining({
        fileName: "too-many-pages.pdf",
        message: expect.stringContaining(
          `indexing limit is ${INDEX_LIMITS.maxPdfPages.toLocaleString()} pages`
        ),
      }),
    ]);
  });

  it("rejects a DOCX central directory with too many entries", () => {
    const archive = zipCentralDirectory(
      Array.from({ length: INDEX_LIMITS.maxDocxEntries + 1 }, () => ({
        compressedBytes: 1,
        uncompressedBytes: 1,
      }))
    );

    expect(() => preflightDocxArchive(archive)).toThrow(
      `limit is ${INDEX_LIMITS.maxDocxEntries.toLocaleString()}`
    );
  });

  it("rejects oversized DOCX entries and aggregate expansion", () => {
    expect(() =>
      preflightDocxArchive(
        zipCentralDirectory([
          {
            compressedBytes: INDEX_LIMITS.maxDocxEntryUncompressedBytes + 1,
            uncompressedBytes: INDEX_LIMITS.maxDocxEntryUncompressedBytes + 1,
          },
        ])
      )
    ).toThrow("per-entry limit");

    const entryBytes = INDEX_LIMITS.maxDocxEntryUncompressedBytes;
    expect(() =>
      preflightDocxArchive(
        zipCentralDirectory(
          Array.from({ length: 5 }, () => ({
            compressedBytes: entryBytes,
            uncompressedBytes: entryBytes,
          }))
        )
      )
    ).toThrow("aggregate limit");
  });

  it("rejects a deflate stream whose real size disagrees with the central directory", () => {
    const payload = Buffer.from("A".repeat(8_000));
    const compressed = zlib.deflateRawSync(payload);
    const name = Buffer.from("word/document.xml");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const localHeader = Buffer.concat([local, compressed]);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    name.copy(central, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(localHeader.length, 16);

    expect(() => preflightDocxArchive(Buffer.concat([localHeader, central, end]))).toThrow(
      /expansion-ratio|uncompressed size/i
    );
  });

  it("rejects excessive DOCX compression ratios before Mammoth extraction", async () => {
    fs.writeFileSync(
      path.join(documentsDir(), "compressed-bomb.docx"),
      zipCentralDirectory([
        {
          compressedBytes: 1,
          uncompressedBytes: INDEX_LIMITS.maxDocxCompressionRatio + 1,
        },
      ])
    );

    const result = await reindexMatter(matterId);

    expect(result.documentCount).toBe(0);
    expect(result.issues[0]?.message).toContain(
      `${INDEX_LIMITS.maxDocxCompressionRatio}:1 expansion-ratio limit`
    );
  });

  it("reuses the parsed index for repeated searches until invalidated", async () => {
    fs.writeFileSync(
      path.join(documentsDir(), "testimony.txt"),
      "The liability admission appears in this testimony.",
      "utf8"
    );
    await reindexMatter(matterId);

    expect(searchCaseRecord(matterId, "liability admission")).toHaveLength(1);
    const readsAfterFirstSearch = fsutilCalls.readJson.mock.calls.length;
    expect(readsAfterFirstSearch).toBeGreaterThan(0);

    expect(searchCaseRecord(matterId, "testimony")).toHaveLength(1);
    expect(fsutilCalls.readJson.mock.calls.length).toBe(readsAfterFirstSearch);
  });

  it("rejects malformed search and excerpt inputs before reading the index", async () => {
    fs.writeFileSync(path.join(documentsDir(), "bounded.txt"), "bounded evidence", "utf8");
    await reindexMatter(matterId);
    invalidateSearchCache(matterId);
    fsutilCalls.readJson.mockClear();

    expect(() => searchCaseRecord(matterId, null as never)).toThrow(
      "Search query must be text"
    );
    expect(() =>
      searchCaseRecord(matterId, "x".repeat(SEARCH_INPUT_LIMITS.queryChars + 1))
    ).toThrow("Search query exceeds");
    expect(() =>
      searchCaseRecord(matterId, "bounded", { docType: "not-a-document-type" })
    ).toThrow("Document type filter is invalid");
    expect(() =>
      searchCaseRecord(matterId, "bounded", { maxResults: "8" as never })
    ).toThrow("Search result count must be a positive number");
    expect(() => getDocumentExcerpt(matterId, null as never)).toThrow(
      "Document excerpt arguments must be an object"
    );
    expect(() => getDocumentExcerpt(matterId, {})).toThrow(
      "Document id or filename is required"
    );
    expect(fsutilCalls.readJson).not.toHaveBeenCalled();
  });

  it("treats witness and document-type filters as authoritative", async () => {
    fs.writeFileSync(
      path.join(documentsDir(), "Bob Smith Deposition.txt"),
      "Shared liability admission that mentions Alice Jones.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(documentsDir(), "Alice Jones Deposition.txt"),
      "Shared liability admission. ".repeat(120),
      "utf8"
    );
    fs.writeFileSync(
      path.join(documentsDir(), "Joanne Smith Deposition.txt"),
      "Shared liability admission from a different witness.",
      "utf8"
    );
    await reindexMatter(matterId);

    const bob = searchCaseRecord(matterId, "shared liability admission", {
      witnessName: "Bob Smith",
    });
    expect(bob).toHaveLength(1);
    expect(bob.every((hit) => hit.fileName === "Bob Smith Deposition.txt")).toBe(true);

    const alice = searchCaseRecord(matterId, "Alice Jones", {
      witnessName: "Alice Jones",
    });
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((hit) => hit.fileName === "Alice Jones Deposition.txt")).toBe(true);
    expect(
      searchCaseRecord(matterId, "shared liability admission", {
        witnessName: "Missing Witness",
      })
    ).toEqual([]);
    expect(
      searchCaseRecord(matterId, "shared liability admission", { witnessName: "Ann" })
    ).toEqual([]);
    expect(
      searchCaseRecord(matterId, "shared liability admission", { docType: "timeline" })
    ).toEqual([]);
  });

  it("rejects ambiguous excerpt filenames and mismatched selectors", async () => {
    fs.writeFileSync(
      path.join(documentsDir(), "Alice Jones Deposition.txt"),
      "Alice excerpt evidence",
      "utf8"
    );
    fs.writeFileSync(
      path.join(documentsDir(), "Bob Smith Deposition.txt"),
      "Bob excerpt evidence",
      "utf8"
    );
    const result = await reindexMatter(matterId);
    const alice = result.documents.find(
      (document) => document.fileName === "Alice Jones Deposition.txt"
    )!;
    const bob = result.documents.find(
      (document) => document.fileName === "Bob Smith Deposition.txt"
    )!;

    expect(() => getDocumentExcerpt(matterId, { fileName: "Deposition" })).toThrow(
      "Document filename is ambiguous"
    );
    const exactExcerpt = getDocumentExcerpt(matterId, {
      fileName: "alice jones deposition.txt",
    });
    expect(exactExcerpt.length).toBeGreaterThan(0);
    expect(exactExcerpt.every((hit) => hit.fileName === alice.fileName)).toBe(true);
    expect(() =>
      getDocumentExcerpt(matterId, {
        documentId: bob.id,
        fileName: alice.fileName,
      })
    ).toThrow("identify different documents");
  });

  it("keeps valid prior-testimony inputs within the downstream query budget", async () => {
    fs.writeFileSync(
      path.join(documentsDir(), "Bounded Witness Deposition.txt"),
      "bounded testimony topic",
      "utf8"
    );
    await reindexMatter(matterId);
    const witnessName = "W".repeat(SEARCH_INPUT_LIMITS.witnessNameChars);
    const maxTopic =
      SEARCH_INPUT_LIMITS.queryChars -
      witnessName.length -
      "deposition testimony".length -
      2;

    expect(() =>
      getPriorTestimony(matterId, { witnessName, topic: "t".repeat(maxTopic) })
    ).not.toThrow();
    expect(() =>
      getPriorTestimony(matterId, { witnessName, topic: "t".repeat(maxTopic + 1) })
    ).toThrow(`Testimony topic exceeds the ${maxTopic}-character limit`);
  });

  it("never serves a discarded index even when the stale file cannot be unlinked", async () => {
    fs.writeFileSync(path.join(documentsDir(), "deleted.txt"), "deleted admission", "utf8");
    await reindexMatter(matterId);
    expect(searchCaseRecord(matterId, "deleted admission")).toHaveLength(1);

    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(indexFile)) {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      }
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    discardIndex(matterId);

    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(`${indexFile}.discarded`)).toBe(true);
    expect(beginIndexInvalidation(matterId)).toBe(false);
    expect(searchCaseRecord(matterId, "deleted admission")).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    unlinkSpy.mockRestore();

    // A fresh module has no in-memory tombstone, which simulates the relevant
    // part of an app restart. The durable marker must still hide the stale file.
    vi.resetModules();
    const restartedIndexer = await import("../electron/services/indexer");
    expect(restartedIndexer.searchCaseRecord(matterId, "deleted admission")).toEqual([]);

    await reindexMatter(matterId);
    expect(fs.existsSync(`${indexFile}.discarded`)).toBe(false);
    expect(searchCaseRecord(matterId, "deleted admission")).toHaveLength(1);
  });

  it("removes the exact live and backup index even when artifact enumeration fails", async () => {
    fs.writeFileSync(path.join(documentsDir(), "private.txt"), "private evidence", "utf8");
    await reindexMatter(matterId);
    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    fs.copyFileSync(indexFile, `${indexFile}.bak`);
    const openSpy = vi.spyOn(fs, "opendirSync").mockImplementation(() => {
      throw new Error("directory enumeration unavailable");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    discardIndex(matterId);

    expect(fs.existsSync(indexFile)).toBe(false);
    expect(fs.existsSync(`${indexFile}.bak`)).toBe(false);
    expect(fs.existsSync(`${indexFile}.discarded`)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    openSpy.mockRestore();
    warnSpy.mockRestore();
    await reindexMatter(matterId);
  });

  it("leaves malformed derived JSON in place and repairs it through a no-backup rebuild", async () => {
    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    fs.writeFileSync(indexFile, "{broken index", "utf8");

    expect(() => loadIndex(matterId)).toThrow("original left in place");
    expect(fs.readFileSync(indexFile, "utf8")).toBe("{broken index");
    expect(fs.readdirSync(path.dirname(indexFile)).some((name) => name.includes(".corrupt-"))).toBe(
      false
    );
    expect(fsutilCalls.readJson).toHaveBeenLastCalledWith(
      indexFile,
      expect.objectContaining({
        maxBytes: INDEX_STORAGE_LIMITS.maxJsonBytes,
        label: "Case record index",
        preserveCorrupt: false,
      })
    );

    fs.writeFileSync(path.join(documentsDir(), "recovered.txt"), "recovered evidence", "utf8");
    await reindexMatter(matterId);

    expect(loadIndex(matterId).documents.map((document) => document.fileName)).toEqual([
      "recovered.txt",
    ]);
    expect(fs.existsSync(`${indexFile}.bak`)).toBe(false);
    expect(fs.readdirSync(path.dirname(indexFile)).some((name) => name.includes(".corrupt-"))).toBe(
      false
    );
  });

  it("rejects semantic index corruption without moving the reconstructable file", async () => {
    fs.writeFileSync(path.join(documentsDir(), "semantic.txt"), "semantic evidence", "utf8");
    await reindexMatter(matterId);
    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    type PersistedIndex = {
      matterId: string;
      builtAt: string;
      documents: Array<Record<string, unknown>>;
      chunks: Array<Record<string, unknown>>;
    };
    const valid = JSON.parse(fs.readFileSync(indexFile, "utf8")) as PersistedIndex;
    const wrongMatterId = "55555555-5555-4555-8555-555555555555";
    const orphan = structuredClone(valid);
    orphan.chunks[0]!.documentId = wrongMatterId;
    const mismatchedMetadata = structuredClone(valid);
    mismatchedMetadata.chunks[0]!.fileName = "different.txt";
    const cases: Array<[unknown, string]> = [
      [{ ...valid, matterId: wrongMatterId }, "matter ownership does not match"],
      [{ ...valid, documents: {} }, "documents are invalid"],
      [orphan, "references an unknown document"],
      [mismatchedMetadata, "chunk metadata does not match"],
    ];

    for (const [value, expectedMessage] of cases) {
      fs.writeFileSync(indexFile, JSON.stringify(value), "utf8");
      expect(() => loadIndex(matterId)).toThrow(expectedMessage);
      expect(fs.existsSync(indexFile)).toBe(true);
      expect(
        fs.readdirSync(path.dirname(indexFile)).some((name) => name.includes(".corrupt-"))
      ).toBe(false);
    }
  });

  it(
    "bounds directory traversal and reports that additional entries were skipped",
    async () => {
      for (let index = 0; index <= INDEX_LIMITS.maxFiles; index += 1) {
        fs.writeFileSync(path.join(documentsDir(), `record-${index}.txt`), `record ${index}`, "utf8");
      }

      const result = await reindexMatter(matterId);

      expect(result.documentCount).toBeLessThanOrEqual(INDEX_LIMITS.maxFiles);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileName: "Additional files",
            message: expect.stringContaining("traversal limit"),
          }),
        ])
      );
    },
    20_000
  );

  it("indexes an in-root filename beginning with two dots", async () => {
    fs.writeFileSync(path.join(documentsDir(), "..notes.txt"), "privileged admission", "utf8");

    const result = await reindexMatter(matterId);

    expect(result.documents.map((document) => document.fileName)).toEqual(["..notes.txt"]);
  });

  it("revokes stale document identities and rejects ambiguous persisted matches", async () => {
    fs.writeFileSync(path.join(documentsDir(), "current.txt"), "current evidence", "utf8");
    const first = await reindexMatter(matterId);
    const staleId = first.documents[0]!.id;

    const second = await reindexMatter(matterId);
    const current = second.documents[0]!;
    expect(current.id).not.toBe(staleId);
    expect(() => resolveIndexedDocument(matterId, staleId)).toThrow(
      "no longer in the current case record"
    );
    expect(resolveIndexedDocument(matterId, current.id).relativePath).toBe("current.txt");

    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    const persisted = JSON.parse(fs.readFileSync(indexFile, "utf8")) as {
      documents: unknown[];
    };
    persisted.documents.push({ ...current });
    fs.writeFileSync(indexFile, JSON.stringify(persisted), "utf8");

    expect(() => resolveIndexedDocument(matterId, current.id)).toThrow(
      "document ids are duplicated"
    );

    persisted.documents = [
      {
        ...current,
        fileName: "Shown.pdf",
        relativePath: "hidden/Other.pdf",
      },
    ];
    fs.writeFileSync(indexFile, JSON.stringify(persisted), "utf8");
    expect(() => resolveIndexedDocument(matterId, current.id)).toThrow(
      "a document path is invalid or duplicated"
    );
  });

  it("evicts the least-recently-used matter from the bounded search cache", async () => {
    for (const [index, id] of cacheMatterIds.entries()) {
      fs.mkdirSync(documentsDir(id), { recursive: true });
      fs.writeFileSync(
        path.join(documentsDir(id), `matter-${index}.txt`),
        `unique evidence ${index}`,
        "utf8"
      );
      await reindexMatter(id);
      expect(searchCaseRecord(id, `evidence ${index}`)).toHaveLength(1);
    }

    const readsBeforeReload = fsutilCalls.readJson.mock.calls.length;
    expect(searchCaseRecord(cacheMatterIds[0]!, "unique evidence")).toHaveLength(1);
    expect(fsutilCalls.readJson.mock.calls.length).toBe(readsBeforeReload + 1);
  });

  it("reloads a same-size atomic index replacement even when its mtime is preserved", async () => {
    fs.writeFileSync(path.join(documentsDir(), "freshness.txt"), "alpha evidence", "utf8");
    await reindexMatter(matterId);

    const indexFile = path.join(mockedPaths.root, matterId, "index.json");
    const stableTime = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 5_000);
    fs.utimesSync(indexFile, stableTime, stableTime);
    const originalStat = fs.statSync(indexFile);
    expect(searchCaseRecord(matterId, "alpha")).toHaveLength(1);
    const persisted = JSON.parse(fs.readFileSync(indexFile, "utf8")) as {
      chunks: Array<{ text: string }>;
    };
    persisted.chunks[0]!.text = persisted.chunks[0]!.text.replace("alpha", "bravo");
    const replacement = `${indexFile}.replacement`;
    const serialized = JSON.stringify(persisted, null, 2);
    expect(Buffer.byteLength(serialized)).toBe(originalStat.size);
    fs.writeFileSync(replacement, serialized, "utf8");
    fs.utimesSync(replacement, originalStat.atime, originalStat.mtime);
    fs.renameSync(replacement, indexFile);
    expect(fs.statSync(indexFile).mtimeMs).toBe(originalStat.mtimeMs);

    const readsBeforeReplacement = fsutilCalls.readJson.mock.calls.length;
    expect(searchCaseRecord(matterId, "bravo")).toHaveLength(1);
    expect(fsutilCalls.readJson.mock.calls.length).toBe(readsBeforeReplacement + 1);
  });

  it("rejects an unknown matter without creating an orphan index directory", async () => {
    const unknown = "55555555-5555-4555-8555-555555555555";

    await expect(reindexMatter(unknown)).rejects.toThrow("Matter not found");

    expect(fs.existsSync(path.join(mockedPaths.root, unknown))).toBe(false);
  });

  it("does not commit extracted evidence after the matter is deleted", async () => {
    const evidence = path.join(documentsDir(), "deleted-matter.txt");
    fs.writeFileSync(evidence, "evidence that must not return", "utf8");
    const originalOpen = fs.promises.open.bind(fs.promises);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let startedRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
      if (path.resolve(String(file)) === path.resolve(evidence)) {
        startedRead();
        await readGate;
      }
      return originalOpen(file, flags, mode);
    });

    const pending = reindexMatter(matterId);
    await readStarted;
    cancelReindex(matterId);
    mockedPaths.existingMatters.delete(matterId);
    fs.rmSync(path.join(mockedPaths.root, matterId), { recursive: true, force: true });
    releaseRead();

    await expect(pending).rejects.toThrow("Index rebuild was cancelled");
    expect(fs.existsSync(path.join(mockedPaths.root, matterId, "index.json"))).toBe(false);
    expect(searchCaseRecord(matterId, "evidence that must not return")).toEqual([]);
  });

  it("stops before extracting another record after a rebuild is cancelled", async () => {
    fs.writeFileSync(path.join(documentsDir(), "first.txt"), "first admission", "utf8");
    fs.writeFileSync(path.join(documentsDir(), "second.txt"), "second admission", "utf8");
    const originalOpen = fs.promises.open.bind(fs.promises);
    const readPaths: string[] = [];
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
      readPaths.push(path.resolve(String(file)));
      if (readPaths.length === 1) {
        markFirstReadStarted();
        await firstReadGate;
      }
      return originalOpen(file, flags, mode);
    });

    const pending = reindexMatter(matterId);
    await firstReadStarted;
    cancelReindex(matterId);
    releaseFirstRead();

    await expect(pending).rejects.toThrow("Index rebuild was cancelled");
    expect(readPaths).toHaveLength(1);
    expect(fs.existsSync(path.join(mockedPaths.root, matterId, "index.json"))).toBe(false);
  });

  it("allows only the newest overlapping rebuild to commit", async () => {
    const evidence = path.join(documentsDir(), "version.txt");
    fs.writeFileSync(evidence, "anachronistic-only proof", "utf8");
    const originalOpen = fs.promises.open.bind(fs.promises);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let readCount = 0;
    vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (path.resolve(String(file)) === path.resolve(evidence)) {
        readCount += 1;
        if (readCount === 1) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            firstStarted();
            await firstGate;
            await close();
          });
        }
      }
      return handle;
    });

    const older = reindexMatter(matterId);
    await firstReadStarted;
    fs.writeFileSync(evidence, "current-only proof", "utf8");
    const newer = await reindexMatter(matterId);
    releaseFirst();

    await expect(older).rejects.toThrow("Index rebuild was cancelled");
    expect(newer.documentCount).toBe(1);
    expect(searchCaseRecord(matterId, "current-only")).toHaveLength(1);
    expect(searchCaseRecord(matterId, "anachronistic")).toEqual([]);
  });

  it("aborts the commit when an already parsed source file changes", async () => {
    fs.writeFileSync(path.join(documentsDir(), "first.txt"), "first stable evidence", "utf8");
    fs.writeFileSync(path.join(documentsDir(), "second.txt"), "second stable evidence", "utf8");
    const originalOpen = fs.promises.open.bind(fs.promises);
    let firstOpenedPath = "";
    let releaseSecondOpen!: () => void;
    const secondOpenGate = new Promise<void>((resolve) => {
      releaseSecondOpen = resolve;
    });
    let markSecondOpenStarted!: () => void;
    const secondOpenStarted = new Promise<void>((resolve) => {
      markSecondOpenStarted = resolve;
    });

    vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
      const openedPath = path.resolve(String(file));
      if (!firstOpenedPath) {
        firstOpenedPath = openedPath;
      } else {
        markSecondOpenStarted();
        await secondOpenGate;
      }
      return originalOpen(file, flags, mode);
    });

    const pending = reindexMatter(matterId);
    await secondOpenStarted;
    fs.writeFileSync(firstOpenedPath, "changed after parsing", "utf8");
    releaseSecondOpen();

    await expect(pending).rejects.toThrow(
      "Source document changed while it was being indexed"
    );
    expect(fs.existsSync(path.join(mockedPaths.root, matterId, "index.json"))).toBe(false);
  });
});
