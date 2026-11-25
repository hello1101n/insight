{{ config(
    materialized='incremental',
    incremental_strategy='append',
    schema='staging',
    tags=['slack', 'silver', 'silver:identity_inputs']
) }}

{{ identity_inputs_from_history(
    fields_history_ref=ref('slack__users_fields_history'),
    source_type='slack',
    identity_fields=[
        {'field': 'email',        'value_type': 'email',        'value_field_name': 'bronze_slack.users_details.email_address'},
        {'field': 'display_name', 'value_type': 'display_name', 'value_field_name': 'bronze_slack.users.real_name'},
    ]
) }}
