# ADR 0013 — Save attendance before game time

- **Status:** Accepted
- **Date:** 2026-10-23
- **Updates:** ADR-0005 (game admin workflow), ADR-0002 (scoped attendance edits)

## Context

The host records attendees as they arrive, sometimes before the scheduled game
start. The combined result endpoint rejected all early saves and required at
least one finishing place, making attendance impossible until results entry.

## Decision

Add **Save attendance** on the existing game screen, available before or after
the start time without finishers. Upcoming games link to **Attendance**. The
screen pre-fills saved attendance and shows finishing-place controls once play
starts. The result endpoint continues rejecting results before the start time
and requiring at least one finishing place.

Attendance-only saves replace one game's attendance atomically using the existing
`result_version` guard shared with result saves. They retain every recorded
finisher as an attendee and leave points, game type, effective scoring time and
`results_recorded_at` untouched. Missing or cancelled games, unknown roster
members and stale forms are rejected. Attendance is attributed to the game's
effective scoring time, as with result saves.

Attendance-only saves send no SMS and do not evaluate rewards. **Save results**
continues saving finishers and attendance together and evaluating attendance
rewards. Early attendance therefore cannot mark a game complete or bypass the
automatic tournament workflow's missing-results check.

## Consequences

The host can check in players before play and finish the same screen afterward.
No migration or new player interaction is required. Attendance corrections and
result edits share a stale-write guard so a second open window cannot silently
overwrite a newer save.

## Revisit if / Future revisions

If the host needs attendance-only saves to evaluate rewards, define their timing
explicitly before adding SMS side effects to early check-in.
