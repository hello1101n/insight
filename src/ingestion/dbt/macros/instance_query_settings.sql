{% macro instance_query_settings(settings) %}
    {% set value = env_var('DBT_QUERY_MEMORY_BYTES', '') %}
    {% if value %}
        {% set cap = value | int %}
        {% set spill = cap // 2 %}
        {% do settings.update({
            'max_memory_usage': cap,
            'max_bytes_before_external_group_by': spill,
            'max_bytes_before_external_sort': spill,
            'max_bytes_ratio_before_external_group_by': 0,
            'max_bytes_ratio_before_external_sort': 0
        }) %}
    {% endif %}
    {{ return(settings) }}
{% endmacro %}
