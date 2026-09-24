import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

type ExamMode = "cross" | "deposition" | "hearing";

export interface ReviewTranscriptLine {
  role: string;
  text: string;
  at: string;
}

export interface SessionReviewData {
  /** True when the app recovered a live checkpoint that never finalized normally. */
  unfinished: boolean;
  session: {
    id: string;
    matterId: string;
    personaId: string;
    personaName?: string;
    mode: ExamMode;
    startedAt: string;
    endedAt?: string;
    transcript: ReviewTranscriptLine[];
  };
  report: {
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
    advocacy?: {
      frameworkVersion: string;
      mode: ExamMode;
      diagnostics: {
        counselTurns: number;
        metrics: Array<{
          id: string;
          label: string;
          value: number;
          denominator?: number;
          unit: "count" | "words";
          note: string;
        }>;
        caveat: string;
      };
      skills: Array<{
        skillId: string;
        label: string;
        rating: "strong" | "developing" | "needs-work" | "not-observed";
        evidence: Array<{
          line: number | null;
          observation: string;
          excerpt: string;
        }>;
        coaching: string;
        drill: string;
      }>;
      ethicalFlags: Array<{
        line: number | null;
        concern: string;
        excerpt: string;
      }>;
    };
  } | null;
  canOpenTranscript: boolean;
  canOpenReport: boolean;
  dataErrors?: string[];
}

interface Props {
  review: SessionReviewData;
  personaName: string;
  onClose: () => void;
  onOpenArtifact: (kind: "transcript" | "report") => void;
  onGenerateReport: () => void;
  reportGenerating: boolean;
  reportGenerationError: string | null;
  reportGenerationStatus: string | null;
  artifactOpenError?: string | null;
  /** Stable opener captured before the async review load starts. */
  returnFocusTo?: HTMLElement | null;
}

const REVIEW_FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function modeLabel(mode: ExamMode): string {
  if (mode === "hearing") return "Hearing practice";
  if (mode === "deposition") return "Deposition";
  return "Cross-examination";
}

function durationLabel(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Not recorded";
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function transcriptSpeaker(role: string, personaName: string, mode: ExamMode): string {
  if (role === "user") return "Counsel";
  if (role === "assistant") {
    if (mode === "hearing") return personaName ? `Court (${personaName})` : "Court";
    return personaName || "Witness";
  }
  return "Record";
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="review-report-section">
      <h3>{title}</h3>
      {items.length ? (
        <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
      ) : (
        <p className="review-empty-copy">None identified.</p>
      )}
    </section>
  );
}

