{{ config(
    tags=['connector_quality', 'github'],
    severity='warn',
    store_failures=true,
    meta={
        'title': 'Unowned commit e-mails unique per tenant',
        'domain': 'git',
        'category': 'grain',
        'tier': 'error',
        'remediation': 'More than one row per (tenant, e-mail) publishes one address as two accounts. Check the github__unowned_commit_emails model for a unique_key that does not carry the tenant.'
    }
) }}
-- An unowned commit e-mail is published once per tenant.
--
-- Its identity input is keyed by tenant and source, so a second row for the same
-- e-mail and tenant would publish the address as two accounts.

SELECT
    email,
    tenant_id,
    count() AS rows
FROM {{ ref('github__unowned_commit_emails') }}
GROUP BY email, tenant_id
HAVING rows > 1
