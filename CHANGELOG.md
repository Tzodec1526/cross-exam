# Changelog

## 2026-09-22 — Export, reports, and live exam

- Export destinations are checked with the native real path before any directory is created, and a link inside the matter fails the archive instead of being stored.
- Import treats an existing documents-folder symlink as a name collision and will not copy through it.
- Repairing one invalid settings field keeps an encrypted API key. Oversized settings quarantines are retained. Unreadable settings leftovers are removed. Settings save errors are redacted.
- A completed report body must be a usable object before it replaces a saved report. The report JSON is restored if the markdown write fails.
- Ending a live exam keeps assistant speech and short counsel answers that had not yet been committed. A barge-in question keeps its case retrieval. Instruction limits keep both dossier markers.
- Hearing dossiers prefer issue hits over exhibit openings. Person matching requires a whole-word name.
- Index rebuilds re-check their owner before publish. Matter delete waits on the same queue as reindex. DOCX entries are inflated under a byte cap. PDF text stops at the character cap.
- Dropped live playback is announced once. Review labels use the recorded mode and the name captured when the exam started.

## 2026-09-21 — Report model pin

- Pinned session-report generation to `grok-4.7` (was `grok-4.6`). Live exams remain on `grok-voice-think-fast-2.0`. `grok-voice-latest` aliases think-fast 2.0.

## 2026-09-04 — Transcript, export, and settings fixes

- Preserved identical counsel answers across separate speech turns while continuing to coalesce duplicate transcription events within a turn.
- Contained asynchronous WebSocket errors after cancelled, failed, or timed-out connection attempts so transport teardown cannot crash the main process.
- Made ZIP exports transactional: incomplete writes and archive warnings fail, previous backups survive failures, and destinations inside the source matter (including directory junctions) are rejected.
- Rejected empty, incomplete, and provider-error report responses before replacing saved reports, and assembled all response text parts before parsing JSON.
- Preserved encrypted API-key ciphertext during unrelated preference saves when OS decryption is temporarily unavailable; explicit key replacement and clearing still work.
- Applied session and report byte limits to the formatted JSON actually written to disk, including restored session candidates, preventing saves that the bounded reader cannot reopen.

## 2026-08-29 — Report model upgrade

- Pinned session-report generation to `grok-4.6` (was `grok-4.5`). Live exams remain on `grok-voice-think-fast-2.0`.

## 2026-07-29 — Live voice model upgrade

- Pinned live exam speech-to-speech to the flagship versioned model `grok-voice-think-fast-2.0` (was `grok-voice-think-fast-1.0`). Still avoids the floating `grok-voice-latest` alias. Reports remain on `grok-4.5`.

## 2026-07-18 — Full-codebase audit and hardening pass

