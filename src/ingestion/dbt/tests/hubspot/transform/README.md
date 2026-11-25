# HubSpot transformation tests

These tests execute dbt against a disposable ClickHouse and reset its Zendesk
and HubSpot Bronze tables. Never point them at a shared database.

Bronze is created by the Zendesk and HubSpot connectors through the real
destination (`tests/bronze.py`), so `docker`, mikefarah `yq` v4 and `jq`
have to be on `PATH`. Both are needed because every `class_support_*` union
reads both arms. CI runs the suite in `.github/workflows/support-transform.yml`.

## Run it

A throwaway ClickHouse and the pinned dbt from `scripts/bootstrap-db/pins.env`:

```bash
. src/ingestion/scripts/bootstrap-db/pins.env
docker run -d --name support-dbt-test -p 18125:8123 \
  -e CLICKHOUSE_USER=insight -e CLICKHOUSE_PASSWORD=insight \
  -e CLICKHOUSE_DB=insight -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  "$CLICKHOUSE_SERVER_IMAGE"
python3.12 -m venv /tmp/support-dbt-venv
/tmp/support-dbt-venv/bin/pip install "dbt-core==$DBT_CORE_VERSION" \
  "dbt-clickhouse==$DBT_CLICKHOUSE_VERSION" \
  -r src/ingestion/dbt/tests/hubspot/transform/requirements.txt
```

```bash
cd src/ingestion/dbt/tests/hubspot/transform
CLICKHOUSE_HOST=127.0.0.1 CLICKHOUSE_HTTP_PORT=18125 \
CLICKHOUSE_CONTAINER_HOST=host.docker.internal \
CLICKHOUSE_USER=insight CLICKHOUSE_PASSWORD=insight \
HUBSPOT_TEST_DISPOSABLE=yes \
/tmp/support-dbt-venv/bin/pytest -q
```

`CLICKHOUSE_CONTAINER_HOST` is how the destination's container reaches the same
server: `host.docker.internal` on Docker Desktop, the bridge gateway on Linux
(`docker network inspect bridge -f '{{ (index .IPAM.Config 0).Gateway }}'`).

## Writing a test

A test seeds bronze through `case.insert(table, tenant, key, ...)` and builds
only the models it reads with `case.build("<selector>")`, ancestors included
(`+model`). Every test starts from empty bronze, and the incremental
`hubspot__*` staging tables are dropped so their first build is a full one.

The scenarios cover two tenants sharing one source's ticket, stage, owner,
property and contact ids: ticket status from the stage, merges, custom
properties, the event order and actors of the ticket history, which contacts
are support customers, and the support classes. A bronze row without a valid
tenant fails the build of the CRM staging model that reads it; with
`--vars '{bronze_tenant_on_invalid: warn}'` it builds, and the `not_empty` test on
the tenant of each support model that reads it reports the row.
