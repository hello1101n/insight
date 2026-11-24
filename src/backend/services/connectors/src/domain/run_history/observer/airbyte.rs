use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{api::AppState, domain::run_history::StageSnapshot};

#[derive(Debug, Deserialize)]
pub(super) struct PollEvidence {
    pub(super) job_id: u64,
    status: String,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    records_reported: Option<u64>,
    reason: Option<String>,
}

impl PollEvidence {
    pub(super) fn apply(&self, stage: &mut StageSnapshot, fallback_end: Option<DateTime<Utc>>) {
        stage.started_at = timestamp(self.started_at);
        stage.records = self.records_reported;
        let (status, default_reason) = match self.status.as_str() {
            "succeeded" => ("succeeded", None),
            "failed" => ("failed", Some("airbyte_job_failed")),
            "cancelled" => ("cancelled", Some("airbyte_job_cancelled")),
            _ => return,
        };
        stage.status = status;
        stage.reason = self
            .reason
            .clone()
            .or_else(|| default_reason.map(str::to_owned));
        stage.finished_at = timestamp(self.ended_at).or(fallback_end);
    }
}

fn timestamp(at: Option<i64>) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp(at?, 0).filter(|at| *at <= Utc::now())
}

pub(super) async fn job(
    state: &AppState,
    http: &reqwest::Client,
    id: u64,
    connection: uuid::Uuid,
) -> Result<PollEvidence> {
    let (base, token) = credentials(state, http).await?;
    let response = http
        .post(base.join("/api/v1/jobs/get")?)
        .bearer_auth(token)
        .json(&json!({"id":id}))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    parse_job(&response, id, connection)
}

fn parse_job(response: &Value, id: u64, connection: uuid::Uuid) -> Result<PollEvidence> {
    let remote = &response["job"];
    ensure!(
        remote["id"].as_u64() == Some(id)
            && remote["configId"]
                .as_str()
                .and_then(|value| value.parse().ok())
                == Some(connection)
            && remote["configType"] == "sync",
        "Airbyte job identity mismatch"
    );

    let status = remote["status"]
        .as_str()
        .context("missing Airbyte job status")?;
    let attempts = response["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("attempt"));
    let started_at = attempts
        .clone()
        .filter_map(|v| v["startedAt"].as_i64())
        .min();
    let last = attempts.max_by_key(|v| v["id"].as_u64());
    let records_reported = last.and_then(|v| {
        v["totalStats"]["recordsEmitted"]
            .as_u64()
            .or_else(|| v["recordsSynced"].as_u64())
    });
    let ended_at = last
        .and_then(|v| v["endedAt"].as_i64())
        .or_else(|| remote["updatedAt"].as_i64());

    let invalid_success = status == "succeeded"
        && last.is_none_or(|v| {
            v["streamStats"].as_array().is_none_or(Vec::is_empty)
                || v["failureSummary"]["failures"]
                    .as_array()
                    .is_some_and(|f| !f.is_empty())
        });
    Ok(PollEvidence {
        job_id: id,
        started_at,
        ended_at,
        records_reported,
        status: if invalid_success { "failed" } else { status }.to_owned(),
        reason: invalid_success.then(|| "airbyte_job_failed".to_owned()),
    })
}

async fn credentials(state: &AppState, http: &reqwest::Client) -> Result<(url::Url, String)> {
    let config = &state.cluster.airbyte_reader;
    let base = url::Url::parse(&config.url)?;
    ensure!(
        matches!(base.scheme(), "https" | "http"),
        "invalid Airbyte server URL"
    );
    let client = state
        .cluster
        .client
        .clone()
        .context("missing Kubernetes client")?;
    let secrets = Api::<Secret>::namespaced(client, &state.cluster.airbyte_namespace);
    let creds = tokio::time::timeout(super::PERIOD, secrets.get(&config.secret))
        .await??
        .data
        .context("missing Airbyte credentials")?;
    let read = |key: &str| -> Result<&str> {
        Ok(std::str::from_utf8(
            &creds.get(key).context("missing Airbyte credential key")?.0,
        )?)
    };
    let auth=http.post(base.join("/api/v1/applications/token")?).json(&json!({
        "client_id":read(&config.client_id_key)?,"client_secret":read(&config.client_secret_key)?,"grant_type":"client_credentials"
    })).send().await?.error_for_status()?.json::<Value>().await?;
    let token = auth["access_token"]
        .as_str()
        .context("missing Airbyte access token")?;
    Ok((base, token.to_owned()))
}