- Made settings reads survive transient failures without destroying good state: an unreadable or locked `settings.json.bak` no longer blocks every settings read (purge retries on later reads, and a confirmed-plaintext failure now falls back to the environment key), and a stored API-key ciphertext that fails OS decryption is left on disk for later recovery instead of being erased on a read path.
- Extended the legacy plaintext-key purge to `settings.json.corrupt-*` copies: preserved diagnostic copies verified free of key material are retained; the rest are removed on every read.
- Stopped a completed document import from being rolled back (deleting every copied file) when only the cosmetic matter-timestamp update failed afterward; the durable reindex marker already governs correctness.
- Sanitized imported filenames that Win32 cannot faithfully store — reserved device stems (`CON`, `NUL`, `COM1`…), forbidden characters, and trailing dots/spaces — before a destination name is claimed, and reported exactly which files were stored under adjusted names instead of inferring renames from name shape.
- Routed every renderer-facing error through path redaction: settings data errors, matter list/restore errors, and the previously unwrapped matters/personas/sessions IPC handlers can no longer disclose local filesystem paths.
- Surfaced junction or symlink entries where a matter directory belongs as a visible data error instead of silently hiding the matter; absent-persona deletion no longer rewrites the people file; a partially created matter skeleton is removed on failure instead of polluting every later listing; `writeJson` backups now read their source through the same bounded reader as every other read.
- Made a failed end-of-session save impossible to lose in the renderer: the retained-session Retry banner now appears even when the user navigated to another matter while the save was in flight, and matter deletion is blocked while a retained-session save or a report generation for that matter is pending.
- Snapshotted the persona and mode a transcript was actually recorded under, so later practice-form selections can no longer relabel a completed session's speakers, header, or mode.
- Fixed the report drawer's "Line N" reveal to wait for the deferred search filter to actually clear before scrolling, restored the missing focus outlines caused by undefined CSS variables, gave each saved-session Review button a distinguishing accessible name, bundled Newsreader's real italic faces (italic text previously rendered upright under `font-synthesis: none`), and memoized live-transcript rows so ASR partials stop re-rendering the whole log.
- Closed two packaging-gate holes: the smoke test now requires the renderer-loaded marker (a second-instance loser exiting 0 can no longer produce a false pass) and runs against an isolated user-data directory that main now honors in smoke mode; build outputs are cleaned before every build, and package verification pins `dist-electron` to exactly the current build's files and allowlists the `app.asar.unpacked` tree that sits outside ASAR integrity validation.
- Hardened the shipped document CSP: production builds now replace the dev meta CSP (which allowed localhost websockets for HMR) with the strict production policy; the `app://` response-header CSP remains the primary enforcement.
- Moved `react`/`react-dom` to development dependencies (they are bundled by Vite and were shipping as dead weight inside the ASAR), added `vite.config.ts` to the typecheck gate, migrated off Electron's deprecated positional `console-message` signature, updated Electron and ws to their latest patch releases, removed the dead `replaceLast` transcript path and unused `MicStreamer.isMuted`, and stopped `saveSettings` from returning the decrypted key toward the IPC boundary.
- Expanded the suite to 342 tests across fifteen files, covering the settings failure policies (locked backups, decrypt-failure preservation, corrupt-copy purge, path redaction), import touch-failure survival, reserved-name sanitization, junction visibility, absent-persona and partial-create behavior, the navigated-away save-failure banner, and recorded-session label integrity.

## 2026-07-15 — Advocacy evidence grounding 2026.2

- Numbered every model-visible saved-transcript line and restricted new coaching evidence to the exact speech lines retained by the bounded report prompt.
- Downgraded substantive ratings without valid cited evidence to `not-observed`, and rejected ethical findings tied to missing, system, out-of-range, or omitted transcript lines.
- Paired each accepted observation with a bounded excerpt copied locally from the saved transcript, so model prose cannot substitute an invented quotation.
- Added line controls that return from coaching directly to the cited transcript row while preserving pre-2026.2 string evidence as visibly unreferenced legacy material.
- Updated impeachment logic for the amended FRE 613 opportunity to explain or deny, and added the Federal Circuit’s direct-answer and accurate-citation guidance to the source synthesis.

## 2026-07-15 — Advocacy method hardening

- Replaced generic advocacy prompting with a versioned, source-backed curriculum spanning controlled trial cross, discovery-and-lockdown depositions, and answer-first oral argument.
- Made live witnesses and judges expose technique through realistic consequences: precise questions receive precise answers, compounds require separation, unsupported premises fail, genuine impeachment requires source/context, and judicial follow-ups track counsel’s actual answer.
- Added deterministic on-device transcript signals with explicit heuristic caveats, keeping raw transcript text out of the trusted diagnostic block.
- Added eight mode-specific report assessments with trusted ids/labels, bounded evidence, prescribed next moves, repeatable drills, ethical flags, and `not-observed` fallbacks instead of invented performance.
- Extended saved JSON, Markdown exports, and the accessible review UI with the versioned advocacy analysis while preserving compatibility with older reports.
- Documented the source synthesis, ethical floor, implementation contract, and limits in `docs/advocacy-method.md`.

## 2026-07-13 — Autonomous improvement cycle 1

