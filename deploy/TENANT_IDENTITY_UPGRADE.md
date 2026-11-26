# Moving an install to the canonical tenant UUID

From the release that contains
[#3661](https://github.com/constructorfabric/insight/issues/3661) an install has
one tenant: the lowercase UUID in `authenticator.oidc.defaultTenantId`. Bronze,
the history relations, operator config, identity resolution and analytics all
key on it. An install that already holds data written under the
old `ingestion.reconcile.tenantId` (often not a UUID) moves to it on its next
deploy, by the chart's hooks. The same migration renames every stored
table's tenant column `tenant_id` to `insight_tenant_id` and its stamped source
column `source_id` to `insight_source_id`. The sync ledger
(`ingestion_history`) is not touched. Nothing is done by hand except the final
[clean-up](#once-the-stand-is-proven-drop-the-backups).

dbt reads every Bronze tenant through `bronze_tenant()`, which lowercases it. A
stored tenant that is not lowercase would get new keys and be re-read from the
watermark epoch; after the cutover every stored tenant is the lowercase UUID, so
this does not arise.

## Deploy as usual

1. Bump the version.
2. Set the tenant, the value your IdP asserts in the `tenant_id` claim, in lowercase
   (to generate one, see [HELM_DEPLOY.md](HELM_DEPLOY.md#generate-the-tenant-id)):

   ```yaml
   authenticator:
     oidc:
       defaultTenantId: "<TENANT_UUID>"
   ```

   It must be the tenant the identity MariaDB `persons` table and a signed-in
   session (`/auth/me`) already use. This cutover does not move MariaDB.
3. Delete `global.tenantDefaultId`, `ingestion.reconcile.tenantId` and
   `identityResolution.seed.tenantDefaultId`. The chart refuses to render
   while any of them is present.
4. `make deploy` (its `TIMEOUT` defaults to `3h`). A deploy that can cut over
   must run:
   - **with a helm `--timeout` of at least 3h**, and with
     `ingestion.tenantCutover.helmTimeoutSeconds` set to that timeout in
     seconds (`make deploy` sets it from `TIMEOUT`). The pre-upgrade hook may
     migrate for up to 2h50m; an upgrade whose value is below 10800 fails to
     render.
   - **without `--rollback-on-failure`** (in `make deploy`, `deploy.atomic:
     false` in the inventory). A rollback while the hook migrates, or after a
     post-upgrade hook fails, puts the previous release's code on the
     migrated tables, whose columns it does not know.

A fresh install does the same; its hooks find nothing to migrate. The cutover
supports a single-node ClickHouse only: an upgrade with
`clickhouse.clusterMode` fails to render.

## What the hooks do

| Hook | Weight | Does |
|---|---|---|
| `tenant-cutover-pre` (pre-upgrade) | 20, after the other pre-upgrade hooks (`clickhouse-databases`, `schedule-db-provision`) | Runs `tenant_migration plan`. If nothing is pending, it exits and suspends nothing. Otherwise it records the suspend state of every CronWorkflow (reconcile, data quality, every sync) and of the identity seed CronJob in the ConfigMap `<release>-tenant-cutover`, suspends them, waits up to `ingestion.tenantCutover.idleTimeoutSeconds` (default 30 min) until no Workflow runs and no Airbyte job is active, and runs `tenant_migration apply`. |
| `clickhouse-migrate`, `field-value-map` (post-upgrade) | 200, 300 | As every release. The field-value-map loader writes every row under the tenant and ignores the bundle's tenant column. |
| `tenant-cutover-post` (post-upgrade) | 400 | If the ConfigMap exists, it submits one Workflow from the `tenant-cutover-rebuild` template and returns without waiting for it. |

`tenant_migration apply` handles every MergeTree table in `bronze_*`, `config`,
`staging`, `silver` and `insight` (gold), and every history relation (`src/ingestion/scripts/tenant_migration/history-tables.txt`), that
still has a `tenant_id` column, still names its stamped source `source_id`, or
holds a tenant other than the UUID. It covers every stored table, whether or
not its connector has synced. For each one it creates a copy,
`<table>__tenant_copy`, with the columns named `insight_tenant_id` and
`insight_source_id`, with the same type and position. It inserts every row
with the tenant set to the UUID and the tenant prefix of `unique_key`
rewritten; the rest of the key is unchanged. It then checks the copy and
`EXCHANGE`s it in.
Only then is the original renamed `<table>__tenant_backup`, or
`__tenant_backup_<n>` when an earlier deploy left one, so a backup always holds
an original. A silver table or history relation built before it had a tenant
column gets one, and a key there that leads with a tenant other tables' rows
held, followed by `-<source>-`, moves to the UUID. A table holding both
`tenant_id` and `insight_tenant_id`, or both `source_id` and
`insight_source_id`, stops the run before anything changes. A table already in
the target shape is skipped.

What keeps `tenant_id`, by design: the sync ledger `ingestion_history.sync_events`
(a service table: reconcile's sweep writes it, with an empty tenant on its
per-tick seal, and no reader filters it by tenant);
`dbt_test__audit` (dbt test results, rewritten by the next test run);
materialized views' `.inner_id.*` tables; and every operator database outside
the scope above, such as `presentation.*`, `ops_*` or `backup_*`. A view an
operator wrote over a migrated table that names `tenant_id` or `source_id`
must be updated by hand.

The check: a plain MergeTree copy holds as many rows as its original. A
ReplacingMergeTree copy holds as many distinct sorting keys as the original's
rows have once rewritten: ClickHouse may collapse rows of one sorting key on
insert or in any merge, so expect raw `count()` to drop where the original
held duplicates background merges had not yet collapsed, or where one entity
was stored under both the old tenant and none (both keys now name the UUID).

If `tenant_migration apply` fails, or the hook reaches its deadline, the hook
swaps every table already exchanged back, resumes the writers it suspended
and fails the deploy; the previous release keeps running on its own tables.
The exception is a table that could not be put back (below). Once `apply` has
succeeded there is no way back but forward: a later failure (a post-upgrade
hook, the rebuild) leaves the migrated tables live. If the pod is killed outright
(SIGKILL), at most one `<table>__tenant_copy` is left: the next deploy drops it
when its table was not yet swapped (a partial copy), and otherwise renames it
`__tenant_backup` (it holds the original).

The rebuild Workflow does a full dbt refresh of staging, everything upstream of
it and `identity.identity_inputs`, runs the identity seed once, then fully
refreshes everything else, gold included. History relations refuse the full
refresh and run incrementally. A model whose Bronze is absent or empty is
skipped by dbt and rebuilds on its connector's next sync; until then its
migrated tables stay as they are. Every step runs even when an earlier one
failed. The identity map views (`identity.person_map`,
`identity.account_assignment`) are rebuilt in the first step. When the Workflow
ends, however it ends (its deadline exceeds the sum of its steps'), its exit
handler resumes reconcile, data quality and the identity seed as they were
recorded and deletes the ConfigMap. Every connection's sync schedule stays
suspended: a sync on the catalog Airbyte held before the cutover would drop
`insight_tenant_id` and `insight_source_id` from the migrated Bronze.
Reconcile's next tick (within 15 min) refreshes each connection's catalog and
only then re-applies its schedule, unsuspended; a connection whose refresh
fails keeps its schedule suspended until a later tick succeeds.

## Progress and failures

```sh
kubectl -n <NS> logs job/<release>-tenant-cutover-pre      # while the deploy runs
kubectl -n <NS> get workflows -l insight.cyberfabric.com/tenant-cutover=rebuild
kubectl -n <NS> get configmap <release>-tenant-cutover      # present = rebuild owed, writers suspended
```

- **The deploy fails with `still busy after …`**: a sync or an Airbyte job did
  not finish within the wait. Nothing was migrated and every writer was
  resumed. Deploy again later.
- **The deploy fails during `tenant_migration apply`**: every table is back as
  it was and every writer was resumed. The log names the failing table.
- **`some table could not be put back`**: the writers stay suspended, and each
  original is in its `__tenant_backup*` table. Fix the cause and deploy again;
  the hook migrates forward from where it stopped.
- **The rebuild Workflow fails**: some models failed. Its `report` step says
  which steps; each dbt step's log names the failed models under
  `Completed with N errors`. Every other model was rebuilt, the writers were
  resumed (syncs by reconcile), and the ConfigMap is gone, so no deploy submits the rebuild again.
  A failed model rebuilds on its connector's next sync; to rebuild it sooner,
  run dbt-run for it by hand.

## Analytics until the rebuild finishes

Between the deploy and the end of the rebuild, analytics may read stale or
not-ready: staging, silver, gold and the identity maps are rebuilt from
Bronze (the identity maps in the first step). No sync runs until the rebuild
has finished and reconcile has refreshed the connection's catalog. On a large install this
takes hours; each dbt step's deadline is
`ingestion.tenantCutover.dbtStepDeadlineSeconds` (default 6h).

## Once the stand is proven, drop the backups

The backups use as much ClickHouse disk again as the migrated tables: 5–9 GiB
on vz and dev, under 1 GiB on cfabric. Check there is room before the deploy:

```sql
SELECT formatReadableSize(sum(total_bytes)) FROM system.tables
WHERE database LIKE 'bronze\_%' OR database IN ('config', 'staging', 'silver', 'insight');
```

Once the stand has run normally for a while, drop them by hand. No hook ever
does. Leftover backups never block a later deploy.

```sh
kubectl -n <NS> run tenant-finalize --rm -it --restart=Never \
  --image=<ingestion.toolboxImage> --env=CLICKHOUSE_URL=http://<clickhouse.host>:8123 \
  --env=CLICKHOUSE_USER=<clickhouse.username> --env=CLICKHOUSE_PASSWORD=<password> \
  --command -- sh -c 'cd /ingestion/scripts && python3 -m tenant_migration finalize'
```

`finalize` drops every `*__tenant_backup*` table, including an orphan whose
live table no longer exists. Until then, a backup always holds the table as it
was before the migration, and swapping it back by hand
(`EXCHANGE TABLES <t> AND <t>__tenant_backup`) is the only way back. A
`<t>__tenant_copy` is never a backup: it is a copy in progress, or what a killed
run left, which the next deploy settles. There is no rollback.
