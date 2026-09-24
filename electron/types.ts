export type ExamMode = "cross" | "deposition" | "hearing";

export type Attitude = "hostile" | "evasive" | "cooperative" | "neutral" | "expert";

export interface Matter {
  id: string;
  caption: string;
  court: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Persona {
  id: string;
  matterId: string;
  fullName: string;
  role: string;
  attitude: Attitude;
  notes: string;
  keyterms: string[];
  /** xAI voice id for this witness (e.g. eve, ara, leo). Empty = app default. */
  voice: string;
  createdAt: string;
}

export interface DocumentMeta {
  id: string;
  matterId: string;
  fileName: string;
  relativePath: string;
  docType: string;
  witnessName: string;
  exhibitNo: string;
  pageCount: number;
  charCount: number;
  indexedAt: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  matterId: string;
  fileName: string;
  docType: string;
  witnessName: string;
  exhibitNo: string;
  pageHint: string;
  text: string;
}

export interface TranscriptLine {
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
}

export interface SessionRecord {
  id: string;
  matterId: string;
  personaId: string;
  /** Name captured when the exam started, so a later rename cannot relabel it. */
  personaName?: string;
  mode: ExamMode;
  startedAt: string;
  endedAt?: string;
  transcript: TranscriptLine[];
  reportPath?: string;
}

export interface SessionSetup {
  matterId: string;
  personaId: string;
  mode: ExamMode;
  voice?: string;
}

export interface SearchResult {
  chunkId: string;
  fileName: string;
  docType: string;
  witnessName: string;
  exhibitNo: string;
  pageHint: string;
  score: number;
  text: string;
}

export interface AppSettings {
  xaiApiKey: string;
  defaultVoice: string;
}

export type AdvocacySkillRating =
  | "strong"
  | "developing"
  | "needs-work"
  | "not-observed";

export interface AdvocacyDiagnosticMetric {
  id: string;
  label: string;
  value: number;
  denominator?: number;
  unit: "count" | "words";
  note: string;
}

export interface AdvocacyEvidence {
  /** One-based saved-transcript line. Null only for a preserved legacy report. */
  line: number | null;
  /** Bounded model observation about the referenced line. */
  observation: string;
  /** Trusted excerpt copied locally from the saved transcript. */
  excerpt: string;
}

export interface AdvocacyEthicalFinding {
  /** One-based saved-transcript line. Null only for a preserved legacy report. */
  line: number | null;
  concern: string;
  /** Trusted excerpt copied locally from the saved transcript. */
  excerpt: string;
}

export interface AdvocacySkillAssessment {
  skillId: string;
  label: string;
  rating: AdvocacySkillRating;
  /** Bounded observations paired with locally copied transcript excerpts. */
  evidence: AdvocacyEvidence[];
  coaching: string;
  drill: string;
}

export interface AdvocacyAnalysis {
  frameworkVersion: string;
  mode: ExamMode;
  diagnostics: {
    counselTurns: number;
    metrics: AdvocacyDiagnosticMetric[];
    caveat: string;
  };
  skills: AdvocacySkillAssessment[];
  ethicalFlags: AdvocacyEthicalFinding[];
}

export interface SessionReport {
  sessionId: string;
  matterCaption: string;
  personaName: string;
  mode: ExamMode;
  generatedAt: string;
  summary: string;
  admissions: string[];
  hedges: string[];
  inconsistencies: string[];
  missedFollowUps: string[];
  scorecard: {
    control: string;
    oneFactQuestions: string;
    impeachment: string;
    form: string;
    notes: string;
  };
  advocacy: AdvocacyAnalysis;
}