- Scoped completed transcripts, saved paths, and activity to their originating matter so a prior record can never appear under a different case caption.
- Added latest-request ownership guards for matter details and saved-session review, preventing slower stale responses from overwriting the current selection.
- Made renderer audio cleanup stable and identity-owned across disconnect/start races.
- Hardened voice-session lifecycle ownership: cancelled handshakes now reject promptly, and concurrent stop/quit calls share one snapshot-based finalization.
- Kept transcript review available when an optional report is corrupt, with malformed saved lines normalized and a visible data warning.
- Added deferred transcript search across speakers and testimony, including match counts, no-result recovery, and keyboard-complete tabs.
- Added Vitest and React Testing Library regression coverage plus a single `npm run check` verification command.

## 2026-07-13 — Autonomous improvement cycle 2

- Made microphone startup transactional: partial streams, audio contexts, and graph nodes are now released after permission, resume, or setup failures without clobbering a newer attempt.
- Added cancellable voice startup, navigation guards while connecting, and matter-owned async updates so delayed session results cannot leak into another matter.
- Preserved the selected person and voice across matter refreshes, and guarded import, reindex, and document-delete results against stale navigation.
- Replaced renderer-supplied filesystem paths with identity-based transcript/report IPC that validates matter ownership, regular files, symlinks, and canonical containment.
- Added persistent saved-session corruption warnings and one-click recovery from validated backup or corrupt-file candidates.
- Made evidence indexing bounded and failure-tolerant, with per-file warnings, event-loop yielding, cached search/excerpts, LRU limits, and deleted-index tombstones.
- Made evidence import transactional and collision-safe, and hardened deletion against symlink, junction, and traversal escapes while retaining valid filenames such as `..notes.txt`.
- Added a responsive, accessible Case record filter with deferred search, match counts, clear/no-results states, and mobile layout coverage.
- Expanded the verification gate to type-check tests and added regression coverage for audio races, stale UI mutations, recovery, artifact access, indexing limits, cache behavior, and filesystem containment.

## 2026-07-13 — Autonomous improvement cycle 3

- Added generation ownership to evidence rebuilds so overlapping jobs cannot commit out of order, unknown matter ids cannot create orphan indexes, and a delayed build cannot resurrect evidence after matter deletion.
- Bounded realtime WebSocket payloads, send backpressure, transcript buffering, handshake error bodies, PCM chunk sizes, and queued playback time; malformed or odd-byte audio is now dropped without reaching unsafe browser allocations.
- Made microphone stop cleanup exception-safe and identity-owned when a retry starts while an older audio context is still closing.
- Subscribed and resumed output audio before opening the voice session so the witness’s forced opening and hearing question cannot be lost during IPC startup.
- Reset cancelled response text at every response boundary and suppressed duplicate forced-opening transcript lines.
- Persisted live testimony before accepted window close on every platform, added Windows shutdown and renderer-crash emergency saves, and stopped treating an already-saved optional report as a reason to hold quit for up to two minutes.
- Distinguished transient JSON read failures from malformed data, so EBUSY/EACCES/EIO no longer rename valid records as corrupt; failed atomic writes now clean up only their own temporary file.
- Rebuilt matter/person forms as accessible, keyboard-complete dialogs with native submit behavior, focus containment/restoration, associated labels, guarded dismissal, and visible inline failures.
- Kept successfully loaded case-record, people, or session sections usable when another matter-detail source fails, with a clear partial-data warning and semantic person edit controls.
- Expanded the suite to 55 tests across eight files, including stale/deleted indexing, output-audio boundaries, stop/retry races, voice event state, JSON I/O failure modes, dialog focus/submit behavior, partial matter loads, and early opening audio.

## 2026-07-13 — Autonomous improvement cycle 4

