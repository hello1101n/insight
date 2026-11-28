"""How one row's tenant and key move to the install's tenant, as ClickHouse expressions.

A key carries its tenant as the leading segment, `{tenant}{sep}{source}{sep}…`
with `-` or `:` as the separator, or — `bronze_bamboohr.whos_out` — as the first
element of a JSON array `["{tenant}","{source}"]`. The tenant a key leads with is
the row's own tenant value, NULL read as empty; only that segment changes, and
only when the row's source follows it. In a table that gains its tenant the row
has none to read: the key moves when it leads with a tenant another table's
rows held (`LEGACY`), followed by `-{source}-`. A key of any other shape stays.

Every column is read qualified by the alias `src`, so no expression can pick up
an output column of the same name. The install's tenant is never in the SQL text:
it is the placeholder `TENANT`, bound by the caller as `params=tenant_params(tenant)`.
"""

from __future__ import annotations

import re

from tenant_migration.inventory import Table, param_text, quote

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SEPARATORS = ("-", ":")
SOURCE_ALIAS = "src"
#: The install's tenant in every statement; bound by `tenant_params`.
TENANT = "{tenant:String}"
#: Every tenant a row in scope holds before the run; bound by `tenant_params`.
LEGACY = "{legacy:Array(String)}"


class TenantError(ValueError):
    pass


def parse_tenant(value: str | None, origin: str) -> str:
    if not value:
        raise TenantError(f"no tenant: {origin} is unset — the chart sets it from authenticator.oidc.defaultTenantId")
    if not UUID.match(value):
        raise TenantError(f"the tenant from {origin} must be a lowercase UUID, got {value!r}")
    return value


def tenant_params(tenant: str, legacy: tuple[str, ...] = ()) -> dict[str, str]:
    """`tenant`, and the tenants the warehouse's rows held (`LEGACY`), as query parameters."""
    return {"tenant": tenant, "legacy": "[" + ", ".join(param_text(t) for t in legacy) + "]"}


def col(name: str) -> str:
    return f"{SOURCE_ALIAS}.{quote(name)}"


def old_tenant(table: Table) -> str:
    return f"ifNull(toString({col(table.tenant)}), '')" if table.tenant else "''"


def _key_value(table: Table) -> str:
    assert table.key is not None
    return f"ifNull({col(table.key)}, '')"


def new_key(table: Table) -> str:
    """The row's key with its leading tenant replaced; a key of another shape stays."""
    key, old = _key_value(table), old_tenant(table)
    rest = f"concat({TENANT}, substring({key}, length({old}) + 1))"
    branches = []
    if table.source:
        source = f"ifNull(toString({col(table.source)}), '')"
        for sep in SEPARATORS:
            branches += [
                f"startsWith({key}, concat({old}, '{sep}', {source}, '{sep}')) OR {key} = concat({old}, '{sep}', {source})",
                rest,
            ]
        branches += [f"{key} = toJSONString([{old}, {source}])", f"toJSONString([{TENANT}, {source}])"]
    else:
        for sep in SEPARATORS:
            branches += [f"{old} != '' AND startsWith({key}, concat({old}, '{sep}'))", rest]
    return f"multiIf({', '.join(branches)}, {key})"


def gained_key(table: Table) -> str:
    """A key in a table gaining its tenant. The row holds no tenant to read, so the key's leading
    segment moves when it is a tenant some other row in scope held, followed by the row's source."""
    key = _key_value(table)
    source = f"ifNull(toString({col(table.source or '')}), '')"
    found = f"arrayFirstIndex(t -> startsWith({key}, concat(t, '-', {source}, '-')), {LEGACY})"
    return (
        f"if({source} != '' AND {found} > 0, "
        f"concat({TENANT}, substring({key}, length(arrayElement({LEGACY}, {found})) + 1)), {key})"
    )


def key_expression(table: Table) -> str:
    """The row's key under the install's tenant; a NULL key stays NULL."""
    assert table.key is not None
    moved = new_key(table) if table.tenant else gained_key(table)
    if table.types[table.key].startswith("Nullable"):
        return f"if({col(table.key)} IS NULL, NULL, {moved})"
    return moved


def comment_id_expression(table: Table) -> str:
    """A YouTrack comment's id, read from its key where the row lacks it: `{tenant}-{source}-{id}`."""
    assert table.comment_id and table.key and table.source
    prefix = f"concat({old_tenant(table)}, '-', ifNull(toString({col(table.source)}), ''), '-')"
    key, comment = _key_value(table), col(table.comment_id)
    return f"if({comment} IS NULL AND startsWith({key}, {prefix}), substring({key}, length({prefix}) + 1), {comment})"


def foreign(table: Table) -> str:
    """The row's tenant is not the install's: NULL, empty or another value. A table gaining
    its tenant moves every row; one that keeps none (only its source is renamed) moves none."""
    if table.tenant:
        return f"{old_tenant(table)} != {TENANT}"
    return "1" if table.adds else "0"
