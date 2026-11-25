"""Move a warm install's stored tenant to the canonical tenant UUID.

    python3 -m tenant_migration plan     [--tenant <uuid>] [--old-tenant <key>]
    python3 -m tenant_migration apply    [--tenant <uuid>] [--old-tenant <key>] --dump-dir <new dir>
    python3 -m tenant_migration rollback
    python3 -m tenant_migration restore  --dump-dir <dir>
    python3 -m tenant_migration finalize

`--tenant` defaults to INSIGHT_TENANT_ID, the install's configured tenant.
`--old-tenant`, the tenant segment the install's keys were written with,
defaults to the one tenant the stored rows hold besides it; rows with an empty
tenant move too. When the rows hold no other tenant, only the rows with a NULL
or empty tenant move. Run with connectors and dbt stopped.

`apply` keeps each original until `finalize`. After an interruption anywhere,
`rollback` puts the originals back and `finalize` keeps what is live; both, and
`restore`, read the state from the warehouse and can be run again until they
succeed.

Required env: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, and
INSIGHT_TENANT_ID unless --tenant is given.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from tenant_migration import apply as migration
from tenant_migration.clickhouse import ClickHouse, ClickHouseError
from tenant_migration.inventory import BACKUP, discover, history_relations
from tenant_migration.keys import UUID, TenantError, Tenants, old_tenant_from
from tenant_migration.plan import Plan, stored_tenants, survey
from tenant_migration.prerequisites import fill_youtrack_comment_ids

TENANT_ENV = "INSIGHT_TENANT_ID"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tenant_migration", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "apply"):
        command = commands.add_parser(name)
        command.add_argument("--tenant", help=f"the canonical tenant, a lowercase UUID; default ${TENANT_ENV}")
        command.add_argument(
            "--old-tenant", help="the tenant the stored keys carry now; default the one the stored rows hold"
        )
        if name == "apply":
            command.add_argument("--dump-dir", required=True, type=Path, help="a new directory for the dump")
    commands.add_parser("rollback")
    commands.add_parser("finalize")
    commands.add_parser("restore").add_argument("--dump-dir", required=True, type=Path)
    return parser


def render(plan: Plan) -> str:
    lines = [f"{'relation':<64} {'rows':>12} {'moving':>12}  tenant column"]
    lines += [
        f"{t.table.relation:<64} {t.rows:>12} {t.moving:>12}  {'renamed to insight_tenant_id' if t.table.renames_tenant else ''}"
        for t in plan.tables
        if t.rows or t.table.renames_tenant
    ]
    if plan.tenants.empty_only:
        lines.append("old tenant equals the new one: only rows with a NULL or empty tenant move")
    lines.append(f"tables changing: {len(plan.changing)}; YouTrack comment ids to fill: {plan.comment_ids_to_fill}")
    lines += [f"REFUSED {reason}" for reason in plan.refusals]
    return "\n".join(lines)


def _plan(ch: ClickHouse, args: argparse.Namespace) -> Plan:
    """The plan for the tenants given, or else configured (new) and stored (old); prints where each came from."""
    new, new_from = (args.tenant, "--tenant") if args.tenant is not None else (os.environ.get(TENANT_ENV), TENANT_ENV)
    if not new:
        raise TenantError(f"no tenant: {TENANT_ENV} is unset — set it to authenticator.oidc.defaultTenantId")
    if not UUID.match(new):
        raise TenantError(f"the tenant from {new_from} must be a lowercase UUID, got {new!r}")
    found = discover(ch, history_relations())
    if args.old_tenant is not None:
        old, old_from = args.old_tenant, "--old-tenant"
    else:
        old, old_from = old_tenant_from(stored_tenants(ch, found), new), "the stored rows"
    tenants = Tenants.parse(new, old)
    print(f"new tenant: {tenants.new} (from {new_from})")
    print(f"old tenant: {tenants.old!r} (from {old_from})")
    return survey(ch, found, tenants)


def run(args: argparse.Namespace, ch: ClickHouse) -> int:
    if args.command == "plan":
        plan = _plan(ch, args)
        print(render(plan))
        return 1 if plan.refusals else 0
    if args.command == "apply":
        plan = _plan(ch, args)
        print(render(plan))
        if plan.refusals:
            return 1
        moved = migration.apply(
            ch, plan, args.dump_dir, before_rewrite=[lambda: fill_youtrack_comment_ids(ch, plan.tenants)]
        )
        print(migration.describe(moved))
        print(f"migrated {len(moved)} table(s); originals kept as *{BACKUP} until `finalize` or `rollback`")
        return 0
    if args.command == "rollback":
        print("\n".join(f"rolled back {r}" for r in migration.rollback(ch)) or "nothing to roll back")
        return 0
    if args.command == "restore":
        print("\n".join(f"restored {r}" for r in migration.restore(ch, args.dump_dir)) or "nothing to restore")
        return 0
    print("\n".join(f"dropped {r}" for r in migration.finalize(ch)) or "nothing to finalize")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return run(args, ClickHouse.from_env())
    except (TenantError, ClickHouseError, migration.MigrationError, FileExistsError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