- Rejected replaced matters roots and matter/documents junctions across every matter-scoped read, write, import, restore, indexing, and deletion path, including a second documents-root ownership check before an index is committed.
- Made matter-metadata recovery non-mutating until a candidate is validated, refused rollback over a valid live record, and used an exclusive fsynced temporary file with rollback and cleanup on replacement failure.
- Made new or replaced API-key storage fail closed when OS encryption is unavailable, throws, or cannot round-trip; environment-only keys remain off disk and existing legacy plaintext is migrated opportunistically.
- Restricted privileged IPC to the exact main frame and exact app document, closing the subframe and same-origin/sibling-document trust gap.
- Added immediate atomic live-session checkpoints plus bounded, owner-safe final-transcript debouncing so renderer, network, or process failures retain testimony without writing on every partial ASR update.
- Kept interrupted checkpoints visible and reviewable as unfinished sessions, while normal stop and disconnect synchronously flush the newest transcript and retain in-memory ownership when a save needs retrying.
- Added latest-request ownership to matter/settings refreshes and completed-session updates, and moved microphone meter painting off React’s render path so high-rate audio telemetry does not rerender the application tree.
- Expanded the suite to 93 tests across nine files and rendered the recovered-session workflow at desktop and 390 px mobile widths, including accessible status/report guidance, zero horizontal overflow, and a clean browser console.

## 2026-07-13 — Autonomous improvement cycle 5

- Routed every saved-session read, restore, artifact open, transcript write, and report write through a canonical non-junction sessions root; unsafe optional artifacts are isolated without hiding otherwise valid session JSON.
- Replaced direct artifact and JSON writes with exclusive, fsynced atomic staging, including independently staged backups, hardlink-safe replacement, and retryable session-restore rollback after fsync or rename failures.
- Unified window close, Ctrl/Cmd+Q, `before-quit`, and Windows shutdown behind one save coordinator, so persistence failure keeps the only in-memory transcript open for retry and every floated load/shutdown promise has a terminal rejection handler.
- Added an early single-instance lock: a second launch can no longer race the shared matter tree and instead restores, shows, and focuses the primary window.
- Required the exact trusted main frame for microphone permission and realtime audio IPC, closing the remaining same-WebContents subframe gap.
- Capped document inventory, keyterm work, completed transcript events, and both initial/retrieval voice instructions; selected-person profiles and testimony now outrank unrelated case material, and late retrieval cannot contaminate the next question.
- Made saved-session review a keyboard-owned dialog with initial close focus, contained forward/reverse tab order, Escape dismissal, and focus restoration to the exact async Review trigger.
- Expanded the suite to 128 tests across eleven files, including lifecycle retry, single-instance, permission, junction/hardlink, fsync/rollback, evidence ranking, payload-budget, stale retrieval, and dialog focus regressions.
- Rendered the session-review workflow at desktop and 390 px mobile widths, verified both focus-wrap directions and exact trigger restoration, and confirmed zero horizontal overflow and a clean browser console.

## 2026-07-13 — Autonomous improvement cycle 6

- Bounded persisted session/report JSON, transcript rows, model prompts, provider response streams, diagnostics, and every model-controlled report field before parsing or rendering; oversized optional reports no longer hide a usable transcript.
- Revalidated runtime session, matter, and persona ownership against the canonical workspace before transcript/report generation, and rejected saved reports that claim a different session.
- Added saved-session report regeneration through trusted main-frame IPC, with per-session single-flight sharing so close/reopen races cannot submit or overwrite the same report twice and failed attempts remain retryable.
- Treated transcript text as untrusted report input so embedded role changes or output instructions cannot override the coaching-analysis contract.
- Added an accessible saved-session report workflow with clear generate/regenerate actions, disabled progress feedback, inline retryable errors, focus-safe drawer behavior, and immediate coaching-result refresh.
- Kept report jobs owned by their exact matter/session while the drawer is closed, bounded completed-result caching, and prevented stale or malformed disk timestamps from displacing a freshly generated report.
- Made microphone permission startup cancellable from the live-session view and retained failed session saves behind a navigation-locked Retry save action, including cleanup failures after microphone startup errors.
- Preflighted complete document-import batches before the first copy, rejecting links, unreadable sources, more than 500 files, files over 100 MiB, or batches over 1 GiB without partially changing the matter.
- Expanded the suite to 159 tests across twelve files and rendered the saved-report flow through missing, progress, success, and focus-restoration states at desktop and 390 px widths, with zero mobile overflow and no application console errors.

