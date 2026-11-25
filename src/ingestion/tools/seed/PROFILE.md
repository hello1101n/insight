<!-- GENERATED FILE — do not hand-edit.
     Regenerate: python3 -m insight_seed.render_profile
     Verify:     python3 -m insight_seed.render_profile --check
     Content is derived from insight_seed/manifest.py + profiles.py. -->

# Seed Profile

What a stand seeded by the seeder contains. Generated from the same
builder that writes `manifest.json`, so the two cannot disagree.

## Stand summary

| Field | Value |
|---|---|
| tenant | `00000000-df51-5b42-9538-d2b56b7ee953` |
| tenant (other) | `11111111-1111-4111-8111-111111111111` |
| realm | `insight` |
| anchor_date | `2026-06-30` |
| data_window | `2026-05-02..2026-06-30` |
| seed_revision | `3348789f6d9919a4` |
| manifest_version | 2 |

`anchor_date` is the last day carrying seeded activity. It is resolved
once per run from `SEED_ANCHOR_DATE` (an ISO date, or the literal
`today`) and defaults to yesterday UTC — the current day is excluded so
a partial day does not fight the gold views' day-aligned aggregates.
Pin it to reproduce a dataset exactly; the value above is the one this
page was rendered against, not necessarily the one on your stand.

## Roster

27 people, all but one in the default tenant. The
exception is `other_tenant_lead`, who exists ONLY so cross-tenant refusal
has a caller to refuse — no team, no org-chart edge, no activity, so they
cannot appear in another persona's subtree or move a metric.

`uuid` is both the Keycloak user id and the
`identity.persons` person id, so a login and an API row refer to the same
person.

