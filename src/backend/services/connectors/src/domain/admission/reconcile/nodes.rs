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
pub(super) fn legacy_uid_inputs(node: &Value, row: &StageRow) -> Option<Vec<Value>> {
    if selector(node, row).is_ok()
        || parameter(node, "inputs", "stage") != Some(row.stage.as_str())
        || parameter(node, "inputs", "attempt") != Some(row.attempt.to_string().as_str())
        || node["type"] != "Suspend"
        || node["phase"] != "Running"
        || template(node) != Some("wait-stage")
    {
        return None;
    }
    let mut inputs = node["inputs"]["parameters"].as_array()?.clone();
    inputs.retain(|p| p["name"] != "admission_sync_id");
    inputs.push(serde_json::json!({"name":"admission_sync_id","value":row.sync_id}));
    Some(inputs)
}

pub(super) fn selector(node: &Value, row: &StageRow) -> anyhow::Result<String> {
    let name = node["name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("suspended node has no name"))?;
    let mut uids = node["inputs"]["parameters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["name"] == "admission_sync_id");
    let uid = uids.next().and_then(|p| p["value"].as_str());
    anyhow::ensure!(
        uid == Some(row.sync_id.as_str()) && uids.next().is_none(),
        "suspend has no unique matching Workflow UID"
    );
    Ok(format!(
        "name={name},inputs.parameters.admission_sync_id.value={}",
        row.sync_id
    ))
}

pub(super) const WAIT_TIMEOUT_MESSAGE: &str =
    "Insight stage exceeded six hours waiting for admission";

pub(super) fn stopped_gate<'a>(status: &'a Value, row: &StageRow) -> Option<&'a Value> {
    nodes(status).find(|n| {
        n["type"] == "Suspend"
            && template(n) == Some("wait-stage")
            && n["phase"] == "Failed"
            && n["message"] == WAIT_TIMEOUT_MESSAGE
            && parameter(n, "inputs", "stage") == Some(row.stage.as_str())
            && parameter(n, "inputs", "attempt") == Some(row.attempt.to_string().as_str())
            && selector(n, row).is_ok()
    })
}

pub(super) fn confirmed_action(
    status: &Value,
    original: &Value,
    row: &StageRow,
    action: &str,
) -> bool {
    let Some(id) = original["id"].as_str() else {
        return false;
    };
    let current = &status["nodes"][id];
    current["id"] == id
        && current["name"] == original["name"]
        && parameter(current, "inputs", "stage") == Some(row.stage.as_str())
        && parameter(current, "inputs", "attempt") == Some(row.attempt.to_string().as_str())
        && current["type"] == "Suspend"
        && selector(current, row).is_ok()
        && match action {
            "resume" => current["phase"] == "Succeeded",
            "stop" => current["phase"] == "Failed" && current["message"] == WAIT_TIMEOUT_MESSAGE,
            _ => false,
        }
}

pub(super) fn guarded(node: &Value) -> bool {
    parameter(node, "inputs", "admission_start_guard") == Some("workflow-v1")
}

