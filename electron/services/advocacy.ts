import type {
  AdvocacyAnalysis,
  AdvocacyDiagnosticMetric,
  AdvocacyEthicalFinding,
  AdvocacySkillAssessment,
  ExamMode,
  TranscriptLine,
} from "../types.js";

export const ADVOCACY_FRAMEWORK_VERSION = "2026.2";

export type AdvocacySkillDefinition = Readonly<{
  id: string;
  label: string;
  objective: string;
  observable: string;
}>;

const SHARED_ETHICS = `ETHICAL FLOOR (never score around it):
- Do not reward a false premise, invented fact, distorted authority, harassment, humiliation, or argument unsupported by the case record.
- Treat a candid "I do not know" or a narrow, accurate concession as stronger advocacy than bluffing.
- Distinguish forceful control from quarrelling. Professional restraint and record accuracy are advocacy skills.`;

const CROSS_SKILLS: readonly AdvocacySkillDefinition[] = [
  {
    id: "cross-chapters",
    label: "Chapters and theory",
    objective: "Organize the examination into short factual chapters that each advance a case theory.",
    observable: "Clear topic transitions, purposeful sequence, strongest usable facts, and no aimless chronology.",
  },
  {
    id: "cross-leading-control",
    label: "Leading control",
    objective: "State supportable propositions that keep the fact source with counsel.",
    observable: "Predominantly closed or leading form, no invitation to repeat harmful direct testimony, and calm control of evasions.",
  },
  {
    id: "cross-one-fact",
    label: "One fact, plain words",
    objective: "Use short questions containing one independently answerable factual proposition.",
    observable: "Plain language, minimal conjunctions, no compound ambiguity, and a clean transcript.",
  },
  {
    id: "cross-listening",
    label: "Listening and follow-through",
    objective: "Hear the actual answer and make the next question respond to it.",
    observable: "Useful follow-ups, correction of nonanswers, no stale script repetition, and exploitation of volunteered facts without losing the chapter.",
  },
  {
    id: "cross-concessions",
    label: "Concessions before attack",
    objective: "Secure helpful, low-risk facts before challenging credibility.",
    observable: "Foundation and favorable concessions are completed before confrontation; accepted points are not reopened.",
  },
  {
    id: "cross-impeachment",
    label: "Impeachment discipline",
    objective: "Commit the witness, credit the prior source, confront with the exact inconsistency, permit the answer, then stop when the point is made.",
    observable: "Accurate source/date/context, material contradiction, a fair opportunity to explain or deny, no paraphrase distortion, and no demand that the witness agree with counsel's argument.",
  },
  {
    id: "cross-restraint",
    label: "Restraint and landing",
    objective: "Take the useful answer and end the chapter before asking the question too many.",
    observable: "No quarrelling, repetition, victory lap, or ultimate argumentative question; strong points are left for summation.",
  },
  {
    id: "cross-record-ethics",
    label: "Record fidelity and fairness",
    objective: "Press firmly within the evidence, governing rules, and fair treatment of the witness.",
    observable: "Supported premises, accurate documents, proportional tone, and no harassment or invented facts.",
  },
];

const DEPOSITION_SKILLS: readonly AdvocacySkillDefinition[] = [
  {
    id: "depo-topics",
    label: "Issue map and sequence",
    objective: "Cover the noticed or relevant subjects in a deliberate order while preserving usable testimony.",
    observable: "Clear topic blocks, foundations before conclusions, and completion of one subject before transition.",
  },
  {
    id: "depo-funnel",
    label: "Discovery funnel",
    objective: "Use open questions to discover, then narrow questions to define and test the account.",
    observable: "Appropriate who/what/when/where/how exploration followed by precise confirmation rather than premature cross-examination only.",
  },
  {
    id: "depo-foundation",
    label: "Knowledge foundation",
    objective: "Separate personal knowledge, documents, hearsay, assumptions, and organizational information.",
    observable: "Questions identify source, time, participants, basis of knowledge, and limits of recollection.",
  },
  {
    id: "depo-lockdown",
    label: "Clarify and lock down",
    objective: "Turn material testimony into unambiguous propositions and exhaust reasonable alternatives.",
    observable: "Defined terms, resolved pronouns and dates, quantified estimates, and fair 'anything else' completion questions.",
  },
  {
    id: "depo-listening",
    label: "Listening and follow-through",
    objective: "Follow new facts to their source without abandoning the examination plan.",
    observable: "Answer-linked follow-ups, nonanswer repair, and no rote move to the next outline question.",
  },
  {
    id: "depo-documents",
    label: "Document handling",
    objective: "Identify, authenticate, orient, and question from documents without mischaracterizing them.",
    observable: "Clear exhibit identity, location, authorship/receipt foundation, exact language, and preserved context.",
  },
  {
    id: "depo-form-record",
    label: "Clean record",
    objective: "Create testimony that can be read and used later without avoidable ambiguity.",
    observable: "One speaker at a time, short noncompound questions, verbal answers, and concise handling of objections.",
  },
  {
    id: "depo-fairness",
    label: "Efficiency and fairness",
    objective: "Examine thoroughly without impeding, badgering, or needlessly prolonging the deposition.",
    observable: "Proportionate coverage, professional tone, no coaching, and respect for privilege and lawful limits.",
  },
];