## 2026-07-13 — Autonomous improvement cycle 7

- Reconciled renderer reloads with main-process voice ownership before enabling a new exam: retained sessions are saved, failed saves remain globally retryable, and React Strict Mode shares one state check and at most one stop attempt.
- Suppressed Ctrl/Cmd+R and F5 while a live or retained voice session exists, and replaced the blocking window-close prompt with an asynchronous single-flight confirmation that keeps unsaved testimony owned until the user decides.
- Added permanent saved-session deletion through exact-frame IPC, with UUID and matter ownership checks, voice/report-generation locks, response-identity validation, stale-result guards, and accessible focus recovery.
- Made deletion transactional and crash recoverable: exact session/report artifacts are staged into an exclusive tombstone, fully rolled back before commit on failure, and cleaned only forward after the atomic commit point; bounded maintenance safely resolves interrupted transactions.
- Updated `@testing-library/react`, `concurrently`, and `vitest` within their compatible patch ranges; the dependency audit remains free of known vulnerabilities.
- Expanded the suite to 186 tests across thirteen files, including reload recovery, close-confirmation single-flight, shortcut policy, destructive-action ownership, interrupted deletion rollback, deferred cleanup, and report-resurrection races.
- Rendered the retained-session recovery and permanent-delete flow at desktop and 390 px widths, verifying one reconciliation/save, immediate row removal, exact heading-focus recovery, zero document overflow, and no application console errors.

## 2026-07-13 — Autonomous improvement cycle 8

- Bounded descriptor-backed reads for `matter.json`, `personas.json`, and `settings.json`, rejecting oversized, growing, replaced, symlink, and non-file leaves before unbounded allocation or parsing; post-read file-version ownership prevents a swapped-in valid file from being quarantined for an older malformed read.
- Canonicalized persisted matter, person, and settings shapes with matching write/read field ceilings, UUID ownership and uniqueness, bounded person/keyterm counts, exact pretty-printed byte checks, and matter-prefixed recovery errors that retain the UUID needed by Restore.
- Made Settings repair failure-atomic: it validates and encrypts a staged replacement first, preserves repairable invalid or oversized data without rereading it, and restores the original live file if publication fails; availability failures and unsafe link-like leaves continue to fail closed.
- Stopped canceled or superseded evidence rebuilds before extracting the next document, while retaining the atomic final index commit and the last usable case record.
- Added exact-frame, UUID-validated indexing cancellation plus accessible importing/indexing/cancelling UI phases, stale-result suppression, response-identity checks, and clear recovery copy when files were imported but indexing failed or was cancelled.
- Kept unrelated practice-session controls semantically accurate during document work, replacing the false “Starting…” state with import/index/cancel-specific disabled labels and guidance.
- Expanded the suite to 223 tests across thirteen files, covering descriptor growth and path replacement, exact metadata limits and repair rollback, restore targeting and fallback, persisted-shape validation, early indexing cancellation, stale picker ownership, cancellation mismatch recovery, and split import/index failure messaging.
- Rendered import, active indexing, cancellation, and recovery at desktop and 390 px widths, verifying the prior case record remains visible, the final Cancel/Reindex states and singular/plural copy are accurate, the document stays within the viewport, and no application console errors occur.

## 2026-07-13 — Autonomous improvement cycle 9

- Replaced renderer-facing voice results with a bounded terminal DTO containing only session identity, artifact capabilities, and explicit save-retry state; voice startup now returns identity only, never the mutable session record.
- Kept failed disconnect saves owned and navigation-locked behind **Retry save**, including the event/invoke ordering race where an `ended` status can arrive before the retry call resolves.
- Replaced saved-session list/review paths with `canOpenTranscript` / `canOpenReport`, stripped persisted `reportPath` from review records, omitted restored transcripts from recovery responses, and reduced recovery source names to basenames.
- Slimmed saved-report generation to return and cache only identity, the new report, its open capability, and report diagnostics; close/reopen races merge that result into one freshly loaded transcript instead of retaining up to eight duplicate 8-million-character reviews.
- Treated the Markdown transcript as an optional export after the durable JSON save, so an export failure leaves the session reviewable and reports an accurate capability instead of forcing a false unsaved-session retry.
- Redacted and bounded local paths in renderer-facing session diagnostics and wrapped session/voice IPC failures at the main-process boundary without exposing the workspace layout.
- Made the completed-session card accurately distinguish one saved artifact from both, showing only capability-backed Open actions.
- Expanded the suite to 231 tests across thirteen files, covering terminal payload minimization, disconnect retry ownership, event/invoke ordering, slim report merging, path redaction, optional export failure, and capability-driven artifact actions.
- Rendered the single-artifact completion state at desktop and 390 px widths, confirming accurate singular copy, the transcript-only action, exact viewport containment, and no application console errors.

