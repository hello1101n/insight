use super::super::{Observation, StageRow};
use chrono::{DateTime, Utc};
use serde_json::Value;

pub(super) fn time(value: &Value, field: &str) -> Option<DateTime<Utc>> {
    value[field].as_str()?.parse().ok()
}

fn nodes(status: &Value) -> impl Iterator<Item = &Value> {
    status["nodes"]
        .as_object()
        .into_iter()
        .flat_map(|ns| ns.values())
}
fn parameter<'a>(n: &'a Value, io: &str, key: &str) -> Option<&'a str> {
    n[io]["parameters"]
        .as_array()?
        .iter()
        .find(|p| p["name"] == key)?["value"]
        .as_str()
}
fn template(n: &Value) -> Option<&str> {
    n["templateName"]
        .as_str()
        .or_else(|| n["templateRef"]["template"].as_str())
}
pub(super) fn suspend<'a>(status: &'a Value, row: &StageRow) -> Option<&'a Value> {
    let attempt = row.attempt.to_string();
    let mut active = nodes(status).filter(|n| {
        n["type"] == "Suspend"
            && n["phase"] == "Running"
            && template(n) == Some("wait-stage")
            && parameter(n, "inputs", "stage") == Some(row.stage.as_str())
            && parameter(n, "inputs", "attempt") == Some(attempt.as_str())
    });
    let first = active.next()?;
    active.next().is_none().then_some(first)
}
pub(super) fn selector(node: &Value, row: &StageRow) -> anyhow::Result<String> {
    let name = node["name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("suspended node has no name"))?;
    match parameter(node, "inputs", "admission_sync_id") {
        Some(uid) if uid == row.sync_id => Ok(format!(
            "name={name},inputs.parameters.admission_sync_id.value={uid}"
        )),
        Some(_) => anyhow::bail!("suspend belongs to a different Workflow UID"),
        None => Ok(format!("name={name}")),
    }
}

pub(super) fn work<'a>(status: &'a Value, row: &StageRow) -> Option<&'a Value> {
    nodes(status)
        .filter(|n| {
            n["type"] == "Pod"
                && matches!(
                    n["templateRef"]["name"].as_str(),
                    Some("dbt-run" | "connector-checks" | "identity-seed-run")
                )
                && (parameter(n, "inputs", "admission_stage") == Some(row.stage.as_str())
                    || n["displayName"].as_str().and_then(|v| v.split('(').next())
                        == Some(row.stage.as_str()))
                && parameter(n, "inputs", "attempt")
                    .is_none_or(|s| s.parse::<u32>() == Ok(row.attempt))
        })
        .max_by_key(|n| time(n, "startedAt"))
}
pub(super) fn trigger<'a>(status: &'a Value, row: &StageRow) -> Option<&'a Value> {
    let attempt = row.attempt.to_string();
    nodes(status)
        .filter(|n| {
            n["type"] == "Pod"
                && template(n) == Some("trigger-sync")
                && parameter(n, "inputs", "attempt") == Some(attempt.as_str())
                && parameter(n, "inputs", "connection_id") == row.connection_id.as_deref()
        })
        .max_by_key(|n| time(n, "startedAt"))
}

fn empty_failed_attempts(proof: &Value) -> bool {
    let Some(attempts) = proof["attempts"].as_array() else {
        return false;
    };
    !attempts.is_empty()
        && attempts.iter().enumerate().all(|(index, a)| {
            a["attempt_id"].as_u64() == u64::try_from(index).ok()
                && a["status"] == "failed"
                && a["ended_at"].as_u64().is_some()
                && a["records_emitted"].as_u64() == Some(0)
                && a["records_committed"].as_u64() == Some(0)
                && a["partial_success"] == false
        })
}

pub(super) fn job_finished(poll: &Value, id: &str) -> Option<DateTime<Utc>> {
    let proof: Value =
        serde_json::from_str(parameter(poll, "outputs", "airbyte-evidence")?).ok()?;
    if proof["job_id"].as_u64()?.to_string() != id {
        return None;
    }
    let attempts = proof["attempts"].as_array()?;
    let ended = attempts
        .iter()
        .map(|a| a["ended_at"].as_i64())
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .max()?;
    DateTime::from_timestamp(ended, 0).filter(|t| *t <= Utc::now())
}

