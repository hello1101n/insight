# Claude Team chat and Cowork: design

PRD: [CHAT-AND-COWORK-PRD.md](CHAT-AND-COWORK-PRD.md).

Both surfaces land in `class_ai_assistant_usage`, as Enterprise does. Gold does not change.

## Discovery

Capture the requests behind the Chat and Cowork tabs and answer for each:

1. Does one request return every member active that day, not a top-N?
2. Does it carry the day's active-member count?
3. Is it a GET?
4. Does each row carry an email, ideally an account UUID?
5. Which counters come per member? Chat needs chats or messages. Cowork needs sessions.

A tab with only aggregates, or with no active-member count, is blocked. If one request serves both tabs, one stream feeds both surfaces.

## Bronze

- `claude_team_chat_activity` and `claude_team_cowork_activity`, one row per member per day.
- Primary key `metric_date` plus `account_uuid`, or `email` without a UUID.
- `unique_key` `{tenant}-{source}-{metric_date}-{account_uuid or email}`.
- An `_org` companion per stream if the reference comes in an envelope, shaped like `claude_team_code_metrics_org`.
- Cursor `DatetimeBasedCursor` on `metric_date`, `step: P1D`, `lookback_window: P2D`.
- Paging by token, else by a sort on email or UUID, pages of at least 200.

## Staging

- Gate per surface on headcount only: admit a read only when its distinct attributable members equal the same read's active-member count, as `claude_team__ai_dev_usage` does. A summed counter misses a member whose counted field is zero.
- `staging.claude_team__ai_assistant_usage` emits `claude_enterprise__ai_assistant_usage`'s columns in the same order, one CTE per surface.
- `tool` `claude`, `source` `claude_team`, `surface` `chat` or `cowork`.
- Chat: chats to `conversation_count`, messages to `message_count`.
- Cowork: sessions to `session_count`, plus `message_count`, `action_count`, `dispatch_turn_count`, `skills_used_count` when present.
- Raw row to `surface_metrics_json`.
- Keep a row only when a counter is above zero and it has an email and a date.
- `class_ai_assistant_usage.sql` gains `-- depends_on: {{ ref('claude_team__ai_assistant_usage') }}`, so dbt sees the `union_by_tag` dependency.
- `silver/ai/schema.yml`: add `claude_team` to the `source` accepted values and description, and add claude-team to the class description's list of staging models that gate emission.
- No new column, no warehouse heal. Each stream is a MINOR `descriptor.yaml` bump per ADR-0015.

## Rules

1. Never page an offset window over a sort that is not a total order (#3172).
2. Reject a short read whole, per `_airbyte_meta.sync_id`, against a same-read reference (#3172).
3. Streams sharing a reference keep identical cursors. Store the envelope only on days with member rows (#4296).
4. Read up to today and re-read the revision tail. Registry `revision` is at least `lookback_window` (#2682).
5. Gate emission on activity, never on seat state.
6. Bound staging increments by extraction time per instance, never by business date (#752, #4297).
7. Treat a 403 as an empty stream. A 403 leaves no read and no envelope, so the gate never sees it. A `data_quality` test like `assert_ai_overage_stream_not_silent` flags a source whose `claude_team_code_metrics_org` reads land while a surface stays empty for seven days.

## Tests

- Data-path spec per surface: a short read never becomes the day's state.
- `data_quality` test per surface: reports days the gate held back.
- `data_quality` test per surface: flags a silent surface, as in rule 7.
- `test_claude_team_stream_cursors_agree.py` covers each member and `_org` pair.

## Open question

How long does the vendor revise a day's counts? Past three days, raise `lookback_window` and `revision`.
