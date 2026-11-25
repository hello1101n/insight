"""What the migration would change. Nothing here writes."""

from __future__ import annotations

from dataclasses import dataclass

from tenant_migration import keys
from tenant_migration.clickhouse import ClickHouse
from tenant_migration.inventory import Table


@dataclass(frozen=True)
class TablePlan:
    table: Table
    rows: int
    moving: int

    @property
    def pending(self) -> bool:
        return self.table.renames or self.table.adds or self.moving > 0

    @property
    def change(self) -> str:
        if self.table.adds:
            return f"adds {self.table.target}"
        if self.table.renames:
            return f"renames {self.table.tenant} to {self.table.target}"
        return "sets the tenant"


def survey_table(ch: ClickHouse, table: Table, tenant: str) -> TablePlan:
    ((rows, moving),) = ch.rows(f"SELECT count(), countIf({keys.foreign(table, tenant)}) FROM {table.rel.sql()} AS src")
    return TablePlan(table=table, rows=int(rows), moving=int(moving))


def survey(ch: ClickHouse, tables: list[Table], tenant: str) -> list[TablePlan]:
    return [survey_table(ch, t, tenant) for t in tables]


def render(plans: list[TablePlan]) -> str:
    pending = [p for p in plans if p.pending]
    lines = [f"{'relation':<64} {'rows':>12} {'moving':>12}  change"]
    lines += [f"{p.table.relation:<64} {p.rows:>12} {p.moving:>12}  {p.change}" for p in pending]
    lines.append(f"tables changing: {len(pending)}")
    return "\n".join(lines)