pub(super) fn bronze<'a>(
    status: &'a Value,
    row: &StageRow,
    o: &mut Observation,
) -> (Option<&'a Value>, Option<String>) {
    let trigger = trigger(status, row);
    let id = trigger
        .and_then(|n| n["outputs"]["result"].as_str())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|id| id.to_string());
    if row.airbyte_job_id.is_none() && row.airbyte_claimed && id.is_some() {
        o.airbyte_job_id = id;
    }
    let Some(id) = row.airbyte_job_id.as_ref().or(o.airbyte_job_id.as_ref()) else {
        return (None, None);
    };
    let poll = nodes(status)
        .filter(|n| {
            n["type"] == "Pod"
                && template(n) == Some("poll-job")
                && parameter(n, "inputs", "job_id") == Some(id.as_str())
                && parameter(n, "inputs", "attempt").and_then(|s| s.parse::<u32>().ok())
                    == Some(row.attempt)
        })
        .max_by_key(|n| time(n, "startedAt"));
    let proof = poll
        .and_then(|n| parameter(n, "outputs", "airbyte-evidence"))
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| v["job_id"].as_u64().map(|n| n.to_string()).as_ref() == Some(id));
    if let Some(v) = proof {
        o.bronze_replay_safe = Some(v["status"] == "failed" && empty_failed_attempts(&v));
        o.records_reported = v["records_reported"].as_u64();
        o.volume_bytes = v["volume_bytes"].as_u64();
        return (poll, v["status"].as_str().map(str::to_owned));
    }
    (poll, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> StageRow {
        StageRow {
            id: 1,
            sync_id: "uid".into(),
            workflow_name: "jira".into(),
            connector: "jira".into(),
            source_id: "east".into(),
            stage: "bronze".into(),
            attempt: 2,
            status: "queued".into(),
            reason: None,
            decision: "queued".into(),
            estimated_bytes: 1,
            cold: false,
            queued_at: Utc::now(),
            started_at: None,
            finished_at: None,
            granted_at: None,
            airbyte_job_id: None,
            connection_id: Some("conn".into()),
            airbyte_claimed: true,
        }
    }

    #[test]
    fn resumes_only_one_matching_suspended_attempt() {
        let gate = |name: &str, stage: &str, attempt: &str| json!({"name":name,"templateName":"wait-stage","type":"Suspend","phase":"Running","inputs":{"parameters":[{"name":"stage","value":stage},{"name":"attempt","value":attempt}]}});
        let mut status = json!({"nodes":{"a":gate("first","bronze","1"),"b":gate("other","transform-staging","2"),"c":gate("target","bronze","2")}});
        assert_eq!(
            suspend(&status, &row()).and_then(|n| n["name"].as_str()),
            Some("target")
        );
        status["nodes"]["d"] = gate("ambiguous", "bronze", "2");
        assert_eq!(suspend(&status, &row()), None);
    }

    #[test]
    fn job_receipt_belongs_to_the_original_attempt() {
        let node = |id: &str, attempt: &str| json!({"type":"Pod","templateName":"trigger-sync","outputs":{"result":id},"inputs":{"parameters":[{"name":"connection_id","value":"conn"},{"name":"attempt","value":attempt}]}});
        let status = json!({"nodes":{"a":node("900","1"),"b":node("901","2")}});
        let mut observed = Observation::default();
        bronze(&status, &row(), &mut observed);
        assert_eq!(observed.airbyte_job_id.as_deref(), Some("901"));
    }

    #[test]
    fn retry_requires_complete_zero_write_evidence_from_every_native_attempt() {
        let attempt = |id: u64| json!({"attempt_id":id,"status":"failed","ended_at":1000,"records_emitted":0,"records_committed":0,"partial_success":false});
        let mut proof = json!({"attempts":[attempt(0),attempt(1)]});
        assert!(empty_failed_attempts(&proof));
        proof["attempts"][0]["records_committed"] = json!(1);
        assert!(!empty_failed_attempts(&proof));
        proof["attempts"][0]["records_committed"] = Value::Null;
        assert!(!empty_failed_attempts(&proof));
        assert!(!empty_failed_attempts(&json!({"attempts":[attempt(1)]})));
        assert!(!empty_failed_attempts(&json!({})));
    }
}
