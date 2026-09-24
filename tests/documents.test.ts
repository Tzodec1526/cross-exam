// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => {
  class ImportRollbackUncertainError extends Error {
    constructor(message: string, options: { cause?: unknown } = {}) {
      super(message, options);
      this.name = "ImportRollbackUncertainError";
    }
  }

  return {
    beginIndexInvalidation: vi.fn(),
    commitIndexInvalidation: vi.fn(),
    listDocuments: vi.fn(),
    reindexMatter: vi.fn(),
    rollbackIndexInvalidation: vi.fn(),
    resolveIndexedDocument: vi.fn(),
    assertTrustedDocumentsDirectory: vi.fn(),
    deleteDocument: vi.fn(),
    ImportRollbackUncertainError,
    importFiles: vi.fn(),
  };
});

vi.mock("../electron/services/indexer.js", () => ({
  beginIndexInvalidation: serviceMocks.beginIndexInvalidation,
  commitIndexInvalidation: serviceMocks.commitIndexInvalidation,
  listDocuments: serviceMocks.listDocuments,
  reindexMatter: serviceMocks.reindexMatter,
  rollbackIndexInvalidation: serviceMocks.rollbackIndexInvalidation,
  resolveIndexedDocument: serviceMocks.resolveIndexedDocument,
}));

vi.mock("../electron/services/matters.js", () => ({
  assertTrustedDocumentsDirectory: serviceMocks.assertTrustedDocumentsDirectory,
  deleteDocument: serviceMocks.deleteDocument,
  ImportRollbackUncertainError: serviceMocks.ImportRollbackUncertainError,
  importFiles: serviceMocks.importFiles,
}));

import {
  deleteIndexedDocument,
  DocumentMutationCoordinator,
  importMatterDocuments,
  listPublicDocuments,
  toPublicDocuments,
  toPublicReindexResult,
} from "../electron/services/documents";
import type { DocumentMeta } from "../electron/types";

const matterId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";

function indexedDocument(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: documentId,
    matterId,
    fileName: "Exhibit 12.pdf",
    relativePath: "production/Exhibit 12.pdf",
    docType: "exhibit",
    witnessName: "",
    exhibitNo: "12",
    pageCount: 4,
    charCount: 12_345,
    indexedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.beginIndexInvalidation.mockReturnValue(true);
  serviceMocks.listDocuments.mockReturnValue([indexedDocument()]);
  serviceMocks.assertTrustedDocumentsDirectory.mockReturnValue("C:\\trusted\\documents");
  serviceMocks.resolveIndexedDocument.mockReturnValue(indexedDocument());
  serviceMocks.deleteDocument.mockReturnValue({ deleted: "production/Exhibit 12.pdf" });
});

