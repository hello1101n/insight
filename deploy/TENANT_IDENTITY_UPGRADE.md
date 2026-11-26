# Moving an install to the canonical tenant UUID

From the release that contains
[#3661](https://github.com/constructorfabric/insight/issues/3661) an install has
one tenant: the lowercase UUID in `authenticator.oidc.defaultTenantId`. Bronze,
the history relations, operator config, the sync ledger, identity resolution and
analytics all key on it. An install that already holds data written under the
old `ingestion.reconcile.tenantId` (often not a UUID) moves to it on its next
deploy, by the chart's hooks. The same migration renames every stored
table's tenant column `tenant_id` to `insight_tenant_id` and its stamped source
column `source_id` to `insight_source_id` (the sync ledger keeps both old
names). Nothing is done by hand except the final
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
4. `make deploy`. Give helm a 3h `--timeout`.

A fresh install does the same; its hooks find nothing to migrate.

## What the hooks do

| Hook | Weight | Does |
|---|---|---|
| `tenant-cutover-pre` (pre-upgrade) | 20, after the database and migrate hooks | Runs `tenant_migration plan`. If nothing is pending, it exits and suspends nothing. Otherwise it records the suspend state of every CronWorkflow (reconcile, data quality, every sync) and of the identity seed CronJob in the ConfigMap `<release>-tenant-cutover`, suspends them, waits up to `ingestion.tenantCutover.idleTimeoutSeconds` (default 30 min) until no Workflow runs and no Airbyte job is active, and runs `tenant_migration apply`. |
| `clickhouse-migrate`, `field-value-map` (post-upgrade) | 200, 300 | As every release. The field-value-map loader writes every row under the tenant and ignores the bundle's tenant column. |
| `tenant-cutover-post` (post-upgrade) | 400 | If the ConfigMap exists, it submits one Workflow from the `tenant-cutover-rebuild` template and returns without waiting for it. |

`tenant_migration apply` handles every MergeTree table in `bronze_*`, `config`,
`ingestion_history`, `staging`, `silver` and `insight` (gold), and every history
relation (`src/ingestion/scripts/tenant_migration/history-tables.txt`), that
still has a `tenant_id` column, still names its stamped source `source_id`, or
holds a tenant other than the UUID. It covers every stored table, whether or
not its connector has synced. For each one it creates a copy,
`<table>__tenant_copy`, with the columns named `insight_tenant_id` and
`insight_source_id`, with the same type and position (`ingestion_history` keeps
`tenant_id` and `source_id`). It inserts every row with the tenant set to the
UUID and the tenant prefix of `unique_key` rewritten; the rest of the key is
unchanged. It then checks the row (or key) count and `EXCHANGE`s the copy in.
Only then is the original renamed `<table>__tenant_backup`, or
`__tenant_backup_<n>` when an earlier deploy left one, so a backup always holds
an original. A silver table or history relation built before it had a tenant
column gets one. A table already in the target shape is skipped.

What keeps `tenant_id`, by design: the sync ledger `ingestion_history.sync_events`;
`dbt_test__audit` (dbt test results, rewritten by the next test run);
materialized views' `.inner_id.*` tables; and every operator database outside
the scope above, such as `presentation.*`, `ops_*` or `backup_*`. A view an
operator wrote over a migrated table that names `tenant_id` or `source_id`
must be updated by hand.

Expect raw Bronze row counts (`count()`) to drop: the copy writes each
ReplacingMergeTree table afresh, and ClickHouse collapses duplicate keys within
an inserted block, which background merges had not yet done in the original.
`count() FINAL` and the set of keys are unchanged; the migration checks the keys.

If anything fails, including the hook's deadline, the hook swaps every table
already exchanged back, resumes the writers it suspended and fails the deploy.
The previous release keeps running as before. If the pod is killed outright
(SIGKILL), at most one `<table>__tenant_copy` is left: the next deploy drops it
when its table was not yet swapped (a partial copy), and otherwise renames it
`__tenant_backup` (it holds the original).

The rebuild Workflow does a full dbt refresh of staging, everything upstream of
it and `identity.identity_inputs`, runs the identity seed once, then fully
refreshes everything else, gold included. History relations refuse the full
refresh and run incrementally. A model whose Bronze is absent or empty is
skipped by dbt and rebuilds on its connector's next sync; until then its
migrated tables stay as they are. Every step runs even when an earlier one
failed. When the Workflow ends, however it ends, its exit handler resumes the
writers as they were recorded and deletes the ConfigMap. A sync schedule named
for the former tenant stays suspended: reconcile's next tick renames its
Airbyte source and connection in place and replaces it with a schedule named
for the UUID.

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
  resumed, and the ConfigMap is gone, so no deploy submits the rebuild again.
  A failed model rebuilds on its connector's next sync; to rebuild it sooner,
  run dbt-run for it by hand.

## Analytics until the rebuild finishes

Between the deploy and the end of the rebuild, analytics may read stale or
not-ready: staging, silver, gold and the identity maps are rebuilt from
Bronze. No sync runs until the rebuild has finished. On a large install this
takes hours; each dbt step's deadline is
`ingestion.tenantCutover.dbtStepDeadlineSeconds` (default 6h).

## Once the stand is proven, drop the backups

The backups use as much ClickHouse disk again as the migrated tables: 5–9 GiB
on vz and dev, under 1 GiB on cfabric. Check there is room before the deploy:

```sql
SELECT formatReadableSize(sum(total_bytes)) FROM system.tables
WHERE database LIKE 'bronze\_%' OR database IN ('config', 'ingestion_history', 'staging', 'silver', 'insight');
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
