# Frontend design — The Record Room

## Art direction brief

Cross Examination is a working litigation instrument, not a generic AI dashboard. The interface takes its visual language from a court reporter's register, a marked-up case folio, and a counsel table under pressure: warm paper for sustained reading, carbon for navigation, and one vermilion line that identifies the active record.

The tone is exact, composed, and procedural. Copy names what will happen, where data goes, and how to recover. Ornament is limited to marks that clarify ownership, sequence, or state.

### Signature element

The **record spine** is a functional vermilion line that connects the active navigation index, selected matter/person, case-record panels, practice launcher, saved sessions, live transcript, and recovery states. New components should join the spine only when they represent the currently owned record or an action that changes it.

### Type pairing

- `Newsreader Variable` carries captions, section titles, and testimony-scale emphasis. It should feel edited, never decorative.
- `IBM Plex Sans Variable` carries controls, explanations, and dense working copy.
- `IBM Plex Mono` carries indexes, timestamps, state labels, technical disclosures, and file metadata.

The fonts are bundled through Fontsource. Do not replace them with network-loaded faces or system-default UI fonts.

### Palette logic

- Bone paper is the dominant reading field.
- Carbon is the navigation and live-record anchor.
- Vermilion marks selection, action, and the record spine.
- Cobalt is reserved for keyboard focus and informational state.
- Moss communicates a completed or safely persisted outcome.
- Oxblood communicates destructive, failed, or unsafe state.

All component colors must be expressed through the semantic custom properties in `src/styles.css`; do not introduce literal component colors.

### Motion grammar

Motion is brief and structural: the review sheet enters from its owning edge, loading rules scan like a register, and live status breathes at a low cadence. Everything uses opacity or transforms and collapses to a clean static state under `prefers-reduced-motion`.

### Material and texture

The main surface uses a very light procedural paper grain, ruled lines, dotted dividers, and square register geometry. Depth comes from border hierarchy and sheet ownership rather than glass, glow, gradients, or rounded cards.

## Responsive composition

- Wide layouts use a fixed indexed rail, a 2:1 case-record/people ledger, then full-width practice and session registers.
- At the packaged 980 × 680 minimum, the rail compresses and the ledger becomes one column without losing actions or state explanations.
- Below 900 px the rail becomes a sticky top docket.
- Below 640 px secondary table metadata is removed from the visual table so primary identity and actions remain visible without horizontal discovery. The accessible table structure and full data remain available at larger working sizes.
- Controls preserve at least 44 px touch targets on narrow screens.

## Component and state rules

1. Use the existing color, type, spacing, radius, shadow, and motion tokens before adding a token.
2. Every interactive control needs default, hover, pressed/selected, `:focus-visible`, disabled, and busy treatment.
3. Async surfaces must distinguish initial loading, true empty data, stale/partial data, recoverable failure, and success. Never clear last-known-good data merely to show a request failure.
4. Keep failures next to the action that caused them. Modal session-file failures stay inside the modal; global recovery failures remain in the workspace register.
5. Preserve the ownership refs and request generations in `App.tsx` when extracting presentation components. They are part of the product's correctness model, not incidental implementation detail.
6. Add ARIA only where native semantics do not express the state. Visible labels and recovery copy remain the primary interface.

## Extension checklist

Before adding a screen or component, verify that it:

- has one place in the record hierarchy and a clear spine relationship;
- uses the three-face type system intentionally;
- has authored loading, empty, error, recovery, and disabled copy;
- works with keyboard, forced colors, reduced motion, 200% zoom, and the defined breakpoints;
- does not reintroduce gradients, glass, generic rounded cards, icon-only mystery actions, or chat bubbles;
- includes a focused regression test for any new async ownership or recovery path.