const HEARING_SKILLS: readonly AdvocacySkillDefinition[] = [
  {
    id: "hearing-answer-first",
    label: "Answer first",
    objective: "Answer the court's question immediately, then explain only as needed.",
    observable: "A tailored yes/no or direct conclusion leads; counsel does not defer, evade, or bury the answer.",
  },
  {
    id: "hearing-rule",
    label: "Rule and standard",
    objective: "State the governing rule, burden, and standard of review accurately and compactly.",
    observable: "Correct legal test, allocation of burden, and connection between rule and requested result.",
  },
  {
    id: "hearing-record",
    label: "Record and authority",
    objective: "Anchor material assertions in the record and cite only authority that truly supports them.",
    observable: "Specific record cites, accurate holdings, candid treatment of adverse authority, and no facts outside the record without disclosure.",
  },
  {
    id: "hearing-hypotheticals",
    label: "Hypotheticals and limits",
    objective: "Engage the court's hypothetical and articulate a workable limiting principle.",
    observable: "Answer on the assumed facts first, identify the line, and only then distinguish the actual case if useful.",
  },
  {
    id: "hearing-concessions",
    label: "Credible concessions",
    objective: "Concede what must be conceded without surrendering the dispositive principle.",
    observable: "Narrow, direct concessions; bad facts acknowledged; no exaggeration or defensive retreat.",
  },
  {
    id: "hearing-structure",
    label: "Structure under pressure",
    objective: "Keep a clear theory while allowing questions to control the order of argument.",
    observable: "Strongest points prioritized, transitions recover the thread, and counsel does not recite a speech over the court.",
  },
  {
    id: "hearing-remedy",
    label: "Relief and consequences",
    objective: "State the precise relief requested and explain the practical consequences of the proposed rule.",
    observable: "Clear disposition, administrable rule, and answers to downstream or line-drawing concerns.",
  },
  {
    id: "hearing-candor",
    label: "Listening, composure, and candor",
    objective: "Protect credibility through careful listening, respectful correction, and honest limits.",
    observable: "No interruption or bluffing, candid uncertainty, professional tone, and accurate correction of premises.",
  },
];

export function advocacySkillsForMode(mode: ExamMode): readonly AdvocacySkillDefinition[] {
  if (mode === "hearing") return HEARING_SKILLS;
  if (mode === "deposition") return DEPOSITION_SKILLS;
  return CROSS_SKILLS;
}

export function allAdvocacySkillIds(): ReadonlySet<string> {
  return new Set(
    [...CROSS_SKILLS, ...DEPOSITION_SKILLS, ...HEARING_SKILLS].map((skill) => skill.id)
  );
}

