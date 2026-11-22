use std::net::SocketAddr;

use axum::Router;
use secrecy::ExposeSecret as _;
use tokio_util::sync::CancellationToken;

use crate::config::{McpConfig, SqlApiConfig};
use crate::jwt_verifier::{JwksVerifier, resolve_jwks_url};

mod api;
pub(crate) mod executor;

#[cfg(test)]
mod tests;

pub(crate) fn validate_config(mcp: &McpConfig, api: &SqlApiConfig) -> anyhow::Result<()> {
    if !mcp.enabled && !api.enabled {
        return Ok(());
    }
    mcp.bind_addr.parse::<SocketAddr>()?;
    if mcp.enabled {
        crate::mcp::validate_public_url(&mcp.public_url, mcp.allow_insecure_private_network)?;
    }
    anyhow::ensure!(
        mcp.max_concurrent_queries > 0,
        "SQL explorer concurrency must be positive"
    );
    anyhow::ensure!(
        !mcp.clickhouse_user.trim().is_empty(),
        "SQL explorer ClickHouse user is empty"
    );
    anyhow::ensure!(
        !mcp.clickhouse_password.expose_secret().is_empty(),
        "SQL explorer ClickHouse password is empty"
    );
    if api.enabled {
        let token = api.token.expose_secret();
        anyhow::ensure!(
            token.len() >= 32 && token.len() <= 1024 && token.bytes().all(|b| b.is_ascii_graphic()),
            "SQL API token must contain 32 to 1024 printable ASCII characters without whitespace"
        );
        anyhow::ensure!(
            !api.jwt_issuer.trim().is_empty(),
            "SQL API JWT issuer is empty"
        );
        anyhow::ensure!(
            !api.jwt_audience.trim().is_empty(),
            "SQL API JWT audience is empty"
        );
    }
    Ok(())
}

fn sql_api_jwks_url(mcp: &McpConfig, api: &SqlApiConfig) -> String {
    resolve_jwks_url(&mcp.jwks_url, &api.jwt_issuer)
}

pub(crate) async fn start(
    mcp: &McpConfig,
    api: &SqlApiConfig,
    clickhouse_url: &str,
    clickhouse_database: &str,
    cancellation: CancellationToken,
) -> anyhow::Result<()> {
    validate_config(mcp, api)?;
    if !mcp.enabled && !api.enabled {
        return Ok(());
    }
    let client = insight_clickhouse::Client::new(
        insight_clickhouse::Config::new(clickhouse_url, clickhouse_database)
            .with_auth(
                &mcp.clickhouse_user,
                mcp.clickhouse_password.expose_secret(),
            )
            .without_query_timeout(),
    );
    let executor = executor::QueryExecutor::new(client, mcp.max_concurrent_queries);
    let mut router = Router::new();
    if mcp.enabled {
        router = router.merge(crate::mcp::router(
            mcp,
            executor.clone(),
            cancellation.child_token(),
        )?);
    }
    if api.enabled {
        let verifier = JwksVerifier::new(
            &api.jwt_issuer,
            &api.jwt_audience,
            &sql_api_jwks_url(mcp, api),
        )?;
        router = router.merge(api::router(api, verifier, executor));
    }
    let listener = tokio::net::TcpListener::bind(&mcp.bind_addr).await?;
    tracing::info!(bind_addr = %mcp.bind_addr, "SQL explorer listening");
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(cancellation.cancelled_owned())
            .await
        {
            tracing::error!(%error, "SQL explorer stopped unexpectedly");
        }
    });
    Ok(())
}
