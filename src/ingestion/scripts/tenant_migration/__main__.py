"""Move a warm install's stored tenant to the install's tenant UUID.

    python3 -m tenant_migration plan [--exit-code]
    python3 -m tenant_migration apply
    python3 -m tenant_migration finalize

The tenant is INSIGHT_TENANT_ID (authenticator.oidc.defaultTenantId), a
lowercase UUID; nothing else is read. Every MergeTree table in `bronze_*`,
`config`, `ingestion_history`, `staging`, `silver` and `insight` (gold), and
every history relation, that still names its tenant `tenant_id` or its source
`source_id` (the ledger keeps both), holds a tenant other than the UUID, or (in
silver, or a history relation) has no tenant at all, is copied into
`<table>__tenant_copy` with each row's tenant and key prefix moved to the UUID,
checked, and EXCHANGEd in; the original is then renamed `<table>__tenant_backup`.
A table already in that shape is skipped.

`plan` reads only; with --exit-code it exits 1 while any table is pending.
`apply` migrates every pending table or none: on any failure it puts back each
original it already swapped out and exits 2 (3 when that undo failed too). Run
with every writer stopped (the chart's pre-upgrade hook does). `finalize` drops
the backups, orphans included, by hand, once the install is proven.

Required env: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, INSIGHT_TENANT_ID.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
from types import FrameType

from tenant_migration import apply as migration
from tenant_migration.clickhouse import ClickHouse, ClickHouseError
from tenant_migration.ddl import DdlError
from tenant_migration.inventory import BACKUP, InventoryError, discover, history_relations
from tenant_migration.keys import TenantError, parse_tenant
from tenant_migration.plan import TablePlan, render, survey

TENANT_ENV = "INSIGHT_TENANT_ID"
PENDING = 1
FAILED = 2
#: The run failed and some table could not be put back: writers must stay stopped.
UNDO_FAILED = 3


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tenant_migration", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan").add_argument(
        "--exit-code", action="store_true", help=f"exit {PENDING} while any table is pending"
    )
    commands.add_parser("apply")
    commands.add_parser("finalize")
    return parser


def _plan(ch: ClickHouse, tenant: str) -> list[TablePlan]:
    return survey(ch, discover(ch, history_relations()), tenant)


def _interrupted(signum: int, _frame: FrameType | None) -> None:
    raise KeyboardInterrupt(f"stopped by signal {signum}")


def run(args: argparse.Namespace, ch: ClickHouse) -> int:
    if args.command == "finalize":
        print("\n".join(f"dropped {r}" for r in migration.finalize(ch)) or "nothing to finalize")
        return 0
    tenant = parse_tenant(os.environ.get(TENANT_ENV), TENANT_ENV)
    print(f"tenant: {tenant} (from {TENANT_ENV})")
    plans = _plan(ch, tenant)
    print(render(plans), flush=True)
    leftovers = migration.leftover_copies(ch)
    for rel in leftovers:
        print(f"left by a killed run: {rel}__tenant_copy (apply settles it)")
    pending = any(p.pending for p in plans) or bool(leftovers)
    if args.command == "plan":
        return PENDING if args.exit_code and pending else 0
    signal.signal(signal.SIGTERM, _interrupted)
    migrated = migration.apply(ch, plans, tenant)
    print(f"migrated {len(migrated)} table(s); originals kept as <table>{BACKUP}* until `finalize`")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return run(args, ClickHouse.from_env())
    except migration.UndoError as error:
        print(f"error: {error}", file=sys.stderr)
        return UNDO_FAILED
    except (TenantError, ClickHouseError, InventoryError, DdlError, migration.MigrationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return FAILED


if __name__ == "__main__":
    raise SystemExit(main())
