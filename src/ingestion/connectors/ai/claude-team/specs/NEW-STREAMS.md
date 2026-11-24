# Claude Team new streams

Candidates: chat activity and daily spend. Build a stream only when all its discovery questions answer yes. An Owner answers them by capturing the dashboard request with synthetic values. Endpoint details stay unconfirmed until captured.

## Chat stream

Source: `claude.ai/analytics/usage` ([docs](https://support.claude.com/en/articles/12883420-usage-analytics-for-team-and-enterprise-plans)). Feeds `class_ai_assistant_usage`, surface `chat`, and through it `ai.chat_assistant_conversations`, `ai.assistant_messages` and `ai.active_days`. Gold does not change. Release notes must say Team `ai.active_days` now counts chat-only days.

### Chat discovery questions

1. Does one request return every member who chatted that day, not a top-N?
2. Does it carry the day's active-member count or the org total of the counter?
3. Is it a GET?
4. Does each row carry an email, ideally an account UUID?

### Chat bronze

- `claude_team_chat_activity`, one row per member per day. Primary key `metric_date` plus `account_uuid`, or `email` without a UUID. `unique_key` `{tenant}-{source}-{metric_date}-{account_uuid or email}`.
- `claude_team_chat_activity_org`, only if the reference comes in an envelope. Same shape as `claude_team_code_metrics_org`.
- Cursor `DatetimeBasedCursor` on `metric_date`, `step: P1D`, `lookback_window: P2D`, from `start_date` or seven days ago.
- Paging by token, else by a sort on email or UUID with pages of at least 200.

### Chat staging

- Admit a read only when its distinct members equal the read's headcount, or its summed counter equals the org total. Reads before the first reference pass, as in `claude_team__ai_dev_usage`.
- `staging.claude_team__ai_assistant_usage` emits `claude_enterprise__ai_assistant_usage`'s columns in the same order.
- `tool` is `claude`, `surface` is `chat`, `source` is `claude_team`. Chats fill `conversation_count`, messages fill `message_count`, the raw row goes to `surface_metrics_json`.
- Keep rows with a chat or message count above zero, an email and a date.
- The class accepts `claude_team` as a `source`, with no new column.

## Spend stream

Source: the Export spend report button. Per member and model: requests, tokens, net and gross USD, 90 days back, one-day delay. Feeds `ai.daily_approximate_extra_usage_cost` and `ai.extra_usage_cost` with spend on its real day.

### Spend discovery questions

1. Does a Team organisation have the export?
2. Is it a synchronous GET returning JSON or CSV?
3. Does a one-day range return that day's spend?

### Spend bronze

- `claude_team_spend_daily`, one row per member, product, model and day. Primary key `spend_date`, `account_uuid`, `product`, `model`. `unique_key` `{tenant}-{source}-{spend_date}-{account_uuid}-{product}-{model}`, without the read.
- Cursor `DatetimeBasedCursor` on `spend_date`, `step: P1D`, `lookback_window: P2D`, up to today, from `start_date` or seven days ago, at most 89 days back.

### Spend staging and class

- Each day comes from the newest read that returned rows for it. An empty newest read keeps the older rows.
- `staging.claude_team__ai_spend_daily` stores cents with `full_refresh=false`, since bronze holds only 90 days.
- New class `class_ai_spend_daily` at the stream's grain: email, account, `tool`, request and token counts, net and gross cents, ISO currency.

### Spend gold

1. A `data_quality` test: per closed month, a seat's summed net spend equals its last in-month `used_amount_cents` in `class_ai_overage_daily`, within one cent per row.
2. Later, `ai_cost_metric_evidence` reads exact days for reconciled months. This breaks its INVARIANT that Claude days derive from the month, so it needs an ADR first.

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

- Data-path spec like `ai_cost_incomplete_read.test.yaml`: a short chat read never becomes the day's state.
- `data_quality` test like `assert_ai_dev_usage_read_was_complete`: reports days the chat gate withheld.
- Data-path spec: a spend day re-read with fewer rows takes the newer read.
- `test_claude_team_stream_cursors_agree.py` covers the chat stream pair.
- The spend reconciliation runs over closed months.

## Dropped

No gold measure reads these: organisation summaries, skills and connectors usage, chat projects, artifacts, Cowork, the Claude Code usage and value tabs, the leaderboard export, member groups, Claude Design, surveys, the `/usage` endpoint, the organisation list. Per-member accept and reject counts would feed `ai.tool_acceptance_rate`, but no known endpoint serves them.

## Order of work

1. Run both captures.
2. Build each stream that passes, spend with gold step 1.
3. Write the gold step 2 ADR once the reconciliation holds over a closed month.

## Open questions

1. Is a chat one started or one active that day? It must match Enterprise's `chat_conversation_count`.
2. How long does the vendor revise chat counts? Past three days, raise `lookback_window` and `revision`.
3. Does the Team export cover only extra usage? Only then does it reconcile with `used_credits`.
4. Is net spend on `used_credits`' `post_discount` basis? If not, reconcile on gross.
