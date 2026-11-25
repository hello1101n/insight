"""Every statement the migration sends that names a table, built in one place.

ClickHouse takes no parameters for identifiers, so names are interpolated.
SAFETY: a `Relation` admits only plain identifiers (see inventory.IDENTIFIER)
and every name is backquoted.
"""

from __future__ import annotations

import re

from tenant_migration.inventory import OLD_TENANT_COLUMN, TENANT_COLUMN, Relation

OLD_TENANT = re.compile(rf"(?<![A-Za-z0-9_]){OLD_TENANT_COLUMN}(?![A-Za-z0-9_])")
CREATE_TABLE = re.compile(r"^CREATE TABLE \S+(?: UUID '[0-9A-Fa-f-]+')?")


class DdlError(RuntimeError):
    pass


def show_create(rel: Relation) -> str:
    return f"SHOW CREATE TABLE {rel.sql()}"


def create_like(rel: Relation, suffix: str) -> str:
    return f"CREATE TABLE {rel.sql(suffix)} AS {rel.sql()}"


def retarget(create: str, rel: Relation, suffix: str) -> str:
    """A table's DDL naming another table; an explicit UUID is dropped, as it is the original's."""
    if not CREATE_TABLE.match(create):
        raise DdlError(f"{rel}: SHOW CREATE does not start with CREATE TABLE")
    return CREATE_TABLE.sub(f"CREATE TABLE {rel.sql(suffix)}", create, count=1)


def tenant_renamed(create: str) -> str:
    """A table's DDL with its tenant column named `insight_tenant_id`, in its definition and every key."""
    return OLD_TENANT.sub(TENANT_COLUMN, create)


def add_tenant(rel: Relation, suffix: str, after: str | None) -> str:
    place = f" AFTER `{after}`" if after else " FIRST"
    return f"ALTER TABLE {rel.sql(suffix)} ADD COLUMN `{TENANT_COLUMN}` Nullable(String){place}"


def insert(rel: Relation, suffix: str, columns: list[str], expressions: list[str]) -> str:
    names = ", ".join(f"`{c}`" for c in columns)
    return f"INSERT INTO {rel.sql(suffix)} ({names}) SELECT {', '.join(expressions)} FROM {rel.sql()} AS src"


def drop(rel: Relation, suffix: str) -> str:
    return f"DROP TABLE IF EXISTS {rel.sql(suffix)}"


def exchange(rel: Relation, suffix: str) -> str:
    return f"EXCHANGE TABLES {rel.sql()} AND {rel.sql(suffix)}"
