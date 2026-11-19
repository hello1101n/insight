{{ config(
    materialized='table',
    schema='staging',
    tags=['slack', 'silver']
) }}

{#- INVARIANT: user_id gives each member a first-version row, so a member without email or name still gets its id row. #}
{{ fields_history(
    snapshot_ref=ref('slack__users_snapshot'),
    entity_id_col='user_id',
    fields=[
        'user_id',
        'email',
        'display_name'
    ]
) }}
