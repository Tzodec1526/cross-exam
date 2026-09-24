import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import MiniSearch from "minisearch";
import { v4 as uuid } from "uuid";
import type { Chunk, DocumentMeta, SearchResult } from "../types.js";
import { readJson, writeFileAtomic, writeJson } from "./fsutil.js";
import {
  assertTrustedDocumentsDirectory,
  assertTrustedIndexPath,
  findTrustedIndexPath,
  getMatter,
  touchMatter,
} from "./matters.js";

const require = createRequire(import.meta.url);
// pdf-parse is CJS; import implementation path to avoid test-file side effects on load
type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: (options?: {
      normalizeWhitespace?: boolean;
      disableCombineTextItems?: boolean;
    }) => Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
  }>;
  destroy: () => Promise<void> | void;
};

const pdfjs = require("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js") as {
  disableWorker: boolean;
  getDocument: (data: Buffer) => Promise<PdfJsDocument>;
};

const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".rtf"]);
const PDF_EXTS = new Set([".pdf"]);
const DOCX_EXTS = new Set([".docx"]);

/**
 * Keep a malformed or unexpectedly large case file from taking down the whole
 * Electron main process. The limits are deliberately generous for legal records,
 * but finite so one import cannot exhaust memory while the full index is built.
 */
export const INDEX_LIMITS = Object.freeze({
  maxFiles: 500,
  maxEntries: 2_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxPdfPages: 2_000,
  maxDocxEntries: 2_000,
  maxDocxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxDocxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxDocxCompressionRatio: 200,
  maxDocumentChars: 8_000_000,
  maxTotalChars: 20_000_000,
});

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_END_RECORD_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_CENTRAL_ENTRY_BYTES = 46;

function invalidDocxArchive(detail: string): Error {
  return new Error(`DOCX archive is not safe to index: ${detail}`);
}

function findZipEndRecord(contents: Buffer): number {
  if (contents.length < ZIP_END_RECORD_BYTES) {
    throw invalidDocxArchive("the ZIP end record is missing or truncated.");
  }

  const earliest = Math.max(
    0,
    contents.length - ZIP_END_RECORD_BYTES - ZIP_MAX_COMMENT_BYTES
  );
  for (let offset = contents.length - ZIP_END_RECORD_BYTES; offset >= earliest; offset -= 1) {
    if (contents.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentBytes = contents.readUInt16LE(offset + 20);
    if (offset + ZIP_END_RECORD_BYTES + commentBytes === contents.length) return offset;
  }
  throw invalidDocxArchive("the ZIP end record is missing or malformed.");
}

/**
 * Read only fixed-width ZIP metadata before Mammoth is allowed to inflate a
 * DOCX. BigInt arithmetic keeps attacker-controlled size fields from wrapping.
 */
export function preflightDocxArchive(contents: Buffer): void {
  const endOffset = findZipEndRecord(contents);
  const diskNumber = contents.readUInt16LE(endOffset + 4);
  const centralDisk = contents.readUInt16LE(endOffset + 6);
  const entriesOnDisk = contents.readUInt16LE(endOffset + 8);
  const totalEntries = contents.readUInt16LE(endOffset + 10);
  const centralBytes32 = contents.readUInt32LE(endOffset + 12);
  const centralOffset32 = contents.readUInt32LE(endOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw invalidDocxArchive("multi-disk ZIP files are not supported.");
  }
  if (
    totalEntries === 0xffff ||
    centralBytes32 === 0xffffffff ||
    centralOffset32 === 0xffffffff
  ) {
    throw invalidDocxArchive("ZIP64 files are not supported; re-save or split the document.");
  }
  if (totalEntries > INDEX_LIMITS.maxDocxEntries) {
    throw invalidDocxArchive(
      `it contains ${totalEntries.toLocaleString()} entries; the limit is ${INDEX_LIMITS.maxDocxEntries.toLocaleString()}. Remove embedded items or split the document.`
    );
  }

  const archiveBytes = BigInt(contents.length);
  const centralOffset = BigInt(centralOffset32);
  const centralBytes = BigInt(centralBytes32);
  const centralEnd = centralOffset + centralBytes;
  if (
    centralOffset > archiveBytes ||
    centralEnd > archiveBytes ||
    centralEnd !== BigInt(endOffset)
  ) {
    throw invalidDocxArchive("the central-directory bounds are inconsistent.");
  }

  const maxEntryBytes = BigInt(INDEX_LIMITS.maxDocxEntryUncompressedBytes);
  const maxTotalBytes = BigInt(INDEX_LIMITS.maxDocxTotalUncompressedBytes);
  const maxRatio = BigInt(INDEX_LIMITS.maxDocxCompressionRatio);
  let aggregateBytes = 0n;
  let cursor = Number(centralOffset);

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    const fixedEnd = BigInt(cursor) + BigInt(ZIP_CENTRAL_ENTRY_BYTES);
    if (fixedEnd > centralEnd) {
      throw invalidDocxArchive("a central-directory entry is truncated.");
    }
    if (contents.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
      throw invalidDocxArchive("a central-directory entry has an invalid signature.");
    }

    const compressed32 = contents.readUInt32LE(cursor + 20);
    const uncompressed32 = contents.readUInt32LE(cursor + 24);
    const fileNameBytes = contents.readUInt16LE(cursor + 28);
    const extraBytes = contents.readUInt16LE(cursor + 30);
    const commentBytes = contents.readUInt16LE(cursor + 32);
    const startDisk = contents.readUInt16LE(cursor + 34);
    if (
      compressed32 === 0xffffffff ||
      uncompressed32 === 0xffffffff ||
      startDisk === 0xffff
    ) {
      throw invalidDocxArchive("ZIP64 entries are not supported; re-save the document.");
    }
    if (startDisk !== 0) {
      throw invalidDocxArchive("a central-directory entry refers to another disk.");
    }

    const compressedBytes = BigInt(compressed32);
    const uncompressedBytes = BigInt(uncompressed32);
    if (uncompressedBytes > maxEntryBytes) {
      throw invalidDocxArchive(
        `entry ${entryIndex + 1} expands beyond the ${Math.round(
          INDEX_LIMITS.maxDocxEntryUncompressedBytes / 1024 / 1024
        )} MB per-entry limit. Re-save or split the document.`
      );
    }
    aggregateBytes += uncompressedBytes;
    if (aggregateBytes > maxTotalBytes) {
      throw invalidDocxArchive(
        `entries expand beyond the ${Math.round(
          INDEX_LIMITS.maxDocxTotalUncompressedBytes / 1024 / 1024
        )} MB aggregate limit. Remove embedded items or split the document.`
      );
    }
    if (
      uncompressedBytes > 0n &&
      (compressedBytes === 0n || uncompressedBytes > compressedBytes * maxRatio)
    ) {
      throw invalidDocxArchive(
        `entry ${entryIndex + 1} exceeds the ${INDEX_LIMITS.maxDocxCompressionRatio}:1 expansion-ratio limit. Re-save the document.`
      );
    }

    const recordEnd =
      fixedEnd + BigInt(fileNameBytes) + BigInt(extraBytes) + BigInt(commentBytes);
    if (recordEnd > centralEnd) {
      throw invalidDocxArchive("a central-directory entry extends past its declared bounds.");
    }
    cursor = Number(recordEnd);
  }

  if (BigInt(cursor) !== centralEnd) {
    throw invalidDocxArchive("the central-directory entry count does not match its size.");
  }

  cursor = Number(centralOffset);
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    const compressed32 = contents.readUInt32LE(cursor + 20);
    const uncompressed32 = contents.readUInt32LE(cursor + 24);
    const fileNameBytes = contents.readUInt16LE(cursor + 28);
    const extraBytes = contents.readUInt16LE(cursor + 30);
    const commentBytes = contents.readUInt16LE(cursor + 32);
    const fileName = contents
      .subarray(cursor + ZIP_CENTRAL_ENTRY_BYTES, cursor + ZIP_CENTRAL_ENTRY_BYTES + fileNameBytes)
      .toString("utf8");
    if (compressed32 !== 0 || uncompressed32 !== 0) {
      verifyZipEntryInflate(
        contents,
        entryIndex,
        cursor,
        compressed32,
        uncompressed32,
        fileName,
        maxRatio
      );
    }
    cursor += ZIP_CENTRAL_ENTRY_BYTES + fileNameBytes + extraBytes + commentBytes;
  }
}