export function liveAdvocacyInstructions(mode: ExamMode): string {
  if (mode === "hearing") {
    return `ADVOCACY PRESSURE MODEL:
- Test one observable skill at a time: direct answer, governing rule/burden, record or authority, hypothetical/limiting principle, concession, practical consequence, or precise relief.
- Base follow-up questions on counsel's actual answer. If counsel answers directly and accurately, move forward. If counsel evades, ask the same core issue once in a narrower form.
- Pose fair but difficult hypotheticals on stated assumptions. Let counsel answer before changing a fact.
- Surface adverse facts or authority found in the record, but never invent either. Reward candid, narrow concessions by moving to the remaining issue.
- Do not lecture counsel about advocacy technique during the simulation. Create the pressure that reveals the technique.
${SHARED_ETHICS}`;
  }

  if (mode === "deposition") {
    return `PRACTICE RESPONSE MODEL:
- Answer a clear open discovery question naturally and completely from the supported record. Answer a precise closed question precisely.
- If a question contains multiple independently answerable propositions, answer only the proposition you understood or briefly ask counsel to separate it.
- Distinguish what you personally know, learned from another person, read in a document, assume, or do not recall.
- Do not hide supported facts merely to make the simulation harder. When fairly asked whether there is anything else on a defined subject, complete the answer.
- When shown a document, do not adopt counsel's characterization automatically. Confirm identity, authorship, receipt, language, and context only when supported.
- Never name or teach the advocacy technique. Let the quality of counsel's questions change the quality and precision of the testimony.
${SHARED_ETHICS}`;
  }

  return `PRACTICE RESPONSE MODEL:
- A clear, supportable leading proposition earns a crisp answer. An open narrative invitation may receive a fuller natural answer consistent with this witness and the record.
- If a question contains multiple independently answerable propositions, answer only the proposition you understood or briefly ask counsel to separate it.
- Listen for counsel's exact premise. Reject a materially false or unsupported premise precisely; do not agree merely because the question is leading.
- For claimed prior inconsistency, require an accurate source, speaker, time, and context. Once counsel fairly commits, credits, and confronts with a real contradiction, answer it: acknowledge, explain, or deny only as the record supports. Do not invent an escape.
- Remain consistent with prior answers. Do not reward repetition by changing testimony, and do not quarrel merely because counsel is effective.
- Never name or teach the advocacy technique. Let the quality of counsel's questions change the quality and precision of the testimony.
${SHARED_ETHICS}`;
}

