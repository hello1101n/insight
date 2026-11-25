# Moving an install to the canonical tenant UUID

From the release that contains
[#3661](https://github.com/constructorfabric/insight/issues/3661) an install has
one tenant: the lowercase UUID in `authenticator.oidc.defaultTenantId`. Bronze,
the history relations, operator config, the sync ledger, identity resolution and
analytics all key on it. An install that already holds data written under the
old `ingestion.reconcile.tenantId` (often not a UUID) moves to it on its next
deploy, by the chart's hooks. Nothing is done by hand except the final
[clean-up](#once-the-stand-is-proven-drop-the-backups).

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

`tenant_migration apply` handles every MergeTree table in `bronze_*`, `config`
and `ingestion_history`, and every history relation
(`src/ingestion/scripts/tenant_migration/history-tables.txt`), that still has a
`tenant_id` column or holds a tenant other than the UUID. For each one it
creates a copy with the column named `insight_tenant_id`, with the same type and
position (`ingestion_history` keeps `tenant_id`). It inserts every row with the
tenant set to the UUID and the tenant prefix of `unique_key` rewritten. It then
checks the row (or key) count and `EXCHANGE`s the copy in. The original stays
beside it as `<table>__tenant_backup`, or as `__tenant_backup_<n>` when an
earlier deploy left one. A history relation built before it had a tenant column
gets one. A table already in the target shape is skipped.

If anything fails, including the hook's deadline, the hook swaps every table
already exchanged back, resumes the writers it suspended and fails the deploy.
The previous release keeps running as before.

The rebuild Workflow does a full dbt refresh of staging and
`identity.identity_inputs`, runs the identity seed once, then fully refreshes
everything else, gold included. History relations refuse the full refresh and
run incrementally. Its last step resumes the writers as they were recorded and
deletes the ConfigMap. A sync schedule named for the former tenant stays
suspended: reconcile's next tick renames its Airbyte source and connection in
place and replaces it with a schedule named for the UUID.

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
- **The rebuild Workflow fails**: the writers stay suspended and the ConfigMap
  remains. Fix the cause and deploy again; the post hook submits the rebuild
  again.

## Analytics until the rebuild finishes

Between the deploy and the end of the rebuild, analytics reads empty or
not-ready: staging, silver, gold and the identity maps are rebuilt from
Bronze. No sync runs until the rebuild has finished. On a large install this
takes hours; each dbt step's deadline is
`ingestion.tenantCutover.dbtStepDeadlineSeconds` (default 6h).

## Once the stand is proven, drop the backups

The backups use as much ClickHouse disk again as the migrated tables. Once
the stand has run normally for a while, drop them by hand. No hook ever does.
Leftover backups never block a later deploy.

```sh
kubectl -n <NS> run tenant-finalize --rm -it --restart=Never \
  --image=<ingestion.toolboxImage> --env=CLICKHOUSE_URL=http://<clickhouse.host>:8123 \
  --env=CLICKHOUSE_USER=<clickhouse.username> --env=CLICKHOUSE_PASSWORD=<password> \
  --command -- sh -c 'cd /ingestion/scripts && python3 -m tenant_migration finalize'
```

`finalize` drops every `*__tenant_backup*` table whose live table exists.
Until then, swapping a backup back by hand
(`EXCHANGE TABLES <t> AND <t>__tenant_backup`) is the only way back. There is no
rollback.