function verifyZipEntryInflate(
  contents: Buffer,
  entryIndex: number,
  centralCursor: number,
  compressed32: number,
  uncompressed32: number,
  fileName: string,
  maxRatio: bigint
): void {
  if (fileName.endsWith("/")) return;
  const method = contents.readUInt16LE(centralCursor + 10);
  const localOffset = contents.readUInt32LE(centralCursor + 42);
  const payload = readZipLocalPayload(contents, localOffset, compressed32);
  const cap = INDEX_LIMITS.maxDocxEntryUncompressedBytes;
  let actual: Buffer;
  if (method === 0) {
    actual = payload;
  } else if (method === 8) {
    try {
      actual = zlib.inflateRawSync(payload, { maxOutputLength: cap + 1 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw invalidDocxArchive(
          `entry ${entryIndex + 1} expands beyond the ${Math.round(cap / 1024 / 1024)} MB per-entry limit. Re-save or split the document.`
        );
      }
      throw invalidDocxArchive(
        `entry ${entryIndex + 1} could not be inflated safely. Re-save the document.`
      );
    }
  } else {
    throw invalidDocxArchive(
      `entry ${entryIndex + 1} uses an unsupported compression method. Re-save the document.`
    );
  }
  if (actual.length > cap) {
    throw invalidDocxArchive(
      `entry ${entryIndex + 1} expands beyond the ${Math.round(cap / 1024 / 1024)} MB per-entry limit. Re-save or split the document.`
    );
  }
  if (compressed32 > 0 && BigInt(actual.length) > BigInt(compressed32) * maxRatio) {
    throw invalidDocxArchive(
      `entry ${entryIndex + 1} exceeds the ${INDEX_LIMITS.maxDocxCompressionRatio}:1 expansion-ratio limit. Re-save the document.`
    );
  }
  if (uncompressed32 > 0 && actual.length !== uncompressed32) {
    throw invalidDocxArchive(
      `entry ${entryIndex + 1} uncompressed size does not match its inflated data. Re-save the document.`
    );
  }
}

function readZipLocalPayload(
  contents: Buffer,
  localOffset: number,
  compressedBytes: number
): Buffer {
  if (
    localOffset < 0 ||
    localOffset + 30 > contents.length ||
    contents.readUInt32LE(localOffset) !== 0x04034b50
  ) {
    throw invalidDocxArchive("a ZIP local header is missing or truncated.");
  }
  const nameLen = contents.readUInt16LE(localOffset + 26);
  const extraLen = contents.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedBytes;
  if (dataEnd > contents.length) {
    throw invalidDocxArchive("a ZIP entry extends past the end of the archive.");
  }
  return contents.subarray(dataStart, dataEnd);
}

type SourceFileVersion = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

function sourceFileVersion(stat: fs.BigIntStats): SourceFileVersion {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameSourceFileVersion(left: SourceFileVersion, right: SourceFileVersion): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sourceChangedError(): Error {
  return new Error("Source document changed while it was being indexed; run Reindex again.");
}

function canonicalPath(candidate: string): string {
  return fs.realpathSync.native(candidate);
}

function sourceContentDigest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Containment is decided on native real paths. `fs.realpathSync.native` expands
 * Windows 8.3 names (`RUNNER~1` → `runneradmin`) without leaving the directory,
 * so a lexical root and a canonical file are the same location.
 */
function pathResolvesInside(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertCurrentSourceFile(
  filePath: string,
  expected: SourceFileVersion,
  realDocsDir: string
): void {
  let stat: fs.BigIntStats;
  let realPath: string;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
    realPath = fs.realpathSync(filePath);
  } catch {
    throw sourceChangedError();
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !pathResolvesInside(realDocsDir, realPath) ||
    !sameSourceFileVersion(expected, sourceFileVersion(stat))
  ) {
    throw sourceChangedError();
  }
}

async function readOwnedSourceFile(
  filePath: string,
  expected: SourceFileVersion
): Promise<{ contents: Buffer; version: SourceFileVersion }> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const openedStat = await handle.stat({ bigint: true });
    const openedVersion = sourceFileVersion(openedStat);
    if (!openedStat.isFile() || !sameSourceFileVersion(expected, openedVersion)) {
      throw sourceChangedError();
    }
    if (openedStat.size > BigInt(INDEX_LIMITS.maxFileBytes)) {
      throw new Error(
        `File exceeds the ${Math.round(INDEX_LIMITS.maxFileBytes / 1024 / 1024)} MB per-file indexing limit.`
      );
    }

    const contents = Buffer.allocUnsafe(Number(openedStat.size));
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.length - offset,
        offset
      );
      if (bytesRead === 0) throw sourceChangedError();
      offset += bytesRead;
    }

    const afterRead = sourceFileVersion(await handle.stat({ bigint: true }));
    if (!sameSourceFileVersion(openedVersion, afterRead)) throw sourceChangedError();
    return { contents, version: openedVersion };
  } finally {
    await handle.close();
  }
}

const INDEX_CHUNK_CHARS = 1_200;
const INDEX_CHUNK_OVERLAP_CHARS = 200;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bounds for reconstructable index.json data before parsing or MiniSearch allocation. */
export const INDEX_STORAGE_LIMITS = Object.freeze({
  maxJsonBytes: 128 * 1024 * 1024,
  maxDocuments: INDEX_LIMITS.maxFiles,
  maxChunks:
    Math.ceil(
      INDEX_LIMITS.maxTotalChars /
        (INDEX_CHUNK_CHARS - INDEX_CHUNK_OVERLAP_CHARS)
    ) + INDEX_LIMITS.maxFiles,
  maxFileNameChars: 512,
  maxRelativePathChars: 32_768,
  maxLabelChars: 512,
  maxPageHintChars: 128,
  maxTimestampChars: 64,
  maxChunkChars: INDEX_CHUNK_CHARS,
  maxTotalChunkChars: 25_000_000,
  maxPageCount: 1_000_000,
});

