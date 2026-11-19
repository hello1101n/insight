{#- Readers of the whole API objects bronze keeps in `payload_json`. -#}

{%- macro zendesk_id(json, key) -%}
nullIf(nullIf(trim(BOTH '"' FROM JSONExtractRaw({{ json }}, {{ key }})), 'null'), '')
{%- endmacro -%}

{%- macro zendesk_text(json, key) -%}
nullIf(JSONExtractString({{ json }}, {{ key }}), '')
{%- endmacro -%}

{%- macro zendesk_time(json, key) -%}
parseDateTime64BestEffortOrNull(JSONExtractString({{ json }}, {{ key }}), 3, 'UTC')
{%- endmacro -%}

{%- macro zendesk_bronze(table) -%}
(
    SELECT
        tenant_id,
        source_id                    AS insight_source_id,
        coalesce(payload_json, '{}') AS payload,
        _airbyte_extracted_at        AS collected_at
    FROM {{ source('bronze_zendesk', table) }} FINAL
)
{%- endmacro -%}

{%- macro zendesk_key(parts) -%}
concat(tenant_id, '-', insight_source_id{% for part in parts %}, '-', coalesce(toString({{ part }}), ''){% endfor %})
{%- endmacro -%}

{%- macro zendesk_version() -%}
toUnixTimestamp64Milli(now64(3))
{%- endmacro -%}
