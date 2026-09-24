import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionReviewDrawer, type SessionReviewData } from "../src/SessionReviewDrawer";

const review: SessionReviewData = {
  unfinished: false,
  session: {
    id: "session-1",
    matterId: "matter-1",
    personaId: "person-1",
    mode: "cross",
    startedAt: "2026-07-13T12:00:00.000Z",
    endedAt: "2026-07-13T12:10:00.000Z",
    transcript: [
      { role: "user", text: "You signed Exhibit Twelve?", at: "2026-07-13T12:01:00.000Z" },
      { role: "assistant", text: "I do not remember signing it.", at: "2026-07-13T12:01:04.000Z" },
      { role: "system", text: "Record search completed.", at: "2026-07-13T12:01:05.000Z" },
    ],
  },
  report: null,
  canOpenTranscript: false,
  canOpenReport: false,
  dataErrors: ["The optional report was unreadable."],
};

describe("SessionReviewDrawer transcript search", () => {
  it("filters by speaker or testimony and preserves original line numbers", async () => {
    render(
      <SessionReviewDrawer
        review={review}
        personaName="Jordan Lee"
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
        onGenerateReport={vi.fn()}
        reportGenerating={false}
        reportGenerationError={null}
        reportGenerationStatus={null}
      />
    );

    expect(screen.getByRole("alert").textContent).toContain("optional report was unreadable");
    const search = screen.getByRole("searchbox", { name: "Search transcript" });
    fireEvent.change(search, { target: { value: "jordan" } });

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 of 3 lines match"));
    expect(screen.getByText("I do not remember signing it.")).toBeTruthy();
    expect(screen.getByText("02")).toBeTruthy();
    expect(screen.queryByText("You signed Exhibit Twelve?")).toBeNull();

    const transcriptTab = screen.getByRole("tab", { name: "Transcript" });
    const reportTab = screen.getByRole("tab", { name: "Performance report" });
    expect(transcriptTab.getAttribute("aria-controls")).toBeTruthy();
    fireEvent.keyDown(transcriptTab, { key: "ArrowRight" });
    expect(reportTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(reportTab, { key: "ArrowLeft" });
    expect(transcriptTab.getAttribute("aria-selected")).toBe("true");

    const resumedSearch = screen.getByRole("searchbox", { name: "Search transcript" });
    fireEvent.change(resumedSearch, { target: { value: "missing phrase" } });
    await screen.findByText("No matching transcript lines");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("3 total lines"));
  });

  it("labels a hearing assistant line as the court", () => {
    render(
      <SessionReviewDrawer
        review={{
          ...review,
          session: { ...review.session, mode: "hearing", personaName: "Judge Kim" },
        }}
        personaName="Judge Kim"
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
        onGenerateReport={vi.fn()}
        reportGenerating={false}
        reportGenerationError={null}
        reportGenerationStatus={null}
      />
    );
    expect(screen.getByText("Court (Judge Kim)")).toBeTruthy();
  });

  it("identifies a transcript recovered from an interrupted checkpoint", () => {
    render(
      <SessionReviewDrawer
        review={{
          ...review,
          unfinished: true,
          session: { ...review.session, endedAt: undefined },
          dataErrors: [],
        }}
        personaName="Jordan Lee"
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
        onGenerateReport={vi.fn()}
        reportGenerating={false}
        reportGenerationError={null}
        reportGenerationStatus={null}
      />
    );

    const recovery = screen.getByRole("status", { name: "Interrupted session recovery" });
    expect(recovery.textContent).toContain("recovered from an automatic checkpoint");
    expect(screen.getByText("Interrupted")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    expect(screen.getByText(/recovered checkpoint may end abruptly/)).toBeTruthy();
  });

  it("discloses external report processing without an absolute privacy promise", () => {
    render(
      <SessionReviewDrawer
        review={{ ...review, dataErrors: [] }}
        personaName="Jordan Lee"
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
        onGenerateReport={vi.fn()}
        reportGenerating={false}
        reportGenerationError={null}
        reportGenerationStatus={null}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    expect(screen.getByText(/Generating sends the saved transcript to xAI for analysis/)).toBeTruthy();
    expect(
      screen.getByText(/On-device session files · external xAI processing when requested/)
    ).toBeTruthy();
    expect(screen.queryByText(/Counsel eyes only|stored locally/i)).toBeNull();
  });

  it("surfaces session-file failures inside the modal review", () => {
    render(
      <SessionReviewDrawer
        review={{ ...review, canOpenTranscript: true, dataErrors: [] }}
        personaName="Jordan Lee"
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
        onGenerateReport={vi.fn()}
        reportGenerating={false}
        reportGenerationError={null}
        reportGenerationStatus={null}
        artifactOpenError="The transcript export is unavailable."
      />
    );

    const error = screen.getByRole("alert");
    expect(error.textContent).toContain("Session file could not be opened");
    expect(error.textContent).toContain("transcript export is unavailable");
  });

  it("renders grounded technique evidence and opens its exact transcript line", async () => {
    render(
      <SessionReviewDrawer
        review={{
          ...review,
          dataErrors: [],
          report: {
            sessionId: review.session.id,
            matterCaption: "Example v. Example",
            personaName: "Jordan Lee",
            mode: "cross",
            generatedAt: "2026-07-15T12:10:00.000Z",
            summary: "Counsel established the document foundation.",
            admissions: [],
            hedges: [],
            inconsistencies: [],
            missedFollowUps: [],
            scorecard: {
              control: "Controlled",
              oneFactQuestions: "Mostly atomic",
              impeachment: "Not observed",
              form: "Professional",
              notes: "Continue.",
            },
            advocacy: {
              frameworkVersion: "2026.2",
              mode: "cross",
              diagnostics: {
                counselTurns: 1,
                caveat: "Confirm local form signals against the transcript.",
                metrics: [
                  {
                    id: "brief-questions",
                    label: "Questions at 12 words or fewer",
                    value: 1,
                    denominator: 1,
                    unit: "count",
                    note: "Operational proxy for short questions.",
                  },
                ],
              },
              skills: [
                {
                  skillId: "cross-one-fact",
                  label: "One fact, plain words",
                  rating: "strong",
                  evidence: [{
                    line: 1,
                    observation: "Counsel asked one factual proposition.",
                    excerpt: "You signed Exhibit Twelve?",
                  }],
                  coaching: "Keep each proposition independently answerable.",
                  drill: "Rewrite five compound questions.",
                },
              ],
              ethicalFlags: [],
            },
          },
        }}
        personaName="Jordan Lee"
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
        onGenerateReport={vi.fn()}
        reportGenerating={false}
        reportGenerationError={null}
        reportGenerationStatus={null}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));

    expect(screen.getByRole("heading", { name: "Technique diagnostics" })).toBeTruthy();
    expect(screen.getByText("Questions at 12 words or fewer")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "One fact, plain words" })).toBeTruthy();
    expect(screen.getByText("Counsel asked one factual proposition.")).toBeTruthy();
    expect(screen.getByText("You signed Exhibit Twelve?")).toBeTruthy();
    expect(screen.getByText("Rewrite five compound questions.")).toBeTruthy();
    expect(screen.getByText("No transcript-supported concerns identified.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open transcript line 1" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected"))
        .toBe("true")
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("You signed Exhibit Twelve?")
    );
  });

  it("exposes accessible generation, progress, and retry states inside the focus trap", async () => {
    const onGenerateReport = vi.fn();
    const cleanReview = { ...review, dataErrors: [] };
    const baseProps = {
      review: cleanReview,
      personaName: "Jordan Lee",
      onClose: vi.fn(),
      onOpenArtifact: vi.fn(),
      onGenerateReport,
      reportGenerationError: null,
      reportGenerationStatus: null,
    };
    const { rerender } = render(
      <SessionReviewDrawer {...baseProps} reportGenerating={false} />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Performance report" }));
    const panel = screen.getByRole("tabpanel", { name: "Performance report" });
    const generate = screen.getByRole("button", { name: "Generate performance report" });
    expect(panel.getAttribute("aria-busy")).toBe("false");
    expect(generate.getAttribute("aria-describedby")).toBeTruthy();

    generate.focus();
    fireEvent.keyDown(generate, { key: "Tab" });
    const close = screen.getByRole("button", { name: "Close session review" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(generate);

    fireEvent.click(generate);
    expect(onGenerateReport).toHaveBeenCalledOnce();

    rerender(<SessionReviewDrawer {...baseProps} reportGenerating />);
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Generating report…" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Analyzing the saved transcript");

    rerender(
      <SessionReviewDrawer
        {...baseProps}
        reportGenerating={false}
        reportGenerationError="The report service is temporarily unavailable."
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    const retry = screen.getByRole("button", { name: "Generate performance report" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    expect(onGenerateReport).toHaveBeenCalledTimes(2);
  });

  it("contains keyboard focus and restores it to the review trigger", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Review saved session</button>
          {open ? (
            <SessionReviewDrawer
              review={review}
              personaName="Jordan Lee"
              onClose={() => setOpen(false)}
              onOpenArtifact={vi.fn()}
              onGenerateReport={vi.fn()}
              reportGenerating={false}
              reportGenerationError={null}
              reportGenerationStatus={null}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Review saved session" });
    trigger.focus();
    fireEvent.click(trigger);

    const close = await screen.findByRole("button", { name: "Close session review" });
    const search = screen.getByRole("searchbox", { name: "Search transcript" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
