# Advocacy Method 2026.2

Cross Examination uses a versioned advocacy curriculum rather than asking a model to imitate a famous lawyer. There is no objective ranking of the “best” oral advocates, and personality mimicry is neither reliable nor useful coaching. This method instead synthesizes recurring, observable techniques taught by renowned trial advocates and by official court, government, and professional sources.

The method is educational trial-preparation support, not legal advice. Evidence rules, deposition practice, professional duties, and permitted examination techniques vary by jurisdiction and matter. Every generated assessment must be checked against the transcript, the source record, and controlling law.

## Source synthesis

Sources were reviewed on 2026-07-15.

### Cross-examination

- Francis L. Wellman’s *The Art of Cross-Examination* draws on extensive trial experience and emphasizes preparation, sequencing, restraint, and not asking a critical question without knowing the answer. The public-domain text also warns that unnecessary cross can strengthen a witness. [Project Gutenberg edition](https://www.gutenberg.org/ebooks/40781)
- Irving Younger’s influential method supplies the durable core: brevity, plain words, leading questions, preparation, listening, no quarrelling, no harmful repetition, no question too many, and saving argument for summation. The implementation treats these as strong defaults rather than inflexible commandments. [ABA publication](https://www.americanbar.org/products/inv/book/214831/) and [modern practitioner discussion](https://www.hklaw.com/en/insights/media-entities/2024/08/podcast-the-ten-commandments-of-cross-examination)
- The U.S. Army advocacy curriculum combines the NITA/National College of District Attorneys “approach point” method—discrete topics supporting case theory—with Younger’s witness-control principles. It also teaches leading, single-fact questions and warns against the destructive final “why” question. [Army JAG Advocacy Trainer](https://www.jagcnet.army.mil/Sites/JAGC.nsf/F3FBB5D831EAED2F8525855F006400F2/%24File/2019%20Advocacy%20Trainer.pdf) and [Army Reserve cross-examination chapter](https://www.usar.army.mil/Portals/98/Documents/OSJA/Chapter%205-%20Cross%20Examination.pdf)
- Federal Rule of Evidence 611 supplies the legal floor: effective truth-determination, efficiency, protection from harassment or undue embarrassment, ordinary use of leading questions on cross, and limits on scope. [FRE 611](https://www.law.cornell.edu/rules/fre/rule_611)
- Federal Rule of Evidence 613 requires a witness to receive an opportunity to explain or deny a prior inconsistent statement before extrinsic evidence is introduced. The impeachment skill therefore requires an accurate confrontation and a fair answer, not a scripted “gotcha”; governing jurisdiction still controls sequence and use. [FRE 613](https://www.law.cornell.edu/rules/fre/rule_613)

This becomes eight assessed skills: chapters and theory; leading control; one fact/plain words; listening; concessions before attack; impeachment discipline; restraint; and record fidelity/fairness.

### Depositions

Deposition practice is not scored as if every question were trial cross. Federal Rule of Civil Procedure 30 provides that examination proceeds as at trial, testimony continues subject to concise nonargumentative and nonsuggestive objections, and the examination must not be impeded or conducted in bad faith or in an unreasonably oppressive manner. [FRCP 30](https://www.law.cornell.edu/rules/frcp/rule_30)

The mode therefore rewards an open-to-closed discovery funnel, personal-knowledge foundations, clarification and fair exhaustion, answer-linked follow-up, accurate document handling, a clean usable record, and efficient professional conduct. Open questions are a positive discovery tool when followed by precise lock-down questions; the cross-examination preference for leading form is not blindly imported.

### Hearings and oral argument

- The Supreme Court’s official guide tells counsel to answer questions directly, use yes/no where suitable, admit when an answer is unknown, cite only precedent that truly supports the position, and engage a hypothetical on its assumed facts before distinguishing the case. [Supreme Court Guide for Counsel](https://www.supremecourt.gov/casehand/Guide%20for%20Counsel%202024.pdf)
- The Department of Justice’s appellate-advocacy guidance similarly frames argument as a conversation, not a speech: answer first and explain second, listen, engage hypotheticals, stay within the record, make necessary concessions without defensiveness, and stop when the important points are complete. [United States Attorneys’ Bulletin, January 2013](https://www.justice.gov/usao/eousa/foia_reading_room/usab6101.pdf)
- The Federal Circuit’s current guide independently requires direct answers, familiarity with the briefs and appendix, and accurate appendix page citations. That reinforces the method’s record-precision requirement and the product’s decision to make coaching evidence traceable rather than merely plausible. [Federal Circuit Guide for Oral Argument](https://www.cafc.uscourts.gov/wp-content/uploads/OralArguments/OralArgumentGuide.pdf)

This becomes eight assessed skills: answer first; rule and standard; record and authority; hypotheticals and limiting principles; credible concessions; structure under pressure; relief and consequences; and listening/composure/candor.

### Ethical floor

The curriculum never rewards false premises, fabricated evidence, distorted authority, harassment, or bluffing. ABA Model Rule 3.3 prohibits knowing false statements of fact or law to a tribunal and requires candor about controlling adverse authority. Model Rule 3.4 prohibits falsifying evidence, assisting false testimony, and alluding at trial to unsupported matters. [ABA Rule 3.3](https://www.americanbar.org/groups/professional_responsibility/publications/model_rules_of_professional_conduct/rule_3_3_candor_toward_the_tribunal/) and [ABA Rule 3.4](https://www.americanbar.org/groups/professional_responsibility/publications/model_rules_of_professional_conduct/rule_3_4_fairness_to_opposing_party_counsel/)

## Implementation contract

| Layer | Behavior |
| --- | --- |
| Live witness | Precise supported propositions receive precise answers; open invitations may receive fuller testimony; compound questions are separated; false premises are rejected; genuine impeachment is acknowledged only after accurate source and context. |
| Live deposition | Open discovery is answered naturally; knowledge sources are distinguished; fair exhaustion is honored; documents are not adopted from counsel’s characterization alone. |
| Live hearing | The judge rotates among direct answer, rule/burden, record/authority, hypothetical/limit, concession, consequence, and relief; follow-ups respond to counsel’s actual answer. |
| Local diagnostics | Deterministic form signals count question/answer length, open or closed starts, potential compounds, answer-linked follow-ups, source anchors, answer-first openings, concessions/candid limits, and hypothetical engagement. No transcript text enters the trusted signal block. |
| Model assessment | Exactly eight mode-specific skills use `strong`, `developing`, `needs-work`, or `not-observed`. Every substantive rating and ethical finding requires a valid one-based line reference from the bounded transcript actually sent for analysis. Missing, system-line, out-of-range, or omitted-line citations are discarded; an unsupported rating becomes `not-observed`. Unknown skill ids and model-supplied labels are also discarded. |
| Review UI and export | The saved report pairs each model observation with a locally copied, bounded transcript excerpt. Line controls return directly to the cited saved-transcript row. Markdown contains the same references, excerpts, method version, coaching, drills, and ethical findings. Pre-2026.2 string evidence remains readable but is explicitly marked legacy and unreferenced. |

## Diagnostic limits

Local metrics are deliberately described as signals, not scores or legal conclusions. Speech recognition may combine questions; grammatical form does not establish that a question is legally leading; lexical overlap is only a conservative proxy for listening; and a count cannot determine whether a premise is supported. The model may use the signals as leads, but its narrative assessment must cite the transcript and may mark a skill `not-observed`.

Any material curriculum change must increment `ADVOCACY_FRAMEWORK_VERSION`, update this document, and add mode-specific regression coverage.
