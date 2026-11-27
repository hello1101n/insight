use axum::http::StatusCode;
use sea_orm::{DbBackend, MockDatabase};
use serde_json::json;
use tower::ServiceExt;

use super::support::{R, body, context, harness, request};

#[tokio::test]
async fn resource_patch_rejects_out_of_range_values_and_unknown_fields() -> R {
    let fixture = harness(
        MockDatabase::new(DbBackend::MySql).into_connection(),
        "http://127.0.0.1:1",
        context("user", &[])?,
        true,
    )
    .await?;
    for (patch, field) in [
        (json!({"dbt_cpu_millis": 0}), "dbt_cpu_millis"),
        (
            json!({"dbt_query_memory_bytes": 1}),
            "dbt_query_memory_bytes",
        ),
        (json!({"dbt_memory_bytes": 1u64 << 53}), "dbt_memory_bytes"),
        (json!({"dbt_cpu": 1}), "body"),
    ] {
        let response = fixture
            .app
            .clone()
            .oneshot(request(
                "PATCH",
                "/v1/connectors/example-tracker/main/schedule",
                Some("\"0\""),
                &patch,
            )?)
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{patch}");
        let violation = body(response).await?;
        assert_eq!(
            violation["context"]["field_violations"][0]["field"], field,
            "{patch}"
        );
    }
    Ok(())
}
