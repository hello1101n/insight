use axum::http::StatusCode;
use serde_json::{Value, json};

use super::{Harness, MEMBER, OWNER, STRANGER, UNKNOWN, VIEWER, field_of};
use crate::domain::definition::DefinitionId;
use crate::domain::sharing::{Grants as _, Shared};

async fn metric_of(harness: &Harness, owner: &str) -> String {
    harness
        .made(
            owner,
            "metrics",
            "Commit count",
            json!({
                "dataset": "commits",
                "fields": [{ "agg": "count", "type": "int", "as_name": "total" }]
            }),
        )
        .await
}

async fn listed(harness: &Harness, caller: &str, metric: &str) -> Vec<Value> {
    let answer = harness
        .send(caller, "GET", &format!("/v1/metrics/{metric}/grants"), None)
        .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);

    answer.body["items"].as_array().cloned().unwrap_or_default()
}

#[tokio::test]
async fn an_admin_shares_a_metric_with_a_person() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;

    let to_person = harness
        .grant(OWNER, "metrics", &metric, MEMBER, "viewer")
        .await;
    let to_everyone = harness
        .grant(OWNER, "metrics", &metric, "everyone", "viewer")
        .await;
    let again = harness
        .grant(STRANGER, "metrics", &metric, MEMBER, "viewer")
        .await;

    for answer in [&to_person, &to_everyone, &again] {
        assert_eq!(answer.status, StatusCode::NO_CONTENT, "{}", answer.body);
    }
    let items = listed(&harness, VIEWER, &metric).await;
    assert_eq!(items.len(), 2, "{items:?}");
    let person = items
        .iter()
        .find(|item| item["grantee"] == json!(MEMBER))
        .unwrap_or_else(|| panic!("the person grant is listed: {items:?}"));
    assert_eq!(person["level"], json!("viewer"));
    assert_eq!(person["granted_by"], json!(OWNER));
    assert!(person["created_at"].is_string(), "{person}");
    assert!(
        items
            .iter()
            .any(|item| item["grantee"] == json!("everyone"))
    );
}

#[tokio::test]
async fn an_admin_withdraws_a_metric_grant() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;
    harness
        .grant(OWNER, "metrics", &metric, MEMBER, "viewer")
        .await;

    let withdrawn = harness
        .send(
            OWNER,
            "DELETE",
            &format!("/v1/metrics/{metric}/grants/{MEMBER}"),
            None,
        )
        .await;

    assert_eq!(
        withdrawn.status,
        StatusCode::NO_CONTENT,
        "{}",
        withdrawn.body
    );
    assert!(listed(&harness, OWNER, &metric).await.is_empty());
}

#[tokio::test]
async fn a_member_cannot_share_a_metric() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;
    harness
        .grant(OWNER, "metrics", &metric, MEMBER, "viewer")
        .await;

    let put = harness
        .grant(MEMBER, "metrics", &metric, STRANGER, "viewer")
        .await;
    let delete = harness
        .send(
            MEMBER,
            "DELETE",
            &format!("/v1/metrics/{metric}/grants/{MEMBER}"),
            None,
        )
        .await;
    let list = harness
        .send(MEMBER, "GET", &format!("/v1/metrics/{metric}/grants"), None)
        .await;

    for answer in [&put, &delete, &list] {
        assert_eq!(answer.status, StatusCode::FORBIDDEN, "{}", answer.body);
    }
    assert_eq!(listed(&harness, OWNER, &metric).await.len(), 1);
}

#[tokio::test]
async fn a_metric_grant_refuses_editor() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;

    let refused = harness
        .grant(OWNER, "metrics", &metric, MEMBER, "editor")
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("level"));
    assert!(listed(&harness, OWNER, &metric).await.is_empty());
}

#[tokio::test]
async fn a_metric_grant_to_an_unknown_person_is_refused_on_grantee() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;

    let refused = harness
        .grant(OWNER, "metrics", &metric, UNKNOWN, "viewer")
        .await;

    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(field_of(&refused), json!("grantee"));
}

#[tokio::test]
async fn sharing_a_missing_metric_is_not_found() {
    let harness = Harness::new();

    let put = harness
        .grant(OWNER, "metrics", "no-such-metric", MEMBER, "viewer")
        .await;
    let delete = harness
        .send(
            OWNER,
            "DELETE",
            &format!("/v1/metrics/no-such-metric/grants/{MEMBER}"),
            None,
        )
        .await;
    let list = harness
        .send(OWNER, "GET", "/v1/metrics/no-such-metric/grants", None)
        .await;

    for answer in [&put, &delete, &list] {
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{}", answer.body);
    }
}

#[tokio::test]
async fn metrics_have_no_orphaned_or_transfer_routes() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;

    let orphaned = harness
        .send(OWNER, "GET", "/v1/orphaned-metrics", None)
        .await;
    let transfer = harness
        .send(
            OWNER,
            "POST",
            &format!("/v1/metrics/{metric}/transfer"),
            Some(json!({ "to": VIEWER })),
        )
        .await;

    assert_eq!(orphaned.status, StatusCode::NOT_FOUND);
    assert_eq!(transfer.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_a_metric_removes_its_grants() {
    let harness = Harness::new();
    let metric = metric_of(&harness, OWNER).await;
    harness
        .grant(OWNER, "metrics", &metric, MEMBER, "viewer")
        .await;

    let deleted = harness
        .send(OWNER, "DELETE", &format!("/v1/metrics/{metric}"), None)
        .await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);
    let id = DefinitionId::parse(&metric).unwrap_or_else(|error| panic!("{error}"));
    let left = harness
        .definitions
        .grants_of(Shared::Metric(&id))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(left.is_empty(), "{left:?}");
}
