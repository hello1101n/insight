"""Every statement the migration sends that names a table, built in one place.

ClickHouse takes no parameters for identifiers, so names are interpolated.
SAFETY: a `Relation` admits only plain identifiers (see inventory.IDENTIFIER)
and every name is backquoted by `inventory.quote`. Values are bound as query parameters.
"""

from __future__ import annotations

import re

from tenant_migration.inventory import TENANT_COLUMN, Relation, Table, quote

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


def _word(name: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])")


def renamed(create: str, table: Table) -> str:
    """A table's DDL with its tenant and source columns under their new names, in the definition and
    every key. Only the whole word changes: `azure_tenant_id` or `org_source_id` stay as they are."""
    for column in (table.tenant, table.source):
        if column and table.renamed(column) != column:
            create = _word(column).sub(table.renamed(column), create)
    return create


def add_tenant(rel: Relation, suffix: str, after: str | None) -> str:
    place = f" AFTER {quote(after)}" if after else " FIRST"
    return f"ALTER TABLE {rel.sql(suffix)} ADD COLUMN {quote(TENANT_COLUMN)} Nullable(String){place}"


def insert(rel: Relation, suffix: str, columns: list[str], expressions: list[str]) -> str:
    # A table partitioned finer than the default limit of 100 partitions per block refuses the copy otherwise.
    names = ", ".join(quote(c) for c in columns)
    return (
        f"INSERT INTO {rel.sql(suffix)} ({names}) SETTINGS max_partitions_per_insert_block = 0 "
        f"SELECT {', '.join(expressions)} FROM {rel.sql()} AS src"
    )


def drop(rel: Relation, suffix: str) -> str:
    return f"DROP TABLE IF EXISTS {rel.sql(suffix)}"


def rename(rel: Relation, suffix: str, to_suffix: str) -> str:
    return f"RENAME TABLE {rel.sql(suffix)} TO {rel.sql(to_suffix)}"


def exchange(rel: Relation, suffix: str) -> str:
    return f"EXCHANGE TABLES {rel.sql()} AND {rel.sql(suffix)}"
