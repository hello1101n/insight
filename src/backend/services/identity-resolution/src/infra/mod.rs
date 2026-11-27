pub mod db;
pub mod identity_evidence;
pub mod identity_inputs;
pub mod identity_persons;
pub mod metrics;
pub mod telemetry;

fn tag_seed_queries(client: insight_clickhouse::Client) -> insight_clickhouse::Client {
    match std::env::var("INSIGHT_QUERY_TAG") {
        Ok(tag) => client.with_log_comment(tag),
        Err(_) => client,
    }
}
