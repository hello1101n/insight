# Claude Team chat and Cowork: PRD

Design: [CHAT-AND-COWORK-DESIGN.md](CHAT-AND-COWORK-DESIGN.md).

## Problem

Team tenants see only Claude Code usage, so chat and Cowork users look inactive. Enterprise tenants see all three.

## Goal

Team tenants get chat and Cowork usage per person per day.

| Metric | Adds |
|---|---|
| AI chat conversations | Chats |
| AI assistant messages | Chat and Cowork messages |
| AI assistant actions | Cowork actions |
| AI active days | Chat and Cowork days |

## Requirements

1. Every active member appears. A day missing members is not shown.
2. Counts mean the same as on Enterprise.
3. Data refreshes daily and picks up late vendor revisions.
4. The tenant's proxy install does not change.
5. Days held back for missing members are reported.

## Out of scope

- Spend. The overage stream already covers it.
- Projects, artifacts, skills, connectors, organisation summaries, member groups, surveys, Claude Design. No metric uses them.
- Accept and reject counts. No source serves them per member.

## Risk

The dashboard API is undocumented. The public docs show chat only as a top-members ranking and Cowork only as organisation totals. A surface with no full per-member list cannot ship.

## Done when

- A Team tenant sees all four metrics per person.
- A day's summed member counts match the dashboard's organisation totals.

## Open questions

1. Is a chat one started that day or one active that day?
2. Is a Cowork session one started that day or one active that day?