export type IndexingIssue = {
  fileName: string;
  relativePath: string;
  message: string;
};

/**
 * Every rebuild owns an opaque generation. A newer rebuild, document discard,
 * or matter deletion replaces the token so an older async extraction can never
 * commit stale evidence after its source files have changed or disappeared.
 */
const indexBuildOwners = new Map<string, symbol>();

function claimIndexBuild(matterId: string): symbol {
  const owner = Symbol(matterId);
  indexBuildOwners.set(matterId, owner);
  return owner;
}

export function cancelReindex(matterId: string): void {
  indexBuildOwners.set(matterId, Symbol(`${matterId}:cancelled`));
}

function assertIndexBuildOwner(matterId: string, owner: symbol): void {
  if (indexBuildOwners.get(matterId) !== owner) {
    throw new Error("Index rebuild was cancelled because the matter changed or was deleted.");
  }
}

function listIndexableFiles(
  root: string,
  issues: IndexingIssue[]
): { files: string[]; truncated: boolean } {
  if (!fs.existsSync(root)) return { files: [], truncated: false };

  const files: string[] = [];
  const pendingDirectories = [root];
  let entriesSeen = 0;
  let truncated = false;

  outer: while (pendingDirectories.length) {
    const directory = pendingDirectories.pop()!;
    let handle: fs.Dir | null = null;
    try {
      handle = fs.opendirSync(directory);
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        entriesSeen += 1;
        if (entriesSeen > INDEX_LIMITS.maxEntries || files.length > INDEX_LIMITS.maxFiles) {
          truncated = true;
          break outer;
        }
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) pendingDirectories.push(full);
        else files.push(full);
      }
    } catch (err) {
      const relativePath = path.relative(root, directory).replace(/\\/g, "/");
      issues.push({
        fileName: path.basename(directory) || "Documents folder",
        relativePath,
        message: `Could not enumerate this folder: ${String(err).slice(0, 500)}`,
      });
    } finally {
      try {
        handle?.closeSync();
      } catch {
        /* directory may already be closed after an enumeration failure */
      }
    }
  }

  return {
    files: files.slice(0, INDEX_LIMITS.maxFiles),
    truncated: truncated || files.length > INDEX_LIMITS.maxFiles,
  };
}

interface MatterIndex {
  matterId: string;
  builtAt: string;
  documents: DocumentMeta[];
  chunks: Chunk[];
}

function invalidIndex(reason: string): never {
  throw new Error(
    `The case record index is invalid (${reason}). Reindex the matter before continuing.`
  );
}

function indexRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidIndex(`${label} is not an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidIndex(`${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
}

function indexString(
  record: Record<string, unknown>,
  key: string,
  maxChars: number,
  options: { allowEmpty?: boolean; controls?: boolean } = {}
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length > maxChars ||
    (!options.allowEmpty && !value.trim()) ||
    (options.controls !== false && /[\u0000-\u001f\u007f]/.test(value))
  ) {
    return invalidIndex(`${key} is invalid`);
  }
  return value;
}

function indexUuid(record: Record<string, unknown>, key: string): string {
  const value = indexString(record, key, 36);
  if (!UUID_RE.test(value)) return invalidIndex(`${key} is not a UUID`);
  return value;
}

function indexInteger(
  record: Record<string, unknown>,
  key: string,
  max: number
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    return invalidIndex(`${key} is invalid`);
  }
  return value as number;
}

function indexTimestamp(record: Record<string, unknown>, key: string): string {
  const value = indexString(record, key, INDEX_STORAGE_LIMITS.maxTimestampChars);
  if (!Number.isFinite(Date.parse(value))) return invalidIndex(`${key} is invalid`);
  return value;
}

function validateMatterIndex(value: unknown, expectedMatterId: string): MatterIndex {
  const root = indexRecord(value, "root");
  const storedMatterId = indexUuid(root, "matterId");
  if (storedMatterId !== expectedMatterId) return invalidIndex("matter ownership does not match");
  const builtAt = indexTimestamp(root, "builtAt");
  if (!Array.isArray(root.documents) || root.documents.length > INDEX_STORAGE_LIMITS.maxDocuments) {
    return invalidIndex("documents are invalid");
  }
  if (!Array.isArray(root.chunks) || root.chunks.length > INDEX_STORAGE_LIMITS.maxChunks) {
    return invalidIndex("chunks are invalid");
  }

  const documentIds = new Set<string>();
  const relativePaths = new Set<string>();
  const documentById = new Map<string, DocumentMeta>();
  let totalDocumentChars = 0;
  const documents = root.documents.map((value, index) => {
    const row = indexRecord(value, `document ${index + 1}`);
    const id = indexUuid(row, "id");
    if (documentIds.has(id)) return invalidIndex("document ids are duplicated");
    documentIds.add(id);
    const matterId = indexUuid(row, "matterId");
    if (matterId !== expectedMatterId) return invalidIndex("document ownership does not match");
    const fileName = indexString(row, "fileName", INDEX_STORAGE_LIMITS.maxFileNameChars);
    if (/[\\/]/.test(fileName)) return invalidIndex("a document filename is invalid");
    const relativePath = indexString(
      row,
      "relativePath",
      INDEX_STORAGE_LIMITS.maxRelativePathChars
    );
    const relativeParts = relativePath.split("/");
    if (
      relativePath.includes("\\") ||
      relativePath.startsWith("/") ||
      /^[A-Za-z]:/.test(relativePath) ||
      relativeParts.some((part) => !part || part === "." || part === "..") ||
      path.posix.basename(relativePath) !== fileName ||
      relativePaths.has(relativePath)
    ) {
      return invalidIndex("a document path is invalid or duplicated");
    }
    relativePaths.add(relativePath);
    const docType = indexString(row, "docType", 80);
    const witnessName = indexString(row, "witnessName", INDEX_STORAGE_LIMITS.maxLabelChars, {
      allowEmpty: true,
    });
    const exhibitNo = indexString(row, "exhibitNo", INDEX_STORAGE_LIMITS.maxLabelChars, {
      allowEmpty: true,
    });
    const pageCount = indexInteger(row, "pageCount", INDEX_STORAGE_LIMITS.maxPageCount);
    const charCount = indexInteger(row, "charCount", INDEX_LIMITS.maxDocumentChars);
    totalDocumentChars += charCount;
    if (totalDocumentChars > INDEX_LIMITS.maxTotalChars) {
      return invalidIndex("document text exceeds the storage budget");
    }
    const indexedAt = indexTimestamp(row, "indexedAt");
    const document: DocumentMeta = {
      id,
      matterId,
      fileName,
      relativePath,
      docType,
      witnessName,
      exhibitNo,
      pageCount,
      charCount,
      indexedAt,
    };
    documentById.set(id, document);
    return document;
  });

  const chunkIds = new Set<string>();
  let totalChunkChars = 0;
  const chunks = root.chunks.map((value, index) => {
    const row = indexRecord(value, `chunk ${index + 1}`);
    const id = indexUuid(row, "id");
    if (chunkIds.has(id)) return invalidIndex("chunk ids are duplicated");
    chunkIds.add(id);
    const documentId = indexUuid(row, "documentId");
    const document = documentById.get(documentId);
    if (!document) return invalidIndex("a chunk references an unknown document");
    const matterId = indexUuid(row, "matterId");
    if (matterId !== expectedMatterId) return invalidIndex("chunk ownership does not match");
    const fileName = indexString(row, "fileName", INDEX_STORAGE_LIMITS.maxFileNameChars);
    const docType = indexString(row, "docType", 80);
    const witnessName = indexString(row, "witnessName", INDEX_STORAGE_LIMITS.maxLabelChars, {
      allowEmpty: true,
    });
    const exhibitNo = indexString(row, "exhibitNo", INDEX_STORAGE_LIMITS.maxLabelChars, {
      allowEmpty: true,
    });
    if (
      fileName !== document.fileName ||
      docType !== document.docType ||
      witnessName !== document.witnessName ||
      exhibitNo !== document.exhibitNo
    ) {
      return invalidIndex("chunk metadata does not match its document");
    }
    const pageHint = indexString(row, "pageHint", INDEX_STORAGE_LIMITS.maxPageHintChars);
    const text = indexString(row, "text", INDEX_STORAGE_LIMITS.maxChunkChars, {
      controls: false,
    });
    totalChunkChars += text.length;
    if (totalChunkChars > INDEX_STORAGE_LIMITS.maxTotalChunkChars) {
      return invalidIndex("chunk text exceeds the storage budget");
    }
    return {
      id,
      documentId,
      matterId,
      fileName,
      docType,
      witnessName,
      exhibitNo,
      pageHint,
      text,
    } satisfies Chunk;
  });

  return { matterId: expectedMatterId, builtAt, documents, chunks };
}

