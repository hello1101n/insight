"""What the migration would change. Nothing here writes."""

from __future__ import annotations

import json
from dataclasses import dataclass

from tenant_migration import keys
from tenant_migration.clickhouse import ClickHouse
from tenant_migration.inventory import InventoryError, Table

#: One install holds one tenant; a few more (empty, the UUID, a legacy name) are what a key can lead with.
MAX_TENANTS = 16


@dataclass(frozen=True)
class TablePlan:
    table: Table
    rows: int
    moving: int
    #: The tenants the table's rows hold now ('' for none); a table without a tenant column holds none.
    tenants: tuple[str, ...] = ()

    @property
    def pending(self) -> bool:
        return self.table.renames or self.table.adds or bool(self.table.drops) or self.moving > 0

    @property
    def change(self) -> str:
        table, parts = self.table, []
        if table.adds:
            parts.append(f"adds {table.target}")
        if table.renames_tenant:
            parts.append(f"renames {table.tenant} to {table.target}")
        if table.renames_source:
            parts.append(f"renames {table.source} to {table.source_target}")
        if table.drops:
            parts.append(f"drops the empty {', '.join(table.drops)}")
        return ", ".join(parts) or "sets the tenant"


def survey_table(ch: ClickHouse, table: Table, tenant: str) -> TablePlan:
    held = f"groupUniqArray({MAX_TENANTS})({keys.old_tenant(table)})" if table.tenant else "[]"
    ((rows, moving, tenants),) = ch.rows(
        f"SELECT count(), countIf({keys.foreign(table)}), toJSONString({held}) FROM {table.rel.sql()} AS src",
        params=keys.tenant_params(tenant),
    )
    if table.drops and int(rows):
        held = ", ".join(f"{c} beside insight_{c}" for c in table.drops)
        raise InventoryError(
            f"{table.rel}: holds {held} and has {rows} row(s) — the old columns are dropped only from an empty "
            "table; settle its rows by hand. Nothing was changed"
        )
    return TablePlan(table=table, rows=int(rows), moving=int(moving), tenants=tuple(sorted(json.loads(tenants))))


def survey(ch: ClickHouse, tables: list[Table], tenant: str) -> list[TablePlan]:
    return [survey_table(ch, t, tenant) for t in tables]


def render(plans: list[TablePlan]) -> str:
    pending = [p for p in plans if p.pending]
    lines = [f"{'relation':<64} {'rows':>12} {'moving':>12}  change"]
    lines += [f"{p.table.relation:<64} {p.rows:>12} {p.moving:>12}  {p.change}" for p in pending]
    lines.append(f"tables changing: {len(pending)}")
    return "\n".join(lines)
