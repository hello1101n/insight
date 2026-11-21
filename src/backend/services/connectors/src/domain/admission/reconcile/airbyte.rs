use anyhow::{Context, Result, ensure};
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use serde_json::{Value, json};

use crate::{api::AppState, domain::admission::StageRow};

pub(super) struct Completion {
    pub status: String,
    pub committed: bool,
    pub end: Option<chrono::DateTime<chrono::Utc>>,
    pub records: Option<u64>,
    pub bytes: Option<u64>,
}

impl Completion {
    pub(super) fn observed(
        status: &str,
        emitted: Option<u64>,
        committed: Option<u64>,
        bytes: Option<u64>,
        end: Option<i64>,
    ) -> Option<Self> {
        matches!(status, "succeeded" | "failed" | "cancelled").then(|| Self {
            status: status.into(),
            committed: status == "succeeded" && emitted.is_some() && emitted == committed,
            records: emitted,
            bytes,
            end: end
                .and_then(|e| chrono::DateTime::from_timestamp(e, 0))
                .filter(|t| *t <= chrono::Utc::now()),
        })
    }
}

pub(super) async fn terminal_job(
    state: &AppState,
    http: &reqwest::Client,
    row: &StageRow,
) -> Result<Option<Completion>> {
    let config = &state.cluster.airbyte_reader;
    let Some(job) = row.airbyte_job_id.as_deref() else {
        return Ok(None);
    };
    let job: u64 = job.parse()?;
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
    let response = http
        .post(base.join("/api/v1/jobs/get")?)
        .bearer_auth(token)
        .json(&json!({"id":job}))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    confirmed(
        &response,
        job,
        row.connection_id
            .as_deref()
            .context("missing Airbyte connection")?,
    )
}

fn confirmed(response: &Value, job: u64, connection: &str) -> Result<Option<Completion>> {
    let remote = &response["job"];
    ensure!(
        remote["id"].as_u64() == Some(job)
            && remote["configId"].as_str() == Some(connection)
            && remote["configType"] == "sync",
        "Airbyte job identity mismatch"
    );
    let last = response["attempts"].as_array().and_then(|a| {
        a.iter()
            .filter_map(|entry| entry.get("attempt"))
            .max_by_key(|v| v["id"].as_u64())
    });
    let stats = last.map(|v| &v["totalStats"]);
    Ok(Completion::observed(
        remote["status"].as_str().unwrap_or(""),
        stats.and_then(|v| v["recordsEmitted"].as_u64()),
        stats.and_then(|v| v["recordsCommitted"].as_u64()),
        stats.and_then(|v| v["bytesEmitted"].as_u64()),
        last.and_then(|v| v["endedAt"].as_i64())
            .or_else(|| remote["updatedAt"].as_i64()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_accepts_only_the_exact_terminal_job_and_confirmed_writes() -> Result<()> {
        let mut response = json!({"job":{"id":23,"configType":"sync","configId":"jira","status":"succeeded"},"attempts":[{"attempt":{"id":0,"endedAt":1000,"totalStats":{"recordsEmitted":9,"recordsCommitted":9}}}]});
        assert!(confirmed(&response, 24, "jira").is_err());
        assert!(confirmed(&response, 23, "github").is_err());
        assert!(
            confirmed(&response, 23, "jira")?.is_some_and(|r| r.committed && r.records == Some(9))
        );
        response["attempts"][0]["attempt"]["totalStats"]["recordsCommitted"] = Value::Null;
        assert!(confirmed(&response, 23, "jira")?.is_some_and(|r| !r.committed));
        response["job"]["status"] = json!("incomplete");
        assert!(confirmed(&response, 23, "jira")?.is_none());
        Ok(())
    }
}
