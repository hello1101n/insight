{#- Shared expressions for the HubSpot arms of the class_support_* contract. -#}

{%- macro hubspot_support_key(parts) -%}
concat(insight_tenant_id, '-', insight_source_id{% for part in parts %}, '-', coalesce(toString({{ part }}), ''){% endfor %})
{%- endmacro -%}

{%- macro hubspot_support_scope(source_column='source_id') -%}
coalesce(insight_tenant_id, '')                            AS insight_tenant_id,
        coalesce({{ source_column }}, '')                   AS insight_source_id
{%- endmacro -%}

{%- macro hubspot_support_version() -%}
toUnixTimestamp64Milli(now64(3))
{%- endmacro -%}

{%- macro hubspot_support_time(expr) -%}
CAST({{ expr }} AS Nullable(DateTime64(3, 'UTC')))
{%- endmacro -%}

{%- macro hubspot_collected_at(version) -%}
CAST(fromUnixTimestamp64Milli({{ version }}, 'UTC') AS DateTime64(3))
{%- endmacro -%}
