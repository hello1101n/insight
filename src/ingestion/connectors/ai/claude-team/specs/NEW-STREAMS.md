# Claude Team new streams

Candidates: chat activity and Cowork activity, per member per day.

## What they feed

Both land in `class_ai_assistant_usage`, as `claude_enterprise__ai_assistant_usage` already does for Enterprise. Gold does not change.

| Surface | Metrics |
|---|---|
| `chat` | `ai.chat_assistant_conversations`, `ai.assistant_messages`, `ai.active_days` |
| `cowork` | `ai.assistant_messages`, `ai.assistant_actions`, `ai.active_days` |

Release notes must say Team `ai.active_days` now counts chat-only and Cowork-only days.

## Discovery questions

Ask each for the chat tab and the Cowork tab.

1. Does one request return every member active that day, not a top-N? The [docs](https://support.claude.com/en/articles/12883420-usage-analytics-for-team-and-enterprise-plans) show a top-members ranking for chat and only org-wide figures for Cowork.
2. Does the same response carry a reference: the day's active-member count, or the org total of a counter?
3. Is it a GET?
4. Does each row carry an email, ideally an account UUID?
5. Which counters come per member? Chat needs chats or messages. Cowork needs sessions, and takes messages, actions, dispatch turns and skills when present.

A tab that returns only aggregates is blocked: no class holds org-grain usage. If one request serves both tabs, one bronze stream feeds both surfaces.

## Bronze

- `claude_team_chat_activity` and `claude_team_cowork_activity`, one row per member per day.
  - Primary key: `metric_date` plus `account_uuid`, or `email` without a UUID.
  - `unique_key`: `{tenant}-{source}-{metric_date}-{account_uuid or email}`.
- An `_org` companion per stream, only if the reference comes in an envelope. Same shape as `claude_team_code_metrics_org`.
- Cursor: `DatetimeBasedCursor` on `metric_date`, `step: P1D`, `lookback_window: P2D`, from `start_date` or seven days ago.
- Paging by token, else by a sort on email or UUID with pages of at least 200.

## Staging

- Gate per surface: admit a read only when its distinct members equal the read's headcount, or its summed counter equals the org total. Reads before the first reference pass, as in `claude_team__ai_dev_usage`.
- `staging.claude_team__ai_assistant_usage` emits `claude_enterprise__ai_assistant_usage`'s columns in the same order, one CTE per surface.
- `tool` is `claude`, `source` is `claude_team`, `surface` is `chat` or `cowork`.
- Chat: chats fill `conversation_count`, messages fill `message_count`.
- Cowork: sessions fill `session_count`, then `message_count`, `action_count`, `dispatch_turn_count` and `skills_used_count` when present.
- The raw row goes to `surface_metrics_json`.
- Keep a row only when one of its surface's counters is above zero and it has an email and a date.
- The class accepts `claude_team` as a `source`, with no new column.

## Rules for every new stream

1. Never page an offset window over a sort that is not a total order (#3172).
2. Reject a short read whole, per `_airbyte_meta.sync_id`, against a same-read reference (#3172).
3. Streams sharing a reference keep identical cursors. Store the envelope only on days with member rows (#4296).
4. Read up to today and re-read the revision tail. Registry `revision` is at least `lookback_window` (#2682).
5. A value true only as of its read carries the read in its `unique_key`.
6. Gate emission on activity, never on seat state.
7. Bound staging increments by extraction time per instance, never by business date (#752, #4297).
8. Treat a 403 as an empty stream and flag it with a silver `data_quality` check.

Each stream is a MINOR `descriptor.yaml` bump and needs no warehouse heal.

## Tests

- Data-path spec like `ai_cost_incomplete_read.test.yaml`, per surface: a short read never becomes the day's state.
- `data_quality` test like `assert_ai_dev_usage_read_was_complete`: reports days the gate withheld, per surface.
- `test_claude_team_stream_cursors_agree.py` covers each member and `_org` pair.

## Dropped

- Spend export. `claude_team_overage_spend` already feeds `ai.extra_usage_cost` and `ai.daily_approximate_extra_usage_cost`. The docs do not say Team has the export.
- No gold measure reads these: organisation summaries, skills and connectors usage, chat projects, artifacts, the Claude Code usage and value tabs, the leaderboard export, member groups, Claude Design, surveys, the `/usage` endpoint, the organisation list.
- Per-member accept and reject counts would feed `ai.tool_acceptance_rate`, but no known endpoint serves them.

## Order of work

1. Capture both tabs.
2. Build each surface that passes. Chat first if both pass, since it feeds three metrics.
3. Record a blocked surface here with what the capture showed.

## Open questions

1. Is a chat one started or one active that day? It must match Enterprise's `chat_conversation_count`.
2. Is a Cowork session one started or one active that day? It must match Enterprise's `cowork_session_count`.
3. How long does the vendor revise a day's counts? Past three days, raise `lookback_window` and `revision`.
