use std::collections::HashSet;

use axum::Router;
use chrono::Utc;
use serde_json::json;
use tokio::{net::TcpSocket, task::JoinSet};
use tokio_util::sync::CancellationToken;
use toolkit::{ClientHub, bootstrap::AppConfig};
use uuid::Uuid;

use super::*;
use crate::domain::admission::{Request, capacity, store};

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn override_allows_gear_init_during_clickhouse_outage_but_requires_a_sample_for_grants()
-> anyhow::Result<()> {
    let socket = TcpSocket::new_v4()?;
    socket.bind("127.0.0.1:0".parse()?)?;
    let clickhouse_url = format!(
        "http://mocked.clickhouse.test:{}",
        socket.local_addr()?.port()
    );
    let override_bytes = 512 * 1024 * 1024_u64;
    let mut app = AppConfig::default();
    app.gears.insert(
        "connectors".into(),
        json!({"config": {
            "database_url": std::env::var("INTEGRATION_TESTS_MARIADB_URL")?,
            "cluster": {"enabled": false},
            "clickhouse_url": clickhouse_url,
            "identity_url": "http://127.0.0.1",
            "admission_budget_override_bytes": override_bytes
        }}),
    );
    run_migrate(&app).await?;
    let ctx = GearCtx::new(
        "connectors",
        Uuid::new_v4(),
        Arc::new(app),
        Arc::new(ClientHub::default()),
        CancellationToken::new(),
    );
    let gear = ConnectorsGear::default();
    let startup = gear.init(&ctx).await;
    assert!(
        startup.is_ok(),
        "gear init must succeed with ClickHouse unreachable: {startup:?}"
    );
    let state = gear
        .state
        .get()
        .ok_or_else(|| anyhow::anyhow!("gear state is missing"))?;

    let id = Uuid::now_v7();
    let stand = id.to_string();
    let request = Request {
        sync_id: id,
        workflow_name: format!("test-{id}"),
        custom_selection: false,
        bronze_volume: None,
        mode_signature: Some("a".repeat(64)),
        connector: "jira".into(),
        source_id: "fixture".into(),
        stage: "bronze".into(),
        attempt: 1,
        connection_id: Some(Uuid::new_v4().to_string()),
    };
    let failed_sample = capacity::sample(state).await;
    assert!(failed_sample.is_err());
    let (_, reply) = store::register(
        &state.db,
        &stand,
        "tenant",
        &request,
        Utc::now(),
        failed_sample.unwrap_or_default(),
    )
    .await?;
    assert_eq!(reply.decision, "queued");
    let row = store::unfinished(&state.db, &stand).await?.remove(0);

    let listener = socket.listen(16)?;
    let warehouse = Router::new().fallback(move || async move {
        let mut row = b"\x01a".to_vec();
        for number in [2 * override_bytes, 2 * override_bytes, 0, 0, 50, 0, 0] {
            row.extend(number.to_le_bytes());
        }
        row.push(1);
        row
    });
    let mut servers = JoinSet::new();
    servers.spawn(async move { axum::serve(listener, warehouse).await });
    let budget = capacity::sample(state).await?;
    assert_eq!(budget, override_bytes);
    assert_eq!(
        store::promote_ready(&state.db, &stand, &HashSet::from([row.id]), budget).await?,
        [row.id]
    );
    Ok(())
}
