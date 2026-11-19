-- INVARIANT: readers drop before what they select from, and every statement stays
-- IF EXISTS: this channel re-runs on every deploy.
DROP TABLE IF EXISTS silver.class_support_activity;
DROP TABLE IF EXISTS silver.dim_support_agent;
DROP TABLE IF EXISTS silver.dim_support_ticket;
DROP TABLE IF EXISTS staging.zendesk__support_activity;
DROP TABLE IF EXISTS staging.zendesk__support_agent;
DROP TABLE IF EXISTS staging.zendesk__support_ticket;
DROP TABLE IF EXISTS staging.zendesk__support_event;
