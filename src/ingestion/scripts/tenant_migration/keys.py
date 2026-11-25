"""How one row's tenant and key move to the install's tenant, as ClickHouse expressions.

A key carries its tenant as the leading segment, `{tenant}{sep}{source}{sep}…`
with `-` or `:` as the separator, or — `bronze_bamboohr.whos_out` — as the first
element of a JSON array `["{tenant}","{source}"]`. The tenant a key leads with is
the row's own tenant value, NULL read as empty; only that segment changes, and
only when the row's source follows it. A key of any other shape stays.

Every column is read qualified by the alias `src`, so no expression can pick up
an output column of the same name.
"""

from __future__ import annotations

import re

from tenant_migration.inventory import Table

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SEPARATORS = ("-", ":")
SOURCE_ALIAS = "src"


class TenantError(ValueError):
    pass


def parse_tenant(value: str | None, origin: str) -> str:
    if not value:
        raise TenantError(f"no tenant: {origin} is unset — the chart sets it from authenticator.oidc.defaultTenantId")
    if not UUID.match(value):
        raise TenantError(f"the tenant from {origin} must be a lowercase UUID, got {value!r}")
    return value


def col(name: str) -> str:
    return f"{SOURCE_ALIAS}.`{name}`"


def lit(value: str) -> str:
    """A string literal; a tenant is a UUID and a separator is fixed, so nothing needs escaping."""
    return f"'{value}'"


def old_tenant(table: Table) -> str:
    return f"ifNull(toString({col(table.tenant)}), '')" if table.tenant else "''"


def _key_value(table: Table) -> str:
    assert table.key is not None
    return f"ifNull({col(table.key)}, '')"


def new_key(table: Table, tenant: str) -> str:
    """The row's key with its leading tenant replaced; a key of another shape stays."""
    key, old = _key_value(table), old_tenant(table)
    rest = f"concat({lit(tenant)}, substring({key}, length({old}) + 1))"
    branches = []
    if table.source:
        source = f"ifNull(toString({col(table.source)}), '')"
        for sep in SEPARATORS:
            branches += [
                f"startsWith({key}, concat({old}, '{sep}', {source}, '{sep}')) OR {key} = concat({old}, '{sep}', {source})",
                rest,
            ]
        branches += [f"{key} = toJSONString([{old}, {source}])", f"toJSONString([{lit(tenant)}, {source}])"]
    else:
        for sep in SEPARATORS:
            branches += [f"{old} != '' AND startsWith({key}, concat({old}, '{sep}'))", rest]
    return f"multiIf({', '.join(branches)}, {key})"


def key_expression(table: Table, tenant: str) -> str:
    """`new_key`, except that a NULL key stays NULL."""
    assert table.key is not None
    if table.types[table.key].startswith("Nullable"):
        return f"if({col(table.key)} IS NULL, NULL, {new_key(table, tenant)})"
    return new_key(table, tenant)


def comment_id_expression(table: Table) -> str:
    """A YouTrack comment's id, read from its key where the row lacks it: `{tenant}-{source}-{id}`."""
    assert table.comment_id and table.key and table.source
    prefix = f"concat({old_tenant(table)}, '-', ifNull(toString({col(table.source)}), ''), '-')"
    key, comment = _key_value(table), col(table.comment_id)
    return f"if({comment} IS NULL AND startsWith({key}, {prefix}), substring({key}, length({prefix}) + 1), {comment})"


def foreign(table: Table, tenant: str) -> str:
    """The row's tenant is not the install's: NULL, empty or another value."""
    return f"{old_tenant(table)} != {lit(tenant)}" if table.tenant else "1"