export function advocacyReportRubric(mode: ExamMode): string {
  const skills = advocacySkillsForMode(mode)
    .map(
      (skill, index) =>
        `${index + 1}. ${skill.id} — ${skill.label}\n   Objective: ${skill.objective}\n   Observe: ${skill.observable}`
    )
    .join("\n");
  return `ADVOCACY METHOD ${ADVOCACY_FRAMEWORK_VERSION}
Assess observable choices, not charisma, accent, gender, vocal pitch, personality, or resemblance to a famous advocate.

${skills}

RATING SCALE:
- strong: repeated, transcript-supported effective execution
- developing: sound attempt with a material weakness
- needs-work: a transcript-supported missed or counterproductive execution
- not-observed: the transcript does not provide enough evidence; never infer performance

For every skill id above, return exactly one skill assessment. Every non-not-observed rating requires at least one evidence object with the exact one-based transcript line number and a concise observation; never fabricate a quotation. Coaching must prescribe the next better move. The drill must be a short, repeatable exercise. Every ethical flag likewise requires an exact transcript line number.
${SHARED_ETHICS}`;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
const OPENING_RE = /^(?:who|what|where|when|why|how|explain|describe|tell me|walk me through)\b/i;
const CLOSED_RE = /^(?:am|are|is|was|were|do|does|did|have|has|had|can|could|will|would|should|you|your|the|there)\b/i;
const RECORD_RE = /\b(?:record|appendix|exhibit|document|email|report|contract|transcript|deposition|page|line|paragraph|docket|filing|order)\b/i;
const AUTHORITY_RE = /\b(?:case|holding|precedent|statute|section|rule|code|U\.?S\.?C\.?|standard of review|burden)\b|\bv\.\s/i;
const CONCESSION_RE = /\b(?:concede|agree|accept|even if|assuming|to that extent|do not dispute|don't dispute)\b/i;
const CANDOR_RE = /\b(?:I do not know|I don't know|not sure|cannot tell|can't tell|outside the record)\b/i;
const DIRECT_ANSWER_RE = /^(?:yes\b|no\b|the answer is\b|our position is\b|the rule is\b|the standard is\b|we (?:agree|concede)\b|it (?:is|isn't|does|doesn't|would|wouldn't|can|can't)\b)/i;
const HYPOTHETICAL_RE = /\b(?:hypothetical|suppose|assume|assuming|what if)\b/i;
const HYPOTHETICAL_EVASION_RE = /\b(?:not (?:this|our) case|those aren't the facts|different facts)\b/i;
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "could", "from",
  "have", "into", "just", "more", "that", "their", "there", "these", "they", "this",
  "those", "through", "under", "very", "what", "when", "where", "which", "with", "would",
  "your", "you're", "were", "been", "does", "did", "will", "shall", "should",
]);

function wordTokens(text: string): string[] {
  return (text.match(WORD_RE) ?? []).map((word) => word.toLocaleLowerCase());
}

function meaningfulTokens(text: string): Set<string> {
  return new Set(wordTokens(text).filter((word) => word.length >= 5 && !STOP_WORDS.has(word)));
}

function hasAnswerLinkedFollowUp(question: string, answer: string): boolean {
  const answerWords = meaningfulTokens(answer);
  if (!answerWords.size) return false;
  return [...meaningfulTokens(question)].some((word) => answerWords.has(word));
}

function metric(
  id: string,
  label: string,
  value: number,
  note: string,
  denominator?: number,
  unit: "count" | "words" = "count"
): AdvocacyDiagnosticMetric {
  return { id, label, value, ...(denominator === undefined ? {} : { denominator }), unit, note };
}

function analyzeQuestioning(lines: TranscriptLine[], mode: "cross" | "deposition") {
  const counselLines = lines.filter((line) => line.role === "user" && line.text.trim());
  const wordCounts = counselLines.map((line) => wordTokens(line.text).length);
  const total = counselLines.length;
  let linkedFollowUps = 0;
  let eligibleFollowUps = 0;
  let lastAnswer = "";
  for (const line of lines) {
    if (line.role === "assistant") {
      lastAnswer = line.text;
      continue;
    }
    if (line.role !== "user" || !line.text.trim()) continue;
    if (lastAnswer) {
      eligibleFollowUps += 1;
      if (hasAnswerLinkedFollowUp(line.text, lastAnswer)) linkedFollowUps += 1;
    }
    lastAnswer = "";
  }

  const concise = wordCounts.filter((count) => count > 0 && count <= 12).length;
  const open = counselLines.filter((line) => OPENING_RE.test(line.text.trim())).length;
  const closed = counselLines.filter((line) => CLOSED_RE.test(line.text.trim())).length;
  const compounds = counselLines.filter((line, index) => {
    const questionMarks = (line.text.match(/\?/g) ?? []).length;
    const joinedQuestion = /\b(?:and|or|but)\s+(?:who|what|where|when|why|how|did|do|does|is|are|was|were|can|could|would|will|should)\b/i.test(
      line.text
    );
    return (
      questionMarks > 1 ||
      joinedQuestion ||
      (wordCounts[index]! > 16 && /\b(?:and|or|but)\b/i.test(line.text))
    );
  }).length;
  const recordAnchors = counselLines.filter((line) => RECORD_RE.test(line.text)).length;
  const average = total ? Math.round((wordCounts.reduce((sum, count) => sum + count, 0) / total) * 10) / 10 : 0;

  const metrics = [
    metric("questions", "Counsel questions", total, "Nonempty counsel turns; speech recognition may combine adjacent questions."),
    metric("average-question-words", "Average words per question", average, "A form signal, not a quality score.", undefined, "words"),
    metric("brief-questions", "Questions at 12 words or fewer", concise, "Operational proxy for short, plain questions.", total),
    metric("open-starts", "Open narrative starts", open, "Who/what/where/when/why/how or explain/describe/tell-me openings.", total),
    metric("potential-compounds", "Potentially compound questions", compounds, "Multiple question marks, or a long turn joining propositions; review the transcript before relying on this flag.", total),
    metric("answer-linked", "Answer-linked follow-ups", linkedFollowUps, "Lexical overlap with the immediately preceding answer; a conservative listening signal.", eligibleFollowUps),
    metric("record-anchors", "Record or document anchors", recordAnchors, "Turns naming a record, exhibit, document, transcript location, or similar source.", total),
  ];
  if (mode === "cross") {
    metrics.splice(
      4,
      0,
      metric("closed-starts", "Closed-form starts", closed, "Grammatical proxy only; closed form is not necessarily a properly leading or supportable question.", total)
    );
  }
  return { counselTurns: total, metrics };
}

function analyzeHearing(lines: TranscriptLine[]) {
  const counselLines = lines.filter((line) => line.role === "user" && line.text.trim());
  const total = counselLines.length;
  const wordCounts = counselLines.map((line) => wordTokens(line.text).length);
  const average = total ? Math.round((wordCounts.reduce((sum, count) => sum + count, 0) / total) * 10) / 10 : 0;
  const direct = counselLines.filter((line) => DIRECT_ANSWER_RE.test(line.text.trim())).length;
  const concise = wordCounts.filter((count) => count > 0 && count <= 40).length;
  const recordAnchors = counselLines.filter((line) => RECORD_RE.test(line.text)).length;
  const authorityAnchors = counselLines.filter((line) => AUTHORITY_RE.test(line.text)).length;
  const credibilityMoves = counselLines.filter(
    (line) => CONCESSION_RE.test(line.text) || CANDOR_RE.test(line.text)
  ).length;
  let hypotheticals = 0;
  let engaged = 0;
  let pendingHypothetical = false;
  for (const line of lines) {
    if (line.role === "assistant") {
      pendingHypothetical = HYPOTHETICAL_RE.test(line.text);
      continue;
    }
    if (line.role !== "user" || !line.text.trim() || !pendingHypothetical) continue;
    hypotheticals += 1;
    if (!HYPOTHETICAL_EVASION_RE.test(line.text)) engaged += 1;
    pendingHypothetical = false;
  }

  return {
    counselTurns: total,
    metrics: [
      metric("answers", "Counsel answers", total, "Nonempty counsel turns in hearing mode."),
      metric("average-answer-words", "Average words per answer", average, "A responsiveness signal, not a quality score.", undefined, "words"),
      metric("answer-first", "Answer-first openings", direct, "Turns beginning with a direct yes/no, conclusion, rule, position, or narrow concession.", total),
      metric("concise-answers", "Answers at 40 words or fewer", concise, "Operational proxy for compact oral answers.", total),
      metric("record-anchors", "Record anchors", recordAnchors, "Turns naming the record, appendix, exhibit, filing, or a location within them.", total),
      metric("authority-anchors", "Rule or authority anchors", authorityAnchors, "Turns naming a case, rule, statute, standard, or burden.", total),
      metric("credibility-moves", "Concessions or candid limits", credibilityMoves, "Explicit narrow concessions or statements that an answer is unknown/outside the record.", total),
      metric("hypotheticals-engaged", "Hypotheticals engaged", engaged, "Answers that do not immediately reject the court's assumed facts as different from the case.", hypotheticals),
    ],
  };
}

export function analyzeAdvocacyTranscript(
  mode: ExamMode,
  lines: TranscriptLine[]
): AdvocacyAnalysis["diagnostics"] {
  const analyzed = mode === "hearing" ? analyzeHearing(lines) : analyzeQuestioning(lines, mode);
  return {
    ...analyzed,
    caveat:
      "These local form signals are deterministic heuristics, not legal conclusions. Confirm them against the transcript and governing jurisdiction.",
  };
}

export function formatAdvocacyDiagnosticsForPrompt(
  mode: ExamMode,
  lines: TranscriptLine[]
): string {
  const diagnostics = analyzeAdvocacyTranscript(mode, lines);
  return JSON.stringify({
    frameworkVersion: ADVOCACY_FRAMEWORK_VERSION,
    mode,
    counselTurns: diagnostics.counselTurns,
    signals: diagnostics.metrics.map(({ id, label, value, denominator, unit }) => ({
      id,
      label,
      value,
      ...(denominator === undefined ? {} : { denominator }),
      unit,
    })),
    caveat: diagnostics.caveat,
  });
}

export function buildAdvocacyAnalysis(
  mode: ExamMode,
  lines: TranscriptLine[],
  assessments: readonly Omit<AdvocacySkillAssessment, "label">[],
  ethicalFlags: readonly AdvocacyEthicalFinding[]
): AdvocacyAnalysis {
  const byId = new Map(assessments.map((assessment) => [assessment.skillId, assessment]));
  return {
    frameworkVersion: ADVOCACY_FRAMEWORK_VERSION,
    mode,
    diagnostics: analyzeAdvocacyTranscript(mode, lines),
    skills: advocacySkillsForMode(mode).map((definition) => {
      const assessment = byId.get(definition.id);
      return {
        skillId: definition.id,
        label: definition.label,
        rating: assessment?.rating ?? "not-observed",
        evidence: assessment?.evidence ?? [],
        coaching: assessment?.coaching || "Not enough line-referenced transcript evidence to assess this skill.",
        drill: assessment?.drill || "Run a focused practice chapter that makes this skill observable.",
      };
    }),
    ethicalFlags: [...ethicalFlags],
  };
}