export function SessionReviewDrawer({
  review,
  personaName,
  onClose,
  onOpenArtifact,
  onGenerateReport,
  reportGenerating,
  reportGenerationError,
  reportGenerationStatus,
  artifactOpenError = null,
  returnFocusTo,
}: Props) {
  const [tab, setTab] = useState<"transcript" | "report">("transcript");
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const searchInputId = useId();
  const searchStatusId = useId();
  const transcriptTabId = useId();
  const transcriptPanelId = useId();
  const reportTabId = useId();
  const reportPanelId = useId();
  const reportActionTitleId = useId();
  const reportActionDescriptionId = useId();
  const reportProcessingDisclosureId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { session, unfinished, report, dataErrors = [] } = review;
  const deferredQuery = useDeferredValue(transcriptQuery);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
  const searchPending = transcriptQuery.trim().toLocaleLowerCase() !== normalizedQuery;
  const transcriptRows = useMemo(
    () => session.transcript.map((line, index) => {
      const speaker = transcriptSpeaker(line.role, personaName, session.mode);
      return {
        line,
        index,
        speaker,
        searchText: `${speaker}\n${line.text}`.toLocaleLowerCase(),
      };
    }),
    [personaName, session.transcript]
  );
  const filteredTranscriptRows = useMemo(
    () => normalizedQuery
      ? transcriptRows.filter((row) => row.searchText.includes(normalizedQuery))
      : transcriptRows,
    [normalizedQuery, transcriptRows]
  );
  const speechLines = useMemo(
    () => session.transcript.reduce((count, line) => count + (line.role === "system" ? 0 : 1), 0),
    [session.transcript]
  );
  const transcriptTotal = transcriptRows.length;
  const resultFeedback = searchPending
    ? "Updating results…"
    : normalizedQuery
      ? `${filteredTranscriptRows.length} of ${transcriptTotal} ${transcriptTotal === 1 ? "line" : "lines"} match`
      : `${transcriptTotal} total ${transcriptTotal === 1 ? "line" : "lines"}`;

  const [pendingRevealLine, setPendingRevealLine] = useState<number | null>(null);

  const revealTranscriptLine = (lineNumber: number) => {
    setTranscriptQuery("");
    setTab("transcript");
    setPendingRevealLine(lineNumber);
  };

  // Perform the scroll/focus only after the commit in which the transcript tab
  // is active and the deferred search filter has actually cleared. A fixed
  // double-rAF could fire before that commit on large transcripts, silently
  // doing nothing when the cited row was filtered out.
  useEffect(() => {
    if (pendingRevealLine === null) return;
    if (tab !== "transcript" || normalizedQuery !== "") return;
    const target = document.getElementById(
      `${transcriptPanelId}-line-${pendingRevealLine}`
    );
    setPendingRevealLine(null);
    if (!target) return;
    target.scrollIntoView?.({ block: "center", behavior: "auto" });
    target.focus({ preventScroll: true });
  }, [pendingRevealLine, tab, normalizedQuery, transcriptPanelId]);

  useEffect(() => {
    returnFocusRef.current = returnFocusTo?.isConnected
      ? returnFocusTo
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  const trapTab = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(REVIEW_FOCUSABLE));
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="review-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="session-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-review-title"
        tabIndex={-1}
        onKeyDown={trapTab}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="review-header">
          <div>
            <h2 id="session-review-title">{personaName}</h2>
            <p>{modeLabel(session.mode)} · {new Date(session.startedAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="review-close"
            onClick={onClose}
            aria-label="Close session review"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="review-metrics" aria-label="Session summary">
          <div>
            <strong>{unfinished ? "Interrupted" : durationLabel(session.startedAt, session.endedAt)}</strong>
            <span>{unfinished ? "Session state" : "Duration"}</span>
          </div>
          <div><strong>{speechLines}</strong><span>Spoken lines</span></div>
          <div>
            <strong aria-live="polite">
              {reportGenerating ? "Generating…" : report ? "Ready" : "Not generated"}
            </strong>
            <span>Performance report</span>
          </div>
        </div>

        <div className="review-tabs" role="tablist" aria-label="Session review sections">
          <button
            id={transcriptTabId}
            type="button"
            role="tab"
            aria-selected={tab === "transcript"}
            aria-controls={transcriptPanelId}
            tabIndex={tab === "transcript" ? 0 : -1}
            className={tab === "transcript" ? "active" : ""}
            onClick={() => setTab("transcript")}
            onKeyDown={(event) => {
              if (event.key === "Home") {
                event.preventDefault();
                event.currentTarget.focus();
                return;
              }
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "End") return;
              event.preventDefault();
              setTab("report");
              requestAnimationFrame(() => document.getElementById(reportTabId)?.focus());
            }}
          >
            Transcript
          </button>
          <button
            id={reportTabId}
            type="button"
            role="tab"
            aria-selected={tab === "report"}
            aria-controls={reportPanelId}
            tabIndex={tab === "report" ? 0 : -1}
            className={tab === "report" ? "active" : ""}
            onClick={() => setTab("report")}
            onKeyDown={(event) => {
              if (event.key === "End") {
                event.preventDefault();
                event.currentTarget.focus();
                return;
              }
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
              event.preventDefault();
              setTab("transcript");
              requestAnimationFrame(() => document.getElementById(transcriptTabId)?.focus());
            }}
          >
            Performance report
          </button>
        </div>

        <div className="review-body">
          {unfinished ? (
            <div
              className="review-interrupted-warning"
              role="status"
              aria-label="Interrupted session recovery"
            >
              <strong>Interrupted session recovered from an automatic checkpoint.</strong>
              <span>
                The app did not record a normal ending. The saved transcript remains available,
                but it may stop abruptly and a performance report may be unavailable.
              </span>
            </div>
          ) : null}
          {dataErrors.length > 0 && (
            <div className="review-data-warning" role="alert">
              <strong>Some saved review data could not be loaded.</strong>
              <span>{dataErrors.join(" · ")} The transcript remains available.</span>
            </div>
          )}
          {tab === "transcript" ? (
            <div
              id={transcriptPanelId}
              className="review-transcript"
              role="tabpanel"
              aria-labelledby={transcriptTabId}
            >
              <div className="review-transcript-search" role="search" aria-label="Search saved transcript">
                <label htmlFor={searchInputId}>Search transcript</label>
                <div className="review-search-controls">
                  <input
                    id={searchInputId}
                    type="search"
                    value={transcriptQuery}
                    onChange={(event) => setTranscriptQuery(event.target.value)}
                    placeholder="Search speakers or testimony"
                    autoComplete="off"
                    aria-describedby={searchStatusId}
                    disabled={!transcriptTotal}
                  />
                  {transcriptQuery && (
                    <button
                      type="button"
                      className="ghost review-search-clear"
                      onClick={() => setTranscriptQuery("")}
                      aria-label="Clear transcript search"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p
                  id={searchStatusId}
                  className={`review-search-status ${searchPending ? "pending" : ""}`}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {resultFeedback}
                </p>
              </div>

              <div className={searchPending ? "review-search-results pending" : "review-search-results"} aria-busy={searchPending}>
                {filteredTranscriptRows.map(({ line, index, speaker }) => (
                  <div
                    id={`${transcriptPanelId}-line-${index + 1}`}
                    key={`${line.at}-${index}`}
                    className={`review-line ${line.role}`}
                    tabIndex={-1}
                  >
                    <span className="review-line-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className="review-speaker">{speaker}</span>
                    <p>{line.text}</p>
                  </div>
                ))}
                {!transcriptTotal && <p className="review-empty-state">This session has no saved transcript lines.</p>}
                {Boolean(transcriptTotal && normalizedQuery && !filteredTranscriptRows.length) && (
                  <div className="review-search-empty">
                    <strong>No matching transcript lines</strong>
                    <p>No speaker or testimony matches “{deferredQuery.trim()}”.</p>
                    <button type="button" onClick={() => setTranscriptQuery("")}>Clear search</button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              id={reportPanelId}
              className={`review-report ${report ? "" : "review-report-missing"}`.trim()}
              role="tabpanel"
              aria-labelledby={reportTabId}
              aria-busy={reportGenerating}
            >
              <section
                className="review-report-action"
                aria-labelledby={reportActionTitleId}
                aria-describedby={`${reportActionDescriptionId} ${reportProcessingDisclosureId}`}
              >
                <div>
                  <h3 id={reportActionTitleId}>
                    {report ? "Performance report ready" : "Generate a performance report"}
                  </h3>
                  <p id={reportActionDescriptionId}>
                    {report
                      ? "Regenerating replaces the current coaching analysis. Your saved transcript remains unchanged."
                      : "Create coaching analysis from this saved transcript. Generation may take a minute and does not alter the testimony."}
                  </p>
                  <p
                    id={reportProcessingDisclosureId}
                    className="review-report-disclosure"
                  >
                    Generating sends the saved transcript to xAI for analysis. The resulting
                    report is saved on this device; submitted content is handled under the data
                    and retention terms for your xAI account.
                  </p>
                </div>
                <button
                  type="button"
                  className={report ? "ghost" : "primary"}
                  disabled={reportGenerating}
                  onClick={onGenerateReport}
                  aria-describedby={`${reportActionDescriptionId} ${reportProcessingDisclosureId}`}
                >
                  {reportGenerating
                    ? report
                      ? "Regenerating report…"
                      : "Generating report…"
                    : report
                      ? "Regenerate performance report"
                      : "Generate performance report"}
                </button>
              </section>
              {reportGenerating ? (
                <div className="review-report-progress" role="status" aria-live="polite">
                  <span className="review-report-spinner" aria-hidden="true" />
                  Analyzing the saved transcript. You can close this review and return later.
                </div>
              ) : null}
              {reportGenerationError ? (
                <div className="review-report-error" role="alert">
                  <strong>Report generation failed.</strong>
                  <span>{reportGenerationError} Your saved transcript{report ? " and current report are" : " is"} unchanged.</span>
                </div>
              ) : null}
              {reportGenerationStatus && !reportGenerating ? (
                <div className="review-report-success" role="status" aria-live="polite">
                  {reportGenerationStatus}
                </div>
              ) : null}

              {report ? (
                <>
                  <section className="review-summary">
                    <h3>Assessment</h3>
                    <p>{report.summary || "No narrative assessment was returned."}</p>
                  </section>
                  <div className="review-report-grid">
                    <ReviewList title="Admissions secured" items={report.admissions || []} />
                    <ReviewList title="Hedges and evasions" items={report.hedges || []} />
                    <ReviewList title="Impeachment hooks" items={report.inconsistencies || []} />
                    <ReviewList title="Missed follow-ups" items={report.missedFollowUps || []} />
                  </div>
                  <section className="review-scorecard">
                    <h3>Advocacy scorecard</h3>
                    <dl>
                      <div><dt>Control</dt><dd>{report.scorecard.control || "Not scored"}</dd></div>
                      <div><dt>One-fact questions</dt><dd>{report.scorecard.oneFactQuestions || "Not scored"}</dd></div>
                      <div><dt>Impeachment</dt><dd>{report.scorecard.impeachment || "Not scored"}</dd></div>
                      <div><dt>Form</dt><dd>{report.scorecard.form || "Not scored"}</dd></div>
                      <div className="scorecard-notes"><dt>Coach’s notes</dt><dd>{report.scorecard.notes || "No additional notes."}</dd></div>
                    </dl>
                  </section>
                  {report.advocacy ? (
                    <section className="review-advocacy" aria-labelledby="advocacy-method-title">
                      <header className="review-advocacy-header">
                        <div>
                          <span className="review-method-version">
                            Method {report.advocacy.frameworkVersion}
                          </span>
                          <h3 id="advocacy-method-title">Technique diagnostics</h3>
                        </div>
                        <p>{report.advocacy.diagnostics.caveat}</p>
                      </header>

                      <dl className="review-signal-grid">
                        {report.advocacy.diagnostics.metrics.map((metric) => (
                          <div key={metric.id}>
                            <dt>{metric.label}</dt>
                            <dd>
                              <strong>
                                {metric.value}
                                {metric.denominator === undefined
                                  ? metric.unit === "words" ? " words" : ""
                                  : ` / ${metric.denominator}`}
                              </strong>
                              <span>{metric.note}</span>
                            </dd>
                          </div>
                        ))}
                      </dl>

                      <div className="review-skill-list">
                        {report.advocacy.skills.map((skill) => (
                          <article key={skill.skillId} className="review-skill-card">
                            <header>
                              <h4>{skill.label}</h4>
                              <span className={`skill-rating ${skill.rating}`}>
                                {skill.rating.replace("-", " ")}
                              </span>
                            </header>
                            {skill.evidence.length ? (
                              <ul className="review-skill-evidence">
                                {skill.evidence.map((evidence, index) => (
                                  <li key={`${skill.skillId}-evidence-${index}`}>
                                    <div>
                                      {evidence.line === null ? (
                                        <span className="review-line-reference legacy">
                                          Legacy · unreferenced
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          className="review-line-reference"
                                          onClick={() => revealTranscriptLine(evidence.line!)}
                                          aria-label={`Open transcript line ${evidence.line}`}
                                        >
                                          Line {String(evidence.line).padStart(2, "0")}
                                        </button>
                                      )}
                                      <span>{evidence.observation}</span>
                                    </div>
                                    {evidence.excerpt ? <blockquote>{evidence.excerpt}</blockquote> : null}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="review-empty-copy">No transcript evidence identified.</p>
                            )}
                            <p><strong>Next move</strong>{skill.coaching}</p>
                            <p><strong>Drill</strong>{skill.drill}</p>
                          </article>
                        ))}
                      </div>

                      <section className="review-ethical-flags" aria-label="Ethical and record-integrity review">
                        <h4>Ethical and record-integrity review</h4>
                        {report.advocacy.ethicalFlags.length ? (
                          <ul>
                            {report.advocacy.ethicalFlags.map((flag, index) => (
                              <li key={`ethical-flag-${index}`}>
                                <div>
                                  {flag.line === null ? (
                                    <span className="review-line-reference legacy">
                                      Legacy · unreferenced
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      className="review-line-reference"
                                      onClick={() => revealTranscriptLine(flag.line!)}
                                      aria-label={`Open transcript line ${flag.line}`}
                                    >
                                      Line {String(flag.line).padStart(2, "0")}
                                    </button>
                                  )}
                                  <span>{flag.concern}</span>
                                </div>
                                {flag.excerpt ? <blockquote>{flag.excerpt}</blockquote> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>No transcript-supported concerns identified.</p>
                        )}
                      </section>
                    </section>
                  ) : null}
                </>
              ) : (
                <div className="review-report-empty-copy">
                  <strong>No performance report has been generated yet.</strong>
                  <p>
                    {unfinished
                      ? "This recovered checkpoint may end abruptly, but its saved testimony can still be analyzed."
                      : "The transcript remains available whether or not you generate coaching analysis."}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="review-footer">
          {artifactOpenError ? (
            <div className="review-artifact-error" role="alert">
              <strong>Session file could not be opened.</strong>
              <span>{artifactOpenError}</span>
            </div>
          ) : null}
          <span>On-device session files · external xAI processing when requested</span>
          <div className="row">
            {review.canOpenTranscript && <button type="button" onClick={() => onOpenArtifact("transcript")}>Open transcript file</button>}
            {review.canOpenReport && <button type="button" className="primary" onClick={() => onOpenArtifact("report")}>Open report file</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