describe("public document capabilities", () => {
  it("projects only renderer-needed metadata and strips local ownership paths", () => {
    const result = listPublicDocuments(matterId);

    expect(result).toEqual([
      {
        id: documentId,
        fileName: "Exhibit 12.pdf",
        docType: "exhibit",
        pageCount: 4,
        charCount: 12_345,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("relativePath");
    expect(JSON.stringify(result)).not.toContain("matterId");
    expect(JSON.stringify(result)).not.toContain("production/");
  });

  it("rejects duplicate, cross-matter, and malformed persisted document identities", () => {
    expect(() => toPublicDocuments(matterId, [indexedDocument(), indexedDocument()])).toThrow(
      "case record index is invalid"
    );
    expect(() =>
      toPublicDocuments(matterId, [
        indexedDocument({ matterId: "33333333-3333-4333-8333-333333333333" }),
      ])
    ).toThrow("case record index is invalid");
    expect(() =>
      toPublicDocuments(matterId, [indexedDocument({ relativePath: "" })])
    ).toThrow("case record index is invalid");
    expect(() =>
      toPublicDocuments(matterId, [
        indexedDocument({ fileName: "Shown.pdf", relativePath: "hidden/Other.pdf" }),
      ])
    ).toThrow("case record index is invalid");
  });

  it("redacts index warnings and returns a bounded path-free rebuild result", () => {
    const result = toPublicReindexResult(matterId, {
      matterId,
      documentCount: 99,
      chunkCount: 7,
      documents: [indexedDocument()],
      issues: [
        {
          fileName: "broken.pdf",
          relativePath: "private/broken.pdf",
          message: "Could not read C:\\Users\\counsel\\Private\\broken.pdf",
        },
      ],
    });

    expect(result.documentCount).toBe(1);
    expect(result.chunkCount).toBe(7);
    expect(result.issues[0]?.fileName).toBe("broken.pdf");
    expect(result.issues[0]?.message).not.toContain("counsel");
    expect(JSON.stringify(result)).not.toContain("relativePath");
    expect(JSON.stringify(result)).not.toContain("private/broken.pdf");
  });

  it("deletes only the path resolved from the current indexed identity", () => {
    expect(deleteIndexedDocument(matterId, documentId)).toEqual({ deleted: documentId });
    expect(serviceMocks.assertTrustedDocumentsDirectory).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.resolveIndexedDocument).toHaveBeenCalledWith(matterId, documentId);
    expect(serviceMocks.deleteDocument).toHaveBeenCalledWith(
      matterId,
      "production/Exhibit 12.pdf"
    );
    expect(serviceMocks.beginIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.commitIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.rollbackIndexInvalidation).not.toHaveBeenCalled();

    serviceMocks.resolveIndexedDocument.mockImplementationOnce(() => {
      throw new Error("stale capability");
    });
    expect(() => deleteIndexedDocument(matterId, documentId)).toThrow("stale capability");
    expect(serviceMocks.deleteDocument).toHaveBeenCalledTimes(1);
    expect(serviceMocks.beginIndexInvalidation).toHaveBeenCalledTimes(1);
    expect(serviceMocks.commitIndexInvalidation).toHaveBeenCalledTimes(1);
  });

  it("restores the prior index when deletion is rejected before unlink", () => {
    serviceMocks.deleteDocument.mockImplementationOnce(() => {
      throw new Error("metadata write failed");
    });

    expect(() => deleteIndexedDocument(matterId, documentId)).toThrow(
      "metadata write failed"
    );
    expect(serviceMocks.beginIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.rollbackIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.commitIndexInvalidation).not.toHaveBeenCalled();
  });

  it("keeps recovery explicit when a failed delete cannot restore its marker", () => {
    serviceMocks.deleteDocument.mockImplementationOnce(() => {
      throw new Error("metadata write failed");
    });
    serviceMocks.rollbackIndexInvalidation.mockImplementationOnce(() => {
      throw new Error("marker locked");
    });

    expect(() => deleteIndexedDocument(matterId, documentId)).toThrow(
      "prior case record could not be safely restored"
    );
    expect(serviceMocks.commitIndexInvalidation).toHaveBeenCalledWith(matterId);
  });

  it("rejects an untrusted documents chain before reading or marking its index", () => {
    serviceMocks.assertTrustedDocumentsDirectory.mockImplementationOnce(() => {
      throw new Error("not a trusted directory");
    });

    expect(() => deleteIndexedDocument(matterId, documentId)).toThrow(
      "not a trusted directory"
    );
    expect(serviceMocks.resolveIndexedDocument).not.toHaveBeenCalled();
    expect(serviceMocks.beginIndexInvalidation).not.toHaveBeenCalled();
    expect(serviceMocks.deleteDocument).not.toHaveBeenCalled();
  });
});

describe("import index invalidation lifecycle", () => {
  it("commits invalidation after a successful non-empty import", () => {
    const order: string[] = [];
    serviceMocks.beginIndexInvalidation.mockImplementationOnce(() => order.push("begin"));
    serviceMocks.importFiles.mockImplementationOnce(() => {
      order.push("import");
      return ["Imported.pdf"];
    });
    serviceMocks.commitIndexInvalidation.mockImplementationOnce(() => order.push("commit"));

    expect(importMatterDocuments(matterId, ["C:\\incoming\\Imported.pdf"])).toEqual([
      "Imported.pdf",
    ]);
    expect(order).toEqual(["begin", "import", "commit"]);
    expect(serviceMocks.rollbackIndexInvalidation).not.toHaveBeenCalled();
  });

  it("restores the prior index after an import failure with verified cleanup", () => {
    const failure = new Error("copy failed after verified cleanup");
    serviceMocks.importFiles.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => importMatterDocuments(matterId, ["C:\\incoming\\Broken.pdf"])).toThrow(
      failure
    );
    expect(serviceMocks.beginIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.rollbackIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.commitIndexInvalidation).not.toHaveBeenCalled();
  });

  it("keeps the old index invalidated when import cleanup is uncertain", () => {
    const failure = new serviceMocks.ImportRollbackUncertainError(
      "destination cleanup could not be verified"
    );
    serviceMocks.importFiles.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => importMatterDocuments(matterId, ["C:\\incoming\\Broken.pdf"])).toThrow(
      failure
    );
    expect(serviceMocks.beginIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.commitIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.rollbackIndexInvalidation).not.toHaveBeenCalled();
  });

  it("never rolls back an invalidation owned by an earlier source mutation", () => {
    serviceMocks.beginIndexInvalidation.mockReturnValueOnce(false);
    serviceMocks.importFiles.mockImplementationOnce(() => {
      throw new Error("second import failed with verified cleanup");
    });

    expect(() => importMatterDocuments(matterId, ["C:\\incoming\\Broken.pdf"])).toThrow(
      serviceMocks.ImportRollbackUncertainError
    );
    expect(serviceMocks.commitIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.rollbackIndexInvalidation).not.toHaveBeenCalled();
  });

  it("keeps invalidation committed when restoring the prior marker state fails", () => {
    serviceMocks.importFiles.mockImplementationOnce(() => {
      throw new Error("copy failed");
    });
    serviceMocks.rollbackIndexInvalidation.mockImplementationOnce(() => {
      throw new Error("marker locked");
    });

    expect(() => importMatterDocuments(matterId, ["C:\\incoming\\Broken.pdf"])).toThrow(
      serviceMocks.ImportRollbackUncertainError
    );
    expect(serviceMocks.commitIndexInvalidation).toHaveBeenCalledWith(matterId);
  });

  it("rolls invalidation back when the import selection is empty", () => {
    serviceMocks.importFiles.mockReturnValueOnce([]);

    expect(importMatterDocuments(matterId, [])).toEqual([]);
    expect(serviceMocks.beginIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.rollbackIndexInvalidation).toHaveBeenCalledWith(matterId);
    expect(serviceMocks.commitIndexInvalidation).not.toHaveBeenCalled();
  });
});

describe("document mutation coordination", () => {
  it("serializes one matter while allowing another matter to proceed", async () => {
    const coordinator = new DocumentMutationCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.run(matterId, async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = coordinator.run(matterId, () => {
      order.push("second");
    });
    const other = coordinator.run("33333333-3333-4333-8333-333333333333", () => {
      order.push("other");
    });

    await other;
    expect(order).toEqual(["first:start", "other"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });
});