## 2026-07-13 — Autonomous improvement cycle 10

- Replaced the remaining renderer-authorized document path deletion with a current-index UUID capability; stale, cross-matter, duplicate, and malformed identities now fail closed while the existing canonical path containment remains defense in depth.
- Removed document and indexing paths from renderer DTOs, bounded public metadata and warnings, sanitized resolved artifact-open failures, and returned deleted document identity only.
- Serialized import, rebuild, and delete mutations per matter so overlapping privileged calls cannot cancel one another or report an out-of-order filesystem result, while unrelated matters can still proceed independently.
- Split irreversible deletion from the separately visible and cancellable rebuild phase, so a rebuild failure can never masquerade as a failed delete or leave a stale searchable index.
- Persisted case-record invalidation before unlink, retained it across restarts when a stale index file is locked, validated the trusted directory chain before marker I/O, required filename/path metadata to describe the same indexed file, and completed fallible matter-metadata maintenance before deleting document bytes.
- Added a row-owned, double-click-safe removal flow with permanent-action copy, filename-specific accessible labels, accurate progress, exact response validation, focus recovery, and a **Reindex now** state that hides stale metadata and blocks practice until recovery.
- Expanded the suite to 244 tests across fourteen files, covering public document DTO minimization, path redaction, mutation serialization, revocable identities, restart-safe invalidation, unknown-matter and untrusted-chain behavior, pre-unlink failures, preload arguments, duplicate-click ownership, committed-delete recovery, and focus restoration.
- Rendered failed-delete-rebuild recovery at desktop and 390 px widths, verifying exact heading focus, practice lockout, the successful **Reindex now** transition, zero page overflow, and no application console errors.

## 2026-07-13 — Autonomous improvement cycle 11

