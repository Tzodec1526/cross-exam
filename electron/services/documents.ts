import type { DocumentMeta } from "../types.js";
import {
  beginIndexInvalidation,
  commitIndexInvalidation,
  listDocuments,
  reindexMatter,
  rollbackIndexInvalidation,
  resolveIndexedDocument,
  type IndexingIssue,
  type ReindexResult,
} from "./indexer.js";
import { publicErrorMessage } from "./fsutil.js";
import {
  assertTrustedDocumentsDirectory,
  deleteDocument,
  ImportRollbackUncertainError,
  importFiles,
} from "./matters.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PublicDocumentMeta {
  id: string;
  fileName: string;
  docType: string;
  charCount: number;
  pageCount: number;
}

export interface PublicIndexingIssue {
  fileName: string;
  message: string;
}

export interface PublicReindexResult {
  documentCount: number;
  chunkCount: number;
  documents: PublicDocumentMeta[];
  issues: PublicIndexingIssue[];
}

export interface DeleteIndexedDocumentResult {
  deleted: string;
}

/** A failed removal left the durable index marker in place and needs UI recovery. */
export class DocumentRollbackUncertainError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "DocumentRollbackUncertainError";
  }
}

function boundedLabel(value: unknown, fallback: string, maxLength = 260): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function toPublicDocument(matterId: string, document: DocumentMeta): PublicDocumentMeta {
  if (
    !document ||
    typeof document !== "object" ||
    typeof document.id !== "string" ||
    !UUID_RE.test(document.id) ||
    document.matterId !== matterId ||
    typeof document.relativePath !== "string" ||
    !document.relativePath.trim() ||
    document.relativePath.includes("\\") ||
    document.relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(document.relativePath) ||
    document.relativePath.split("/").some((part) => !part || part === "..") ||
    document.relativePath.split("/").at(-1) !== document.fileName ||
    typeof document.fileName !== "string" ||
    !document.fileName.trim() ||
    /[\\/]/.test(document.fileName) ||
    typeof document.docType !== "string" ||
    !Number.isFinite(document.charCount) ||
    document.charCount < 0 ||
    !Number.isFinite(document.pageCount) ||
    document.pageCount < 0
  ) {
    throw new Error("The case record index is invalid. Reindex the matter before continuing.");
  }
  return {
    id: document.id,
    fileName: boundedLabel(document.fileName, "Document"),
    docType: boundedLabel(document.docType, "other", 80),
    charCount: Math.floor(document.charCount),
    pageCount: Math.floor(document.pageCount),
  };
}

export function toPublicDocuments(
  matterId: string,
  documents: DocumentMeta[]
): PublicDocumentMeta[] {
  if (!Array.isArray(documents)) {
    throw new Error("The case record index is invalid. Reindex the matter before continuing.");
  }
  const seen = new Set<string>();
  return documents.map((document) => {
    const publicDocument = toPublicDocument(matterId, document);
    if (seen.has(publicDocument.id)) {
      throw new Error("The case record index is invalid. Reindex the matter before continuing.");
    }
    seen.add(publicDocument.id);
    return publicDocument;
  });
}

export function toPublicIndexingIssues(issues: IndexingIssue[]): PublicIndexingIssue[] {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 500).map((issue) => ({
    fileName: boundedLabel(publicErrorMessage(issue?.fileName ?? "Document"), "Document"),
    message: publicErrorMessage(issue?.message ?? "Indexing failed"),
  }));
}

export function toPublicReindexResult(
  matterId: string,
  result: ReindexResult
): PublicReindexResult {
  if (result.matterId !== matterId) {
    throw new Error("The case record response did not match this matter.");
  }
  const documents = toPublicDocuments(matterId, result.documents);
  return {
    documentCount: documents.length,
    chunkCount: Number.isFinite(result.chunkCount) ? Math.max(0, Math.floor(result.chunkCount)) : 0,
    documents,
    issues: toPublicIndexingIssues(result.issues),
  };
}

export function listPublicDocuments(matterId: string): PublicDocumentMeta[] {
  return toPublicDocuments(matterId, listDocuments(matterId));
}

export async function reindexPublicDocuments(matterId: string): Promise<PublicReindexResult> {
  return toPublicReindexResult(matterId, await reindexMatter(matterId));
}

/**
 * Resolve the renderer's revocable object identity against the current committed
 * index, then delete through the existing path-containment primitive. No path
 * supplied by the renderer reaches the filesystem.
 */
export function deleteIndexedDocument(
  matterId: string,
  documentId: string
): DeleteIndexedDocumentResult {
  // Validate the containing matter/documents chain before even reading the
  // index or creating its marker; a junction must never redirect either I/O.
  assertTrustedDocumentsDirectory(matterId);
  const document = resolveIndexedDocument(matterId, documentId);
  // Persist invalidation before the irreversible unlink. A crash can leave the
  // source file present, but it can never make the superseded index searchable.
  const ownsInvalidation = beginIndexInvalidation(matterId);
  try {
    deleteDocument(matterId, document.relativePath);
  } catch (err) {
    // deleteDocument performs all fallible metadata maintenance before unlink,
    // so a thrown operation has not committed and the prior index is reusable.
    if (!ownsInvalidation) {
      commitIndexInvalidation(matterId);
      throw new DocumentRollbackUncertainError(
        "Document removal did not complete while the case record already required reindexing. Reindex before practicing.",
        { cause: err }
      );
    }
    try {
      rollbackIndexInvalidation(matterId);
    } catch (rollbackErr) {
      commitIndexInvalidation(matterId);
      throw new DocumentRollbackUncertainError(
        "Document removal did not complete and the prior case record could not be safely restored. Reindex before practicing.",
        { cause: rollbackErr }
      );
    }
    throw err;
  }
  commitIndexInvalidation(matterId);
  return { deleted: document.id };
}

export function importMatterDocuments(matterId: string, filePaths: string[]): string[] {
  // Commit the durable marker before the first possible copy. If the process
  // exits between import and rebuild, restart can never serve the old record.
  const ownsInvalidation = beginIndexInvalidation(matterId);
  let imported: string[];
  try {
    imported = importFiles(matterId, filePaths);
  } catch (err) {
    if (err instanceof ImportRollbackUncertainError) {
      commitIndexInvalidation(matterId);
      throw err;
    }
    if (!ownsInvalidation) {
      commitIndexInvalidation(matterId);
      throw new ImportRollbackUncertainError(
        "Import failed while the case record already required reindexing. Reindex before practicing.",
        { cause: err }
      );
    }
    try {
      rollbackIndexInvalidation(matterId);
    } catch (rollbackErr) {
      commitIndexInvalidation(matterId);
      throw new ImportRollbackUncertainError(
        "Import failed and the prior case record could not be safely restored. Reindex before practicing.",
        { cause: rollbackErr }
      );
    }
    throw err;
  }
  if (imported.length) {
    commitIndexInvalidation(matterId);
  } else if (ownsInvalidation) {
    try {
      rollbackIndexInvalidation(matterId);
    } catch (rollbackErr) {
      commitIndexInvalidation(matterId);
      throw new ImportRollbackUncertainError(
        "The empty import could not restore the prior case record safely. Reindex before practicing.",
        { cause: rollbackErr }
      );
    }
  }
  return imported;
}

/** Serialize filesystem/index mutations for one matter while allowing different matters in parallel. */
export class DocumentMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(matterId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(matterId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(matterId, tail);
    return result.finally(() => {
      if (this.tails.get(matterId) === tail) this.tails.delete(matterId);
    });
  }
}
