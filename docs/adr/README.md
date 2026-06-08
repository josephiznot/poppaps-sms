# Architecture Decision Records

This directory records the significant architectural decisions for the
Poppa P's Poker Night SMS service. Each ADR is immutable once accepted — to
change a decision, add a new ADR that supersedes the old one (and update the
old one's Status to "Superseded by ADR-XXXX").

Format: each record has **Title, Status, Date, Context, Decision,
Consequences,** and a **"Revisit if / Future revisions"** section.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-cloud-platform.md) | Cloud platform: Cloudflare Workers + D1 + Cron Triggers | Accepted (pending implementation) |
| [0002](0002-data-model-and-points.md) | Append-event data model and points scoring | Accepted (pending implementation) |
| [0003](0003-sms-command-surface-and-admin-auth.md) | SMS command router and admin-by-phone-allowlist | ⚠️ Superseded by 0005 |
| [0004](0004-rewards-and-attendance.md) | Rewards and attendance (forward-looking) | Proposed (attendance-capture decided) |
| [0005](0005-interaction-channels.md) | Interaction channels: SMS for players, web app for admin + public standings | Accepted (pending implementation) |

## Context at a glance

This is a texting reminder service for a **biweekly** (every 2 weeks) poker
night at Poppa P's, a cigar lounge. Players opt in by texting **JOIN** to the
Twilio number **+16156951691 / (615) 695-1691** in person at the lounge.

Legal framing matters and is load-bearing across these ADRs: players buy cigars
up front and compete for cigars — **no money is wagered and there are no cash
payouts**. SMS copy is deliberately framed as "game-night reminders," not
gambling, because carriers scrutinize gambling-adjacent content.

Operational reality: a **single host** runs this with **minimal effort**, on a
machine that has Node but not the AWS or SAM CLIs.