pub(super) fn quota_wait(node: Option<&Value>) -> bool {
    node.is_some_and(|n| {
        n["phase"] == "Pending"
            && n["message"]
                .as_str()
                .is_some_and(|m| m.contains("is forbidden: exceeded quota:"))
    })
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

pub(crate) fn bronze_volume(status: &Value) -> Option<super::super::BronzeVolume> {
    let mut found = None;
    for node in nodes(status).filter(|n| {
        n["type"] == "Pod" && n["phase"] == "Succeeded" && template(n) == Some("poll-job")
    }) {
        let proof: Value =
            serde_json::from_str(parameter(node, "outputs", "airbyte-evidence")?).ok()?;
        let id = parameter(node, "inputs", "job_id")?.parse::<u64>().ok()?;
        if proof["status"] != "succeeded" {
            continue;
        }
        if id == 0 || proof["job_id"].as_u64() != Some(id) {
            return None;
        }
        let volume = super::super::BronzeVolume {
            job_id: id,
            bytes: proof["volume_bytes"].as_u64()?,
        };
        if found.as_ref().is_some_and(|prior| prior != &volume) {
            return None;
        }
        found = Some(volume);
    }
    found
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
) -> (Option<&'a Value>, Option<super::airbyte::Completion>) {
    let trigger = trigger(status, row);
    if row.airbyte_job_id.is_none() && row.airbyte_claimed {
        let previous = row.airbyte_previous_job.unwrap_or(0);
        let newer = |id: &str| id.trim().parse::<u64>().ok().filter(|n| *n > previous);
        o.airbyte_job_id = trigger
            .and_then(|n| n["outputs"]["result"].as_str())
            .and_then(newer)
            .or_else(|| o.airbyte_job_id.as_deref().and_then(newer))
            .map(|id| id.to_string());
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
        let last = v["attempts"]
            .as_array()
            .and_then(|a| a.iter().max_by_key(|t| t["attempt_id"].as_u64()));
        let receipt = super::airbyte::Completion::observed(
            v["status"].as_str().unwrap_or(""),
            o.records_reported,
            last.and_then(|a| a["records_committed"].as_u64()),
            o.volume_bytes,
            last.and_then(|a| a["ended_at"].as_i64()),
        );
        return (poll, receipt);
    }
    (poll, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn volume_requires_a_successful_poll_for_one_exact_job() {
        let poll = |id, bytes, phase| {
            json!({"type":"Pod","templateName":"poll-job","phase":phase,
            "inputs":{"parameters":[{"name":"job_id","value":format!("{id}")}]},
            "outputs":{"parameters":[{"name":"airbyte-evidence","value":json!({"status":"succeeded","job_id":id,"volume_bytes":bytes}).to_string()}]}})
        };
        let mut status = json!({"nodes":{"a":poll(42,0,"Succeeded"),"b":poll(41,78,"Failed")}});
        assert_eq!(
            bronze_volume(&status).map(|v| (v.job_id, v.bytes)),
            Some((42, 0))
        );
        status["nodes"]["b"] = poll(41, 78, "Succeeded");
        assert_eq!(bronze_volume(&status), None);
        status["nodes"]["b"] = poll(42, 0, "Succeeded");
        status["nodes"]["a"]["inputs"]["parameters"][0]["value"] = json!("999");
        assert_eq!(bronze_volume(&status), None);
    }

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
            airbyte_claimed_at: None,
            airbyte_previous_job: None,
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
    fn legacy_wait_requires_uid_upgrade_before_an_exact_resume() -> anyhow::Result<()> {
        let mut n = json!({"name":"wf.wait","id":"w","type":"Suspend","phase":"Running","templateName":"wait-stage",
                           "inputs":{"parameters":[{"name":"stage","value":"bronze"},{"name":"attempt","value":"2"}]}});
        assert!(selector(&n, &row()).is_err());
        n["inputs"]["parameters"] = json!(
            legacy_uid_inputs(&n, &row()).ok_or_else(|| anyhow::anyhow!("missing UID upgrade"))?
        );
        assert_eq!(
            selector(&n, &row())?,
            "name=wf.wait,inputs.parameters.admission_sync_id.value=uid"
        );
        assert!(legacy_uid_inputs(&n, &row()).is_none());
        for wrong in [json!("replacement"), json!(""), Value::Null] {
            let mut malformed = n.clone();
            malformed["inputs"]["parameters"][2]["value"] = wrong;
            assert!(selector(&malformed, &row()).is_err());
            assert_eq!(
                json!(legacy_uid_inputs(&malformed, &row())),
                n["inputs"]["parameters"]
            );
        }
        let mut duplicate = n.clone();
        if let Some(inputs) = duplicate["inputs"]["parameters"].as_array_mut() {
            inputs.push(json!({"name":"admission_sync_id","value":"replacement"}));
        }
        assert!(selector(&duplicate, &row()).is_err());
        assert_eq!(
            json!(legacy_uid_inputs(&duplicate, &row())),
            n["inputs"]["parameters"]
        );
        Ok(())
    }

    #[test]
    fn duplicate_reply_requires_the_exact_finished_suspend() {
        let n = json!({"name":"wf.wait","id":"w","type":"Suspend","phase":"Running","templateName":"wait-stage",
                    "inputs":{"parameters":[{"name":"stage","value":"bronze"},{"name":"attempt","value":"2"},{"name":"admission_sync_id","value":"uid"}]}});
        let mut status = json!({"nodes":{"w":n,"other":n}});
        status["nodes"]["other"]["phase"] = json!("Succeeded");
        assert!(!confirmed_action(&status, &n, &row(), "resume"));
        status["nodes"]["w"]["phase"] = json!("Succeeded");
        assert!(confirmed_action(&status, &n, &row(), "resume"));
        assert!(!confirmed_action(&status, &n, &row(), "stop"));
        let mut stopped = status.clone();
        stopped["nodes"]["w"]["phase"] = json!("Failed");
        stopped["nodes"]["w"]["message"] = json!("stopped manually");
        assert!(stopped_gate(&stopped, &row()).is_none());
        stopped["nodes"]["w"]["message"] = json!(WAIT_TIMEOUT_MESSAGE);
        assert!(stopped_gate(&stopped, &row()).is_some());
        assert!(confirmed_action(&stopped, &n, &row(), "stop"));
        for (i, wrong) in [(0, "another-stage"), (1, "1"), (2, "replacement")] {
            let mut wrong_status = status.clone();
            wrong_status["nodes"]["w"]["inputs"]["parameters"][i]["value"] = json!(wrong);
            assert!(!confirmed_action(&wrong_status, &n, &row(), "resume"));
        }
    }

    #[test]
    fn job_receipt_belongs_to_the_original_attempt() {
        let node = |id: &str, attempt: &str| json!({"type":"Pod","templateName":"trigger-sync","outputs":{"result":id},"inputs":{"parameters":[{"name":"connection_id","value":"conn"},{"name":"attempt","value":attempt}]}});
        let status = json!({"nodes":{"a":node("900","1"),"b":node("901","2")}});
        let mut observed = Observation::default();
        bronze(&status, &row(), &mut observed);
        assert_eq!(observed.airbyte_job_id.as_deref(), Some("901"));
        let mut current = row();
        current.airbyte_previous_job = Some(901);
        bronze(&status, &current, &mut observed);
        assert!(observed.airbyte_job_id.is_none());
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