- Bounded reconstructable index reads and writes before parsing or filesystem mutation, stopped creating derived-index backups, and purged legacy backup/corrupt/temp copies that could retain deleted evidence.
- Canonicalized every persisted index field and rejected wrong-matter ownership, malformed or duplicate identities, unsafe paths, orphan chunks, mismatched metadata, invalid timestamps, and aggregate document/chunk budgets before MiniSearch allocation.
- Made search-cache freshness include file identity, size, and metadata-change time as well as mtime, so an atomic same-size replacement cannot leave stale evidence searchable.
- Capped PDF parsing at 2,000 pages and preflighted DOCX ZIP metadata before decompression, including overflow-safe entry-count, per-entry, aggregate-size, compression-ratio, multi-disk, and ZIP64 rejection.
- Read each evidence leaf through one owned descriptor, parsed only the captured bytes, and revalidated source identity/version after parsing and immediately before index commit.
- Persisted case-record invalidation before the first import copy, made nested mutations preserve older invalidation ownership, verified rollback of completed and partial destinations, and surfaced import or delete cleanup uncertainty as a structured recovery result that keeps the old index unusable.
- Made the renderer hide stale document metadata and block practice after uncertain imports, failed or cancelled rebuilds, and index-load failures; a successful **Reindex now** or later verified detail reload clears the matching recovery lock and only the resolved case-record warning, while retained-session recovery now reports a missing transcript export accurately.
- Made witness and document-type filters authoritative, validated all search/excerpt/prior-testimony inputs before index I/O, resolved filenames exactly or rejected ambiguity, and removed the unused renderer document-search IPC surface.
- Strictly validated realtime tool names, call ids, JSON-object arguments, fields, types, selectors, and limits before service calls; renderer activity is bounded and remote tool output is path-safe, field-allowlisted, valid JSON capped by exact UTF-8 bytes.
- Labeled dossier and retrieval prose as untrusted facts-only evidence and placed a top-priority boundary ahead of live witness/judge instructions so embedded roles, policy, requests, or tool commands cannot become session authority.
- Bounded live transcript rows and characters, PCM source/sample/decoded-byte queues, and report work globally; realtime sessions now enforce pong deadlines, terminate visibly on outbound-audio backpressure, and persist the terminal warning, while report overflow returns an actionable error instead of allowing unbounded work.
- Added a persistent first-use acknowledgement for xAI processing, accurate adjacent Begin/report disclosures, and an About & Support surface with version details and a main-process-owned diagnostics-folder action.
- Removed API-key entry and plaintext key state from the renderer. A confirmed native clipboard import now reads and encrypts the key only in the main process, clears only the still-matching clipboard value, fails closed without secure storage, and removes recoverable legacy plaintext key copies during migration.
- Hardened the packaged trust boundary around a secure `app://` renderer, strict response headers, exact dev-origin validation, main-window-only audio permission, a narrow ASAR allowlist, and verified Electron fuses; packaged smoke testing proves an injected dev-server URL cannot redirect the production renderer.
- Pinned live voice to the versioned `grok-voice-think-fast-1.0` production model while retaining `grok-4.5` for reports, and added an explicit per-release provider/model compatibility, pricing, and retention review.
- Added Windows package CI and an environment-gated signed-tag release workflow with exact version/tag enforcement, required signing secrets, timestamped Authenticode checks, CycloneDX SBOM and SHA-256 generation, plus a runbook requiring repository-side environment/tag protections and covering installer/upgrade/uninstall/retention/rollback operations. Local unsigned QA packages remain explicitly non-releasable.
- Recast the complete interface as **The Record Room**, an authored forensic-editorial system with a carbon docket rail, bone-paper reading field, bundled Newsreader/IBM Plex typography, and a functional vermilion record spine connecting navigation, evidence, people, practice, live testimony, saved sessions, and recovery.
- Added token-driven light/dark palettes, procedural paper grain, structured entrance motion, forced-colors and reduced-motion fallbacks, explicit loading/offline/partial/error/success states, programmatic labels, semantic logs and meters, 44 px touch targets, and breakpoint-specific compositions down through 390 px.
- Closed renderer safety gaps found during the design audit: microphone mute intent now survives permission startup, consent cannot bypass a changed practice gate, failed matter refreshes retain last-known-good workspaces, failed detail sections cannot leave stale people or sessions actionable, and settings imports own their async generation.
- Kept delayed report failures recoverable across drawer close/reopen, routed artifact-open errors into the modal that owns the action, made successful metadata restore a notice rather than an alert, and prevented superseded settings reads from reverting imported key status.
- Expanded the suite to 322 tests across fourteen files, covering index size/schema/recovery, parser resource ceilings, captured-source integrity, cache replacement, import and delete invalidation ownership, rollback uncertainty, strict filters/selectors, prompt and tool-call boundaries, provider/backpressure limits, UTF-8 output limits, preload minimization, renderer lockout/recovery, frontend accessibility, refresh ownership, startup consent/mute races, and modal failure recovery.
- Re-ran the authored interface at its 1,584 × 992 concept viewport, the packaged 980 × 680 minimum, and 390 × 844 mobile; verified the catalog, matter ledger, settings feedback, saved-session report, keyboard focus restoration, bundled fonts, 44 px controls, and zero page overflow. The Browser/IAB later refused a post-edit reload under its URL policy, so the final narrow-table prioritization was verified by source/build contracts rather than bypassing that policy.
- Rebuilt the unsigned Windows QA package, verified all 2,166 packaged ASAR entries and Electron fuses, and confirmed the packaged application loads its production renderer successfully.
