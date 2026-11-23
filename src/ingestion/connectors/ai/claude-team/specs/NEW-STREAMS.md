# Claude Team new streams

Two new streams have a consumer. This spec sets how to build them without repeating this connector's completeness failures.

## What the connector reads today

The connector reads the claude.ai web API through the customer's `claude-team-proxy` in five streams: `claude_team_members`, `claude_team_invites`, `claude_team_overage_spend`, `claude_team_code_metrics` and `claude_team_code_metrics_org`. The proxy forwards only `GET /api/*`, so an endpoint that needs POST needs a proxy release every customer deploys. The Enterprise Analytics API is [not available on Team plans](https://code.claude.com/docs/en/analytics).

No public document names the web API behind the analytics dashboard. Endpoint details no capture has shown yet are marked unconfirmed.

## Chat stream

The chat stream feeds `class_ai_assistant_usage` with surface `chat`, and through it `ai.chat_assistant_conversations`, `ai.assistant_messages` and `ai.active_days`. Gold needs no change. Team members' `ai.active_days` starts counting chat-only days, and the release notes say so.

The [usage analytics docs](https://support.claude.com/en/articles/12883420-usage-analytics-for-team-and-enterprise-plans) show that Team Owners see chats per day and a ranking of top members by chats. Discovery question 1 tests whether a full member list exists. The path, a full member list, a message counter and the refresh period are unconfirmed.

### Chat discovery questions

An Owner captures the request behind `claude.ai/analytics/usage` with synthetic values. The session key never reaches Insight. Every answer must be yes.

1. Does one request return every member who chatted that day? A top-N ranking fails, since members below the cut read as inactive.
2. Does the response carry the day's active-member count or the org total of the summed counter?
3. Is the request a GET?
4. Does each row carry an email, and ideally an account UUID?

The capture also notes any per-member Cowork, accept or reject counters.

### Chat keys and cursor

`claude_team_chat_activity` holds one row per member per day. Its primary key is `metric_date` with `account_uuid`, or with `email` when no UUID comes back. Its `unique_key` is `{tenant}-{source}-{metric_date}-{account_uuid or email}`.

The cursor is a `DatetimeBasedCursor` on the injected `metric_date`, with `step: P1D` and `lookback_window: P2D`. It starts at `start_date`, which now covers every daily stream, or seven days ago.

If the reference arrives in an envelope, `claude_team_chat_activity_org` stores it as `claude_team_code_metrics_org` does. It drops empty days with a `record_filter`, keys on the read and shares the member stream's cursor block.

### Chat completeness gate

Staging admits a read only when its distinct attributable members equal the read's headcount, or its summed counter equals the org total. Reads before the first reference pass as legacy, as in `claude_team__ai_dev_usage`. Paging uses tokens if offered, otherwise a sort on email or account UUID with pages of at least 200.

### Chat mapping

`staging.claude_team__ai_assistant_usage` emits the columns of `claude_enterprise__ai_assistant_usage` in the same order, because `union_by_tag` unions by position. It sets `tool` to `claude`, `surface` to `chat` and `source` to `claude_team`. Chats fill `conversation_count`, messages fill `message_count`, other counts fill their columns when present, and `surface_metrics_json` keeps the raw row. A row needs a chat or message count above zero, an email and a date. The class gains `claude_team` as an accepted `source` and no column.

## Spend stream

The spend stream feeds `ai.daily_approximate_extra_usage_cost` and `ai.extra_usage_cost`. It places spend on its real day instead of between two readings, and recovers a month whose last reading was missed.

The usage analytics docs describe a spend export per member and model, with requests, tokens, and net and gross USD. It reaches 90 days back with a one-day delay, and covers extra usage only on seat-based Enterprise. Team availability, path and format are unconfirmed.

### Spend discovery questions

The same capture runs on the Export spend report button.

1. Does a Team organisation have the export?
2. Is it a synchronous GET that returns JSON or CSV?
3. Does a one-day range return that day's spend?

### Spend keys and cursor

`claude_team_spend_daily` holds one row per member, product, model and day. Its primary key is `spend_date`, `account_uuid`, `product` and `model`, and its `unique_key` is `{tenant}-{source}-{spend_date}-{account_uuid}-{product}-{model}`. The key omits the read, because a day's spend is a fact of that day.

The cursor is a `DatetimeBasedCursor` on `spend_date`, one day per request, with `step: P1D`, `lookback_window: P2D` and today as the upper bound. It starts at `start_date` or seven days ago, clamped to 89 days ago.

### Spend completeness gate

An export returns the whole range in one body, so no page boundary exists. Staging builds each day from the newest read that returned rows for it, so a row a later read drops does not survive. A day whose newest read is empty keeps its older rows.

For each closed month, a seat's summed net spend must equal its last in-month `used_amount_cents` in `class_ai_overage_daily`, within one cent per row. Open months are skipped, since the one-day delay keeps them behind.

### Spend mapping and new class

`staging.claude_team__ai_spend_daily` converts spend to cents and sets `full_refresh=false`, since bronze keeps only 90 days.

It feeds a new class, `class_ai_spend_daily`, at the stream's grain. It carries email, account, `tool` set to `claude`, request and token counts, and net and gross cents with an ISO currency. Its rows sum per day. `class_ai_credit_usage` forbids currency and `class_ai_overage_daily` holds month-to-date levels, so neither fits.

Gold step 1 adds the reconciliation as a `data_quality` test and changes no measure. Gold step 2 would read exact days from the new class for reconciled months in `ai_cost_metric_evidence`. That reverses the model's INVARIANT that Claude derives a day from its month, so step 2 needs its own ADR.

## Rules for every new stream

1. Never page an offset window over a sort that is not a total order (#3172).
2. Reject a short read whole, judged per `_airbyte_meta.sync_id` against a same-read reference (#3172).
3. Streams that share a reference keep identical cursors, and the envelope is stored only on days with member rows (#4296).
4. Read up to today and re-read the revision tail, with the registry's `revision` at or above `lookback_window` (#2682).
5. A value true only as of its read carries the read in its `unique_key`.
6. Gate emission on activity, never on seat state.
7. Bound staging increments by extraction time per instance, never by business date (#752, #4297).
8. Treat a 403 as an empty stream, as on `claude_team_overage_spend`, and flag it with a silver `data_quality` check.

Each stream ships as a MINOR bump of `descriptor.yaml`. Neither needs a warehouse heal, because no existing relation gains a column.

## Tests that prove completeness

- A data-path spec modelled on `ai_cost_incomplete_read.test.yaml` shows a short chat read never becomes the day's state.
- A `data_quality` test modelled on `assert_ai_dev_usage_read_was_complete` reports the days the chat gate withheld, so a withheld day does not stay silent.
- A data-path spec shows a spend day re-read with fewer rows takes the newer read.
- `test_claude_team_stream_cursors_agree.py` covers the chat stream pair.
- The spend reconciliation runs over closed months.

## Dropped candidates

No gold measure reads these.

- Organisation summaries, since no org-grain AI class exists.
- Skills and connectors usage, shown only org-wide.
- Chat projects, counted per project.
- Artifacts, shown as a top-10 ranking.
- Cowork, shown as aggregates. Revisit if the chat capture finds per-member counters.
- The Claude Code usage tab, and the value tab whose per-PR cost the ai-cost PRD excludes.
- The Claude Code leaderboard export, which duplicates `claude_team_code_metrics`.
- Member groups, since cohorts use `org_unit`.
- Claude Design active users, surveys, the operator's own `/usage` endpoint and the organisation list.

Per-member accept and reject counts are the exception. `ai.tool_acceptance_rate` would read them, but no known endpoint serves them.

## Order of work

1. Run both captures and replace each unconfirmed detail with its captured shape.
2. Build each stream whose questions pass, the spend stream with gold step 1. A stream that fails joins the dropped list.
3. Write the step 2 ADR once the reconciliation holds over a closed month.

## Open questions

1. Is a chat a conversation started that day or one active that day? Enterprise's `chat_conversation_count` feeds the same metric, so they must agree.
2. How long does the vendor revise a day's chat counts? Beyond three days, `lookback_window` and `revision` rise.
3. Does the Team export cover only extra usage? Only then does it reconcile with `used_credits`.
4. Is net spend on the `post_discount` basis that `used_credits` uses? If not, the reconciliation uses gross spend and step 2 is off.
