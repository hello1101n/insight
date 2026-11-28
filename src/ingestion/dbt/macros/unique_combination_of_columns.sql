{#- Composite-key uniqueness: fails on every combination that occurs more than
    once. Local stand-in for dbt_utils' test of the same name; the project has
    no packages.yml. -#}
{% test unique_combination_of_columns(model, combination_of_columns) %}
{%- set columns = combination_of_columns | join(', ') %}
SELECT {{ columns }}, count() AS row_count
FROM {{ model }}
GROUP BY {{ columns }}
HAVING count() > 1
{% endtest %}