| email | display_name | team | role | realm roles | uuid |
|---|---|---|---|---|---|
| `email_ceo@company.nonpresent` | Ava Carter | — | ceo | insight-admin, insight-lead | `aaaaaaaa-0000-0000-0000-000000000001` |
| `email_development_lead@company.nonpresent` | Liam Nguyen | development | lead | insight-lead | `00000000-0000-0000-0000-000000000010` |
| `email_sales_lead@company.nonpresent` | Maya Patel | sales | lead | insight-lead | `aaaaaaaa-0000-0000-0000-000000000020` |
| `email_hr_lead@company.nonpresent` | Noah Rivera | hr | lead | insight-lead | `aaaaaaaa-0000-0000-0000-000000000030` |
| `email_support_lead@company.nonpresent` | Zoe Brooks | support | lead | insight-lead | `aaaaaaaa-0000-0000-0000-000000000040` |
| `email_development_01@company.nonpresent` | Ethan Okafor | development | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000010001` |
| `email_development_02@company.nonpresent` | Aria Meyer | development | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000010002` |
| `email_development_03@company.nonpresent` | Leo Sato | development | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000010003` |
| `email_development_04@company.nonpresent` | Nora Flores | development | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000010004` |
| `email_development_05@company.nonpresent` | Kai Haas | development | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000010005` |
| `email_sales_01@company.nonpresent` | Ivy Kelly | sales | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000020001` |
| `email_sales_02@company.nonpresent` | Owen Novak | sales | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000020002` |
| `email_sales_03@company.nonpresent` | Mila Reyes | sales | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000020003` |
| `email_sales_04@company.nonpresent` | Ezra Park | sales | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000020004` |
| `email_sales_05@company.nonpresent` | Luna Bauer | sales | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000020005` |
| `email_hr_01@company.nonpresent` | Finn Costa | hr | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000030001` |
| `email_hr_02@company.nonpresent` | Ruby Lund | hr | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000030002` |
| `email_hr_03@company.nonpresent` | Milo Amari | hr | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000030003` |
| `email_hr_04@company.nonpresent` | Sage Dixon | hr | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000030004` |
| `email_hr_05@company.nonpresent` | Cole Frost | hr | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000030005` |
| `email_support_01@company.nonpresent` | Iris Grant | support | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000040001` |
| `email_support_02@company.nonpresent` | Jude Hale | support | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000040002` |
| `email_support_03@company.nonpresent` | Elle Ivers | support | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000040003` |
| `email_support_04@company.nonpresent` | Reid Jansen | support | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000040004` |
| `email_support_05@company.nonpresent` | Wren Keir | support | ic | insight-member | `bbbbbbbb-0000-0000-0000-000000040005` |
| `email_admin_operator@company.nonpresent` | Beau Lowe | — | admin | insight-admin | `cccccccc-0000-0000-0000-000000000001` |
| `email_other_tenant_lead@company.nonpresent` | Vera Kovac | — | lead | insight-lead | `dddddddd-0000-0000-0000-000000000001` |

No password appears here or in `manifest.json`. Personas are referenced
by identity; the shared local login secret lives in the compose env and
the generated Keycloak realm.

## Fixtures

Stable names a test declares its data requirements against. The names are
a contract — they describe a role in the org, not a particular person — so
renaming one breaks every test that declares it.

| fixture | email | team | role | uuid |
|---|---|---|---|---|
| `admin_operator` | `email_admin_operator@company.nonpresent` | — | admin | `cccccccc-0000-0000-0000-000000000001` |
| `ceo` | `email_ceo@company.nonpresent` | — | ceo | `aaaaaaaa-0000-0000-0000-000000000001` |
| `dev_lead` | `email_development_lead@company.nonpresent` | development | lead | `00000000-0000-0000-0000-000000000010` |
| `development_ic` | `email_development_01@company.nonpresent` | development | ic | `bbbbbbbb-0000-0000-0000-000000010001` |
| `hr_ic` | `email_hr_01@company.nonpresent` | hr | ic | `bbbbbbbb-0000-0000-0000-000000030001` |
| `hr_lead` | `email_hr_lead@company.nonpresent` | hr | lead | `aaaaaaaa-0000-0000-0000-000000000030` |
| `other_tenant_lead` | `email_other_tenant_lead@company.nonpresent` | — | lead | `dddddddd-0000-0000-0000-000000000001` |
| `sales_ic` | `email_sales_01@company.nonpresent` | sales | ic | `bbbbbbbb-0000-0000-0000-000000020001` |
| `sales_lead` | `email_sales_lead@company.nonpresent` | sales | lead | `aaaaaaaa-0000-0000-0000-000000000020` |
| `support_ic` | `email_support_01@company.nonpresent` | support | ic | `bbbbbbbb-0000-0000-0000-000000040001` |
| `support_lead` | `email_support_lead@company.nonpresent` | support | lead | `aaaaaaaa-0000-0000-0000-000000000040` |

## Capabilities

| capability | value |
|---|---|
| `connector_schedules` | no |
| `custom_catalogue` | yes |
| `idp` | keycloak |
| `ingestion` | no |
| `portal_dashboards` | yes |
| `portal_datasets` | yes |
| `portal_metrics` | yes |
| `portal_widgets` | yes |
| `service_principals` | yes |

`ingestion: no` — compose seeds the silver and gold layers directly; no
connector runs, so the ingestion path is not exercised on this stand.

`service_principals: yes` — the authenticator's token listener is published,
so a runner can exchange an RFC 7523 assertion for a service principal and
exercise the `/internal/*` routes only a service may call. A stand that
keeps that listener in-cluster reports `no`, and those tests skip with a
reason rather than failing.

`connector_schedules: no` — the seed does not write the scratch connector
instance that the schedule tests edit. `./dev-compose.sh test-stand up`
inserts it and reports `yes`. On a stand without it, those tests skip with
a reason.

`idp` reflects the environment the seed was run with. This page is
rendered against a canonical environment, so it shows the default rather
than your stand's value — read `manifest.json` for what is actually
running.

`custom_catalogue: yes` — the `analytics` step wrote the custom catalogue
below into the insight-v3-core database that `MARIADB_V3_DB` names. The
four `portal_*` capabilities follow it: each catalogue page has at least
one seeded definition to open. A stand without that variable reports `no`
for all five, and the tests that need them skip with a reason.

## Custom catalogue

Seeded dashboards, by the stable key a test declares. Each board tests one
thing a dashboard renderer must get right. The admin operator owns every
board, so sign in as `admin_operator` to see all of them. The CEO sees
only the shared board. Open a board at its path on the stand.

| key | name | path | widgets | covers |
|---|---|---|---|---|
| `every_widget_type` | Stand: every widget type | `/dashboards/stand-every-widget-type` | 11 | line, area, bar, bar with labels, stacked bar, pie, stat, table, heatmap, funnel and treemap, with time ranges |
| `headings_and_texts` | Stand: headings and texts | `/dashboards/stand-headings-and-texts` | 2 | headings, texts, a long heading, and text with markdown-like characters |
| `no_time_range` | Stand: no time range, widgets with and without a clock | `/dashboards/stand-no-time-range` | 4 | a board without time ranges; clocked and clockless widgets run over all rows |
| `percents` | Stand: percent stat and percent column | `/dashboards/stand-percents` | 4 | a percent stat, a percent table column, a percent line and percent bars |
| `large_table` | Stand: table over 500 rows | `/dashboards/stand-large-table` | 1 | a table widget whose metric answers 1000 rows |
| `many_categories` | Stand: many categories and long labels | `/dashboards/stand-many-categories` | 3 | a bar over more than 50 categories, and bars and a table over long labels |
| `dates_over_a_year` | Stand: dates over more than one year | `/dashboards/stand-dates-over-a-year` | 3 | monthly buckets over the whole data window, which spans more than one year |
| `null_values` | Stand: null values | `/dashboards/stand-null-values` | 5 | null category labels, null ratios, a null stat and null table cells |
| `empty_results` | Stand: empty results | `/dashboards/stand-empty-results` | 5 | a line, bars, a pie, a table and a stat over a metric with no rows |
| `failing_widget` | Stand: a widget that fails | `/dashboards/stand-failing-widget` | 2 | a widget whose metric reads a column the table does not have, beside one that works |
| `large_board` | Stand: large board with 18 widgets | `/dashboards/stand-large-board` | 18 | one board with 18 widgets of every type, under headings |
| `in_folder` | Stand: board in a folder | `/dashboards/stand-in-folder` | 2 | a board filed in the folder `Stand folder` |
| `shared` | Stand: board shared with the CEO | `/dashboards/stand-shared` | 2 | a board the admin operator owns and shares with the CEO as a viewer |
| `starred` | Stand: starred board | `/dashboards/stand-starred` | 2 | a board the admin operator has starred |
| `dataset_widgets` | Stand: widgets over a dataset | `/dashboards/stand-dataset-widgets` | 2 | bars and a table over a metric that reads the seeded dataset |
| `stat_compare` | Stand: stats against the previous period | `/dashboards/stand-stat-compare` | 4 | stats compared with the previous period: higher, lower and neutral is better, a percent stat and a duration stat |
| `bar_layouts` | Stand: horizontal and 100% stacked bars | `/dashboards/stand-bar-layouts` | 2 | horizontal bars, and bars stacked to 100% by a series |
| `target_lines` | Stand: target lines | `/dashboards/stand-target-lines` | 3 | a target on a percent line and on percent bars, and a target without a label on an area |
| `series_lines_and_areas` | Stand: lines and areas by series | `/dashboards/stand-series-lines-and-areas` | 2 | one line for each value of a series column, and areas stacked by it |
| `heatmaps` | Stand: heatmaps by two columns and by day | `/dashboards/stand-heatmaps` | 2 | a heatmap with an x and a y column, and a calendar heatmap by the time bucket |
| `funnel` | Stand: funnel from conditional counts | `/dashboards/stand-funnel` | 1 | a funnel whose stages are conditional counts in one row |
| `treemap` | Stand: treemap with groups | `/dashboards/stand-treemap` | 1 | a treemap of pipelines grouped by repository |
| `scatter` | Stand: scatter with labels and series | `/dashboards/stand-scatter` | 1 | a scatter of pipelines with a size, a series by repository and a label on each point |
| `durations` | Stand: durations with a unit | `/dashboards/stand-durations` | 2 | a table column and bars whose metric reads durations in seconds |

The folder is `Stand folder` and the dataset is `stand_sample_records`. A
failing widget fails on purpose: its metric reads a column that the table
does not have. No metric value in the catalogue is an expected value.