function chunkText(
  text: string,
  size = INDEX_CHUNK_CHARS,
  overlap = INDEX_CHUNK_OVERLAP_CHARS
): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/[ \u00a0]+/g, " ").trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const end = Math.min(cleaned.length, i + size);
    chunks.push(cleaned.slice(i, end).trim());
    if (end >= cleaned.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks.filter(Boolean);
}

function guessDocType(fileName: string): string {
  const n = fileName.toLowerCase();
  if (n.includes("depo") || n.includes("deposition")) return "deposition";
  if (n.includes("exhibit")) return "exhibit";
  if (n.includes("complaint") || n.includes("answer") || n.includes("pleading")) return "pleading";
  if (n.includes("affidavit") || n.includes("declaration")) return "affidavit";
  if (n.includes("timeline")) return "timeline";
  if (n.includes("transcript")) return "transcript";
  return "other";
}

function guessExhibitNo(fileName: string): string {
  const m = fileName.match(/exhibit\s*[#:_-]?\s*([A-Za-z0-9.-]+)/i);
  return m?.[1] ?? "";
}

/** Tokens that must never become witnessName (filename junk after depo keywords). */
const WITNESS_NAME_JUNK = new Set([
  "transcript",
  "rough",
  "draft",
  "volume",
  "vol",
  "deposition",
  "depo",
  "text",
  "pdf",
  "docx",
  "full",
  "profile",
  "memory",
  "supplemental",
  "responses",
  "response",
  "rogs",
  "rfps",
  "rfp",
  "rog",
  "exhibit",
  "exhibits",
  "of",
  "the",
  "and",
  "to",
  "from",
  "dated",
  "final",
  "amended",
  "confidential",
  "redacted",
  "page",
  "pages",
  "part",
  "video",
  "audio",
  "certified",
  "copy",
  "30b6",
  "b6",
  "uwm",
  "first",
  "second",
  "third",
  "fourth",
  "corrected",
  "errata",
  "condensed",
  "ascii",
  "roughdraft",
]);

function isWitnessNameJunkToken(word: string): boolean {
  const t = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t || t.length < 2) return true;
  if (WITNESS_NAME_JUNK.has(t)) return true;
  if (/^\d+$/.test(t)) return true;
  // Date fragments like 25.11.04 or 2025-11-04
  if (/^\d{1,4}[./-]\d{1,2}([./-]\d{1,4})?$/.test(word)) return true;
  return false;
}

function cleanWitnessNameCapture(raw: string): string {
  const words = raw
    .replace(/[_]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z.'-]+$/g, ""))
    .filter(Boolean)
    .filter((w) => !isWitnessNameJunkToken(w));
  if (!words.length) return "";
  // At least one alphabetic name token with a letter start
  if (!words.some((w) => /^[A-Za-z]/.test(w))) return "";
  return words.join(" ").trim();
}

/**
 * Best-effort witness name from common depo filename patterns.
 * Handles both "Deposition of Jane Smith" and "Gaudino Deposition Transcript".
 */
function guessWitnessName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");

  // 1. "Deposition of Jane Smith" / "Depo of J. Smith"
  const ofMatch = base.match(
    /(?:deposition|depo)\s+of\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.']*){0,3})/i
  );
  if (ofMatch?.[1]) {
    const n = cleanWitnessNameCapture(ofMatch[1]);
    if (n) return n;
  }

  // 2. Name(s) immediately preceding deposition | depo | 30b6 | 30(b)(6)
  //    e.g. "25.11.04 Gaudino Deposition Transcript"
  //         "26.04.14 Gaudino 30b6 Deposition Transcript (ROUGH DRAFT)"
  const beforeKw = base.match(
    /([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.']*){0,2})\s+(?:deposition|depo|30\s*b\s*6|30\s*\(\s*b\s*\)\s*\(\s*6\s*\))/i
  );
  if (beforeKw?.[1]) {
    const n = cleanWitnessNameCapture(beforeKw[1]);
    if (n) return n;
  }

  // 3. "Gaudino - Full Profile" leading name before dash
  const leading = base.match(/^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*[-–—]/);
  if (leading?.[1]) {
    const n = cleanWitnessNameCapture(leading[1]);
    if (n) return n;
  }

  return "";
}

async function extractPdfText(contents: Buffer): Promise<{ text: string; pageCount: number }> {
  pdfjs.disableWorker = true;
  const doc = await pdfjs.getDocument(contents);
  try {
    const pageCount = doc.numPages;
    if (pageCount > INDEX_LIMITS.maxPdfPages) {
      throw new Error(
        `PDF contains ${pageCount.toLocaleString()} pages; the indexing limit is ${INDEX_LIMITS.maxPdfPages.toLocaleString()} pages. Split it into smaller PDFs.`
      );
    }
    let text = "";
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let pageText = "";
      for (const item of content.items) {
        const piece = typeof item.str === "string" ? item.str : "";
        const y = item.transform?.[5];
        if (lastY === undefined || y === lastY) pageText += piece;
        else pageText += `\n${piece}`;
        if (typeof y === "number") lastY = y;
      }
      text += `\n\n${pageText}`;
      if (text.length > INDEX_LIMITS.maxDocumentChars) break;
    }
    return { text, pageCount };
  } finally {
    await doc.destroy();
  }
}

async function extractText(
  filePath: string,
  contents: Buffer
): Promise<{ text: string; pageCount: number }> {
  const ext = path.extname(filePath).toLowerCase();
  if (PDF_EXTS.has(ext)) {
    return extractPdfText(contents);
  }
  if (DOCX_EXTS.has(ext)) {
    preflightDocxArchive(contents);
    const result = await mammoth.extractRawText({ buffer: contents });
    return { text: result.value || "", pageCount: 0 };
  }
  if (TEXT_EXTS.has(ext)) {
    return { text: contents.toString("utf8"), pageCount: 0 };
  }
  // best-effort for unknown text-like files
  const text = contents.toString("utf8");
  if (text.includes("\u0000")) return { text: "", pageCount: 0 };
  return { text, pageCount: 0 };
}

export async function reindexMatter(matterId: string): Promise<ReindexResult> {
  // Validate the complete directory chain before reading. In particular, a
  // documents junction must never turn an index rebuild into an arbitrary-file
  // reader. Re-check immediately before the synchronous commit too.
  const docsDir = assertTrustedDocumentsDirectory(matterId);
  if (!getMatter(matterId)) throw new Error("Matter not found");
  const buildOwner = claimIndexBuild(matterId);
  const documents: DocumentMeta[] = [];
  const chunks: Chunk[] = [];
  const issues: IndexingIssue[] = [];
  const { files, truncated } = listIndexableFiles(docsDir, issues);
  if (truncated) {
    issues.push({
      fileName: "Additional files",
      relativePath: "",
      message: `Additional entries were skipped after the ${INDEX_LIMITS.maxFiles}-file / ${INDEX_LIMITS.maxEntries}-entry traversal limit.`,
    });
  }
  const realDocsDir = docsDir;
  const indexedSources: Array<{
    filePath: string;
    version: SourceFileVersion;
    digest: string;
  }> = [];
  let totalChars = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    // Cancellation cannot interrupt a parser that is already running, but it
    // must stop the superseded build before another potentially large record is
    // read. Keep this outside the per-file catch so cancellation is terminal.
    assertIndexBuildOwner(matterId, buildOwner);
    const filePath = files[fileIndex]!;
    const fileName = path.basename(filePath);
    const relativePath = path.relative(docsDir, filePath).replace(/\\/g, "/");

    try {
      const stat = fs.lstatSync(filePath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) {
        issues.push({
          fileName,
          relativePath,
          message: "Skipped because the entry is not a regular file.",
        });
        continue;
      }

      const realPath = fs.realpathSync(filePath);
      if (!pathResolvesInside(realDocsDir, realPath)) {
        issues.push({
          fileName,
          relativePath,
          message: "Skipped because the file resolves outside this matter's documents folder.",
        });
        continue;
      }
      if (stat.size > BigInt(INDEX_LIMITS.maxFileBytes)) {
        issues.push({
          fileName,
          relativePath,
          message: `Skipped because it exceeds the ${Math.round(
            INDEX_LIMITS.maxFileBytes / 1024 / 1024
          )} MB per-file indexing limit.`,
        });
        continue;
      }

      const { contents, version } = await readOwnedSourceFile(
        filePath,
        sourceFileVersion(stat)
      );
      const { text, pageCount } = await extractText(filePath, contents);
      assertCurrentSourceFile(filePath, version, realDocsDir);
      if (!text.trim()) {
        issues.push({
          fileName,
          relativePath,
          message: "No extractable text was found (the file may be scanned, encrypted, or binary).",
        });
        continue;
      }
      if (text.length > INDEX_LIMITS.maxDocumentChars) {
        issues.push({
          fileName,
          relativePath,
          message: `Skipped because extracted text exceeds ${INDEX_LIMITS.maxDocumentChars.toLocaleString()} characters; split the document into smaller files.`,
        });
        continue;
      }
      if (totalChars + text.length > INDEX_LIMITS.maxTotalChars) {
        issues.push({
          fileName,
          relativePath,
          message: `Skipped because this matter reached the ${INDEX_LIMITS.maxTotalChars.toLocaleString()} character indexing budget.`,
        });
        continue;
      }

      totalChars += text.length;
      const docId = uuid();
      const witnessName = guessWitnessName(fileName);
      const exhibitNo = guessExhibitNo(fileName);
      const meta: DocumentMeta = {
        id: docId,
        matterId,
        fileName,
        relativePath,
        docType: guessDocType(fileName),
        witnessName,
        exhibitNo,
        pageCount,
        charCount: text.length,
        indexedAt: new Date().toISOString(),
      };
      documents.push(meta);
      indexedSources.push({
        filePath,
        version,
        digest: sourceContentDigest(contents),
      });
      const parts = chunkText(text);
      const totalParts = parts.length || 1;
      parts.forEach((part, idx) => {
        // Approximate page from character offset when PDF pageCount is known
        let pageHint = `chunk ${idx + 1}`;
        if (pageCount > 0) {
          const approxPage = Math.min(
            pageCount,
            Math.max(1, Math.floor((idx / totalParts) * pageCount) + 1)
          );
          pageHint = `p. ~${approxPage} (chunk ${idx + 1})`;
        }
        chunks.push({
          id: uuid(),
          documentId: docId,
          matterId,
          fileName,
          docType: meta.docType,
          witnessName,
          exhibitNo,
          pageHint,
          text: part,
        });
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      issues.push({
        fileName,
        relativePath,
        message: `Could not index this file: ${detail.slice(0, 500)}`,
      });
    } finally {
      // Yield between records so long rebuilds do not starve websocket pings/UI IPC.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const index: MatterIndex = {
    matterId,
    builtAt: new Date().toISOString(),
    documents,
    chunks,
  };
  const currentDocsDir = assertTrustedDocumentsDirectory(matterId);
  assertIndexBuildOwner(matterId, buildOwner);
  if (currentDocsDir !== realDocsDir || !getMatter(matterId)) {
    throw new Error("Index rebuild was cancelled because the matter changed or was deleted.");
  }
  for (const source of indexedSources) {
    assertCurrentSourceFile(source.filePath, source.version, realDocsDir);
    // Same-size rewrites can keep dev/ino/size/mtime on Windows long enough
    // that the stat snapshot still matches. Re-read and compare the bytes
    // that were actually indexed before the commit.
    const reread = await readOwnedSourceFile(source.filePath, source.version);
    if (sourceContentDigest(reread.contents) !== source.digest) throw sourceChangedError();
  }
  assertIndexBuildOwner(matterId, buildOwner);
  writeJson(assertTrustedIndexPath(matterId), index, {
    backup: false,
    maxBytes: INDEX_STORAGE_LIMITS.maxJsonBytes,
    label: "Case record index",
  });
  purgeIndexArtifacts(matterId, false);
  clearPersistedIndexInvalidation(matterId);
  discardedIndexes.delete(matterId);
  invalidateSearchCache(matterId);
  touchMatter(matterId);
  // Do not return chunk text to the renderer — metadata + counts only
  return {
    matterId,
    documentCount: documents.length,
    chunkCount: chunks.length,
    documents,
    issues,
  };
}

export type ReindexResult = {
  matterId: string;
  documentCount: number;
  chunkCount: number;
  documents: DocumentMeta[];
  issues: IndexingIssue[];
};

function emptyIndex(matterId: string): MatterIndex {
  return { matterId, builtAt: "", documents: [], chunks: [] };
}

const MISSING_INDEX = Symbol("missing-index");

export function loadIndex(matterId: string): MatterIndex {
  if (discardedIndexes.has(matterId) || hasPersistedIndexInvalidation(matterId)) {
    return emptyIndex(matterId);
  }
  const file = findTrustedIndexPath(matterId);
  if (!file) return emptyIndex(matterId);
  const value = readJson<unknown>(file, MISSING_INDEX, {
    maxBytes: INDEX_STORAGE_LIMITS.maxJsonBytes,
    label: "Case record index",
    preserveCorrupt: false,
  });
  if (value === MISSING_INDEX) return emptyIndex(matterId);
  return validateMatterIndex(value, matterId);
}

/** Cached MiniSearch per matter — rebuilt only when index.builtAt changes. */
type SearchCacheEntry = {
  fileVersion: string;
  ms: MiniSearch<Chunk>;
  byId: Map<string, Chunk>;
  chunks: Chunk[];
  charCount: number;
};

const searchCache = new Map<string, SearchCacheEntry>();
const discardedIndexes = new Set<string>();

function indexInvalidationPath(matterId: string): string {
  return `${assertTrustedIndexPath(matterId)}.discarded`;
}

function hasPersistedIndexInvalidation(matterId: string): boolean {
  const file = findTrustedIndexPath(matterId);
  if (!file) return false;
  try {
    const stat = fs.lstatSync(`${file}.discarded`);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Case record invalidation marker is not a regular file");
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function isIndexInvalidated(matterId: string): boolean {
  return discardedIndexes.has(matterId) || hasPersistedIndexInvalidation(matterId);
}

const INDEX_ARTIFACT_SCAN_LIMIT = 4_096;

function isLegacyIndexArtifact(name: string): boolean {
  return (
    name === "index.json.bak" ||
    /^index\.json\.corrupt-\d+(?:-\d+)?$/.test(name) ||
    /^index\.json\.tmp-\d+-[0-9a-f-]+$/i.test(name)
  );
}

/** Best-effort cleanup for reconstructable index copies that can retain deleted evidence. */
function purgeIndexArtifacts(matterId: string, includeLive: boolean): void {
  let indexFile: string;
  try {
    indexFile = assertTrustedIndexPath(matterId);
  } catch (err) {
    console.warn(`[index] Could not validate index cleanup for ${matterId}`, err);
    return;
  }

  const directory = path.dirname(indexFile);
  const attempted = new Set<string>();
  const removeArtifact = (candidate: string, name: string): void => {
    attempted.add(name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[index] Could not remove derived index artifact ${name}`, err);
      }
    }
  };

  // Exact sensitive leaves must not depend on bounded directory enumeration.
  if (includeLive) removeArtifact(indexFile, "index.json");
  removeArtifact(`${indexFile}.bak`, "index.json.bak");

  let handle: fs.Dir | null = null;
  try {
    handle = fs.opendirSync(directory);
    let seen = 0;
    while (seen < INDEX_ARTIFACT_SCAN_LIMIT) {
      const entry = handle.readSync();
      if (!entry) break;
      seen += 1;
      if (attempted.has(entry.name)) continue;
      if (!(includeLive && entry.name === "index.json") && !isLegacyIndexArtifact(entry.name)) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      removeArtifact(candidate, entry.name);
    }
  } catch (err) {
    console.warn(`[index] Could not enumerate derived index artifacts for ${matterId}`, err);
  } finally {
    try {
      handle?.closeSync();
    } catch {
      /* cleanup is best effort and must not change the committed mutation result */
    }
  }
}

function clearPersistedIndexInvalidation(matterId: string): void {
  const marker = indexInvalidationPath(matterId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Case record invalidation marker is not a regular file");
  }
  fs.unlinkSync(marker);
}

export const SEARCH_CACHE_LIMITS = Object.freeze({
  maxMatters: 3,
  maxChars: 25_000_000,
});

export function invalidateSearchCache(matterId: string) {
  searchCache.delete(matterId);
}

/** Persistently hide the current index before changing any of its source documents. */
export function beginIndexInvalidation(matterId: string): boolean {
  const marker = indexInvalidationPath(matterId);
  const persistedInvalidation = hasPersistedIndexInvalidation(matterId);
  const alreadyInvalidated = discardedIndexes.has(matterId) || persistedInvalidation;
  cancelReindex(matterId);
  invalidateSearchCache(matterId);
  if (!persistedInvalidation) {
    writeFileAtomic(
      marker,
      JSON.stringify({ matterId, invalidatedAt: new Date().toISOString() })
    );
  }
  discardedIndexes.add(matterId);
  // Only the operation that changed valid -> invalid may later remove the
  // marker. Nested mutations must preserve an older committed invalidation.
  return !alreadyInvalidated;
}

/** Restore eligibility when a prepared source mutation did not commit. */
export function rollbackIndexInvalidation(matterId: string): void {
  clearPersistedIndexInvalidation(matterId);
  discardedIndexes.delete(matterId);
  invalidateSearchCache(matterId);
}

/** Keep the durable marker and best-effort remove the superseded index payload. */
export function commitIndexInvalidation(matterId: string): void {
  // The durable marker is the commit point. Cleanup is deliberately fail-soft:
  // a locked file or replaced directory cannot turn a committed source mutation
  // into a false failure, and unsafe link-like leaves are never followed.
  purgeIndexArtifacts(matterId, true);
}

/** Remove a stale on-disk index after source documents have already changed. */
export function discardIndex(matterId: string): void {
  beginIndexInvalidation(matterId);
  commitIndexInvalidation(matterId);
}

function storeSearchCache(matterId: string, entry: SearchCacheEntry): void {
  searchCache.delete(matterId);
  searchCache.set(matterId, entry);

  const totalChars = () =>
    [...searchCache.values()].reduce((sum, cached) => sum + cached.charCount, 0);
  while (
    searchCache.size > 1 &&
    (searchCache.size > SEARCH_CACHE_LIMITS.maxMatters ||
      totalChars() > SEARCH_CACHE_LIMITS.maxChars)
  ) {
    const oldest = searchCache.keys().next().value as string | undefined;
    if (!oldest) break;
    searchCache.delete(oldest);
  }
}

function evictSearchCacheForIncoming(matterId: string, incomingChars: number): void {
  searchCache.delete(matterId);
  const cachedChars = () =>
    [...searchCache.values()].reduce((sum, cached) => sum + cached.charCount, 0);
  while (
    searchCache.size > 0 &&
    (searchCache.size >= SEARCH_CACHE_LIMITS.maxMatters ||
      cachedChars() + incomingChars > SEARCH_CACHE_LIMITS.maxChars)
  ) {
    const oldest = searchCache.keys().next().value as string | undefined;
    if (!oldest) break;
    searchCache.delete(oldest);
  }
}

function buildSearch(chunks: Chunk[]): MiniSearch<Chunk> {
  const ms = new MiniSearch<Chunk>({
    fields: ["text", "fileName", "docType", "witnessName", "exhibitNo"],
    searchOptions: {
      boost: { fileName: 2, exhibitNo: 3, witnessName: 2 },
      fuzzy: 0.15,
      prefix: true,
    },
  });
  ms.addAll(chunks);
  return ms;
}

function indexFileVersion(file: string): string {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Case record index is not a regular file");
    }
    // Atomic replacement can preserve a coarse mtime. Include identity, size,
    // and metadata-change time so the cache cannot serve a replaced index. Some
    // Windows filesystems report ino=0, where birth time is the fallback identity.
    const identity = stat.ino === 0n ? `birth-${stat.birthtimeNs}` : `ino-${stat.ino}`;
    return [stat.dev, identity, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

function getCachedSearch(matterId: string): {
  ms: MiniSearch<Chunk>;
  byId: Map<string, Chunk>;
  chunks: Chunk[];
} {
  // Matter deletion removes the canonical directory after invalidating the
  // generation. Preserve the same-process empty-search behavior without
  // attempting to resolve a path that correctly no longer exists.
  if (discardedIndexes.has(matterId)) {
    const chunks: Chunk[] = [];
    return { ms: buildSearch(chunks), byId: new Map(), chunks };
  }
  const file = findTrustedIndexPath(matterId);
  if (!file) {
    const chunks: Chunk[] = [];
    return { ms: buildSearch(chunks), byId: new Map(), chunks };
  }
  const fileVersion = indexFileVersion(file);
  const cached = searchCache.get(matterId);
  if (cached && cached.fileVersion === fileVersion) {
    // Refresh insertion order so the least-recently-used matter is evicted first.
    searchCache.delete(matterId);
    searchCache.set(matterId, cached);
    return { ms: cached.ms, byId: cached.byId, chunks: cached.chunks };
  }
  const index = loadIndex(matterId);
  const charCount = index.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  // Drop enough old token indexes before constructing the new MiniSearch. This
  // keeps a cache miss from transiently retaining two full search allocations.
  evictSearchCacheForIncoming(matterId, charCount);
  const ms = buildSearch(index.chunks);
  const byId = new Map(index.chunks.map((c) => [c.id, c]));
  storeSearchCache(matterId, {
    fileVersion,
    ms,
    byId,
    chunks: index.chunks,
    charCount,
  });
  return { ms, byId, chunks: index.chunks };
}

/** Substring term scan — no MiniSearch rebuild. Used when cached search has zero hits. */
function substringScan(chunks: Chunk[], query: string, limit: number): SearchResult[] {
  const terms = queryTerms(query);
  if (!terms.length || !chunks.length) return [];
  const scored = chunks
    .map((c) => {
      const lower = c.text.toLowerCase();
      let score = 0;
      for (const t of terms) if (lower.includes(t)) score += 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => toResult(x.c, x.score));
}

/** Search within an arbitrary chunk list (for document-scoped excerpts). */
function searchChunks(chunks: Chunk[], query: string, limit: number): SearchResult[] {
  if (!chunks.length) return [];
  if (!query.trim()) {
    return chunks.slice(0, limit).map((c) => toResult(c, 0));
  }
  const ms = buildSearch(chunks);
  let hits = ms.search(query, { combineWith: "OR" });
  if (hits.length < 2) {
    const terms = queryTerms(query);
    if (terms.length) {
      hits = ms.search(terms.join(" "), { combineWith: "OR" });
    }
  }
  if (!hits.length) {
    return substringScan(chunks, query, limit);
  }
  return hits.slice(0, limit).map((h) => {
    const c = chunks.find((x) => x.id === h.id)!;
    return toResult(c, h.score);
  });
}

function toResult(c: Chunk, score: number): SearchResult {
  return {
    chunkId: c.id,
    fileName: c.fileName,
    docType: c.docType,
    witnessName: c.witnessName,
    exhibitNo: c.exhibitNo,
    pageHint: c.pageHint,
    score,
    text: c.text.slice(0, 1500),
  };
}

export const SEARCH_INPUT_LIMITS = Object.freeze({
  queryChars: 2_000,
  toolQueryChars: 1_000,
  witnessNameChars: 200,
  docTypeChars: 80,
  fileNameChars: 512,
  terms: 64,
});

const SEARCHABLE_DOC_TYPES = new Set([
  "deposition",
  "exhibit",
  "pleading",
  "affidavit",
  "timeline",
  "transcript",
  "other",
]);

function searchArgsRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function boundedSearchText(
  value: unknown,
  label: string,
  maxChars: number,
  options: { optional?: boolean } = {}
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length > maxChars) {
    throw new Error(`${label} exceeds the ${maxChars}-character limit`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} contains unsupported control characters`);
  }
  return normalized || (options.optional ? undefined : "");
}

type NormalizedSearchOptions = {
  maxResults: number;
  witnessName?: string;
  docType?: string;
  documentId?: string;
  fileName?: string;
  requireQuery: boolean;
};

function normalizeSearchOptions(value: unknown): NormalizedSearchOptions {
  const options = searchArgsRecord(value, "Search options");
  const documentId = boundedSearchText(options.documentId, "Document id", 36, {
    optional: true,
  });
  if (documentId && !UUID_RE.test(documentId)) throw new Error("Document id is invalid");
  const docType = boundedSearchText(
    options.docType,
    "Document type filter",
    SEARCH_INPUT_LIMITS.docTypeChars,
    { optional: true }
  )?.toLowerCase();
  if (docType && !SEARCHABLE_DOC_TYPES.has(docType)) {
    throw new Error("Document type filter is invalid");
  }
  if (options.requireQuery !== undefined && typeof options.requireQuery !== "boolean") {
    throw new Error("Search requireQuery must be a boolean");
  }
  const witnessName = boundedSearchText(
    options.witnessName,
    "Witness filter",
    SEARCH_INPUT_LIMITS.witnessNameChars,
    { optional: true }
  );
  if (witnessName && !normalizedWitnessIdentity(witnessName)) {
    throw new Error("Witness filter is invalid");
  }
  return {
    maxResults: clampMaxResults(options.maxResults, 8),
    witnessName,
    docType,
    documentId,
    fileName: boundedSearchText(
      options.fileName,
      "Filename filter",
      SEARCH_INPUT_LIMITS.fileNameChars,
      { optional: true }
    ),
    requireQuery: options.requireQuery === true,
  };
}

/** Extract useful search terms from a spoken question. */
function queryTerms(query: string): string[] {
  const stop = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "do",
    "did",
    "does",
    "you",
    "your",
    "yours",
    "me",
    "my",
    "i",
    "we",
    "what",
    "when",
    "where",
    "who",
    "why",
    "how",
    "and",
    "or",
    "but",
    "if",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "about",
    "that",
    "this",
    "it",
    "please",
    "tell",
    "state",
    "whether",
    "any",
    "have",
    "had",
    "has",
  ]);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9./$-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !stop.has(t));
  return [...new Set(terms)].slice(0, SEARCH_INPUT_LIMITS.terms);
}

function normalizedWitnessIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Hard cap on passages returned to the model / IPC (prevents full-index dumps). */
export const MAX_SEARCH_RESULTS = 12;

export function clampMaxResults(value: unknown, fallback = 8): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("Search result count must be a positive number");
  }
  return Math.min(MAX_SEARCH_RESULTS, Math.floor(value));
}

export function searchCaseRecord(
  matterId: string,
  query: string,
  opts?: {
    maxResults?: number;
    witnessName?: string;
    docType?: string;
    documentId?: string;
    fileName?: string;
    /** When true, empty query returns [] instead of first-N chunks (tool path). */
    requireQuery?: boolean;
  }
): SearchResult[] {
  const normalizedQuery = boundedSearchText(
    query,
    "Search query",
    SEARCH_INPUT_LIMITS.queryChars
  )!;
  const options = normalizeSearchOptions(opts);
  const { ms, byId, chunks: allChunks } = getCachedSearch(matterId);
  let chunks = allChunks;
  let useCache = true;

  if (options.documentId) {
    chunks = chunks.filter((c) => c.documentId === options.documentId);
    useCache = false;
  }
  if (options.fileName) {
    const f = options.fileName.toLowerCase();
    chunks = chunks.filter((c) => c.fileName.toLowerCase().includes(f));
    useCache = false;
  }
  if (options.witnessName) {
    const witness = normalizedWitnessIdentity(options.witnessName);
    chunks = chunks.filter((chunk) => {
      const metadataWitness = normalizedWitnessIdentity(chunk.witnessName);
      if (metadataWitness) return metadataWitness === witness;
      const fileLabel = normalizedWitnessIdentity(path.parse(chunk.fileName).name);
      return ` ${fileLabel} `.includes(` ${witness} `);
    });
    useCache = false;
  }
  if (options.docType) {
    chunks = chunks.filter((c) => c.docType.toLowerCase() === options.docType);
    useCache = false;
  }
  if (!chunks.length) return [];
  const limit = options.maxResults;
  if (!normalizedQuery) {
    if (options.requireQuery) return [];
    return chunks.slice(0, limit).map((c) => toResult(c, 0));
  }

  const allowedIds = useCache ? null : new Set(chunks.map((chunk) => chunk.id));
  const runSearch = (value: string) =>
    ms.search(value, {
      combineWith: "OR",
      ...(allowedIds
        ? { filter: (result) => allowedIds.has(String(result.id)) }
        : {}),
    });
  let hits = runSearch(normalizedQuery);
  if (hits.length < 2) {
    const terms = queryTerms(normalizedQuery);
    if (terms.length) hits = runSearch(terms.join(" "));
  }
  if (!hits.length) {
    // Do not build a second MiniSearch for a filtered miss.
    return substringScan(chunks, normalizedQuery, limit);
  }
  return hits.slice(0, limit).map((hit) => {
    const chunk = byId.get(String(hit.id));
    if (!chunk) return invalidIndex("a search result references an unknown chunk");
    return toResult(chunk, hit.score);
  });
}

export function getDocumentExcerpt(
  matterId: string,
  args: { documentId?: string; fileName?: string; query?: string }
): SearchResult[] {
  const input = searchArgsRecord(args, "Document excerpt arguments");
  const documentId = boundedSearchText(input.documentId, "Document id", 36, {
    optional: true,
  });
  if (documentId && !UUID_RE.test(documentId)) throw new Error("Document id is invalid");
  const fileName = boundedSearchText(
    input.fileName,
    "Document filename",
    SEARCH_INPUT_LIMITS.fileNameChars,
    { optional: true }
  );
  const query = boundedSearchText(
    input.query,
    "Excerpt query",
    SEARCH_INPUT_LIMITS.queryChars,
    { optional: true }
  );
  if (!documentId && !fileName) {
    throw new Error("Document id or filename is required for an excerpt");
  }

  const index = loadIndex(matterId);
  let selectedDocumentId = documentId;
  if (fileName) {
    const requested = fileName.toLowerCase();
    const exact = index.documents.filter(
      (document) => document.fileName.toLowerCase() === requested
    );
    const candidates = exact.length
      ? exact
      : index.documents.filter((document) =>
          document.fileName.toLowerCase().includes(requested)
        );
    if (candidates.length > 1) {
      throw new Error("Document filename is ambiguous; use the exact document id");
    }
    if (!candidates.length) return [];
    if (selectedDocumentId && selectedDocumentId !== candidates[0]!.id) {
      throw new Error("Document id and filename identify different documents");
    }
    selectedDocumentId = candidates[0]!.id;
  }
  let chunks = index.chunks.filter((chunk) => chunk.documentId === selectedDocumentId);
  const limit = clampMaxResults(6, 6);
  // Search *within* the filtered document set — never fall back to whole-matter search
  if (query) return searchChunks(chunks, query, limit);
  return chunks.slice(0, limit).map((c) => ({
    chunkId: c.id,
    fileName: c.fileName,
    docType: c.docType,
    witnessName: c.witnessName,
    exhibitNo: c.exhibitNo,
    pageHint: c.pageHint,
    score: 1,
    text: c.text.slice(0, 1500),
  }));
}

export function getPriorTestimony(
  matterId: string,
  args: { witnessName: string; topic?: string }
): SearchResult[] {
  const input = searchArgsRecord(args, "Prior testimony arguments");
  const witnessName = boundedSearchText(
    input.witnessName,
    "Witness name",
    SEARCH_INPUT_LIMITS.witnessNameChars
  )!;
  if (!witnessName) throw new Error("Witness name is required");
  const testimonySuffix = "deposition testimony";
  const maxTopicChars =
    SEARCH_INPUT_LIMITS.queryChars - witnessName.length - testimonySuffix.length - 2;
  const topic = boundedSearchText(
    input.topic,
    "Testimony topic",
    maxTopicChars,
    { optional: true }
  );
  const query = [witnessName, topic, testimonySuffix].filter(Boolean).join(" ");
  return searchCaseRecord(matterId, query, {
    maxResults: 8,
    witnessName,
  });
}

export function listDocuments(matterId: string): DocumentMeta[] {
  if (isIndexInvalidated(matterId)) {
    throw new Error("The case record needs reindexing before its documents can be used.");
  }
  const documents = loadIndex(matterId).documents;
  if (!Array.isArray(documents)) {
    throw new Error("The case record index is invalid. Reindex the matter before continuing.");
  }
  return documents;
}

/**
 * Resolve a revocable document capability against the current committed index.
 * Rebuilds replace document ids, so a stale renderer cannot delete a newer file
 * that later occupies the same relative path.
 */
export function resolveIndexedDocument(matterId: string, documentId: string): DocumentMeta {
  const documents = listDocuments(matterId);
  const matches = documents.filter((document) => document?.id === documentId);
  const document = matches.length === 1 ? matches[0] : undefined;
  if (
    !document ||
    document.matterId !== matterId ||
    typeof document.relativePath !== "string" ||
    !document.relativePath.trim() ||
    document.relativePath.includes("\\") ||
    document.relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(document.relativePath) ||
    document.relativePath.split("/").some((part) => !part || part === "..") ||
    path.posix.basename(document.relativePath) !== document.fileName
  ) {
    throw new Error("Document is no longer in the current case record. Reindex and try again.");
  }
  return document;
}
