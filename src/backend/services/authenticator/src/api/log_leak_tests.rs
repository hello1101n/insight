use insight_log_context::test_support::capture_output;

use crate::config::{HostIdpConfig, IdpConfig};
use crate::session::{LoginState, SessionRecord};
use crate::sql_tokens::http_tests::{
    ADMIN, KNOWN_PERSON, KNOWN_PERSON_EMAIL, KNOWN_PERSON_NAME, R, StubSpec, app, body_json,
    env_or_skip, request, spawn_identity,
};

const SEEDED_ID_TOKEN: &str = "seeded-id-token-3192";
const SEEDED_REFRESH_TOKEN: &str = "seeded-refresh-token-3192";
const SEEDED_COOKIE_CREDENTIAL: &str = "seeded-cookie-credential-3192";
const SEEDED_CSRF_TOKEN: &str = "seeded-csrf-token-3192";
const SEEDED_EMAIL: &str = "seeded.person-3192@example.com";
const SEEDED_CLIENT_SECRET: &str = "seeded-client-secret-3192";
const SEEDED_PKCE_VERIFIER: &str = "seeded-pkce-verifier-3192";
const SEEDED_NONCE: &str = "seeded-nonce-3192";

fn seeded_session_record() -> SessionRecord {
    SessionRecord {
        person_id: "0e0e0e0e-3192-0000-0000-000000000001".to_owned(),
        email: SEEDED_EMAIL.to_owned(),
        tenant_id: "0e0e0e0e-3192-0000-0000-000000000002".to_owned(),
        roles: vec!["member".to_owned()],
        idp_iss: "https://idp.example.com/realms/seeded".to_owned(),
        idp_sub: "seeded-sub".to_owned(),
        idp_sid: Some("seeded-sid".to_owned()),
        id_token: SEEDED_ID_TOKEN.to_owned(),
        idp_refresh_token: Some(SEEDED_REFRESH_TOKEN.to_owned()),
        idp_access_expires_at: Some(1),
        created_at: 1,
        expires_at: 2,
        absolute_expires_at: 3,
        user_agent: "seeded-agent/1.0".to_owned(),
        ip: "192.0.2.1".to_owned(),
        csrf_token: SEEDED_CSRF_TOKEN.to_owned(),
        current_token: SEEDED_COOKIE_CREDENTIAL.to_owned(),
        impersonator_person_id: String::new(),
        impersonator_email: SEEDED_EMAIL.to_owned(),
    }
}

#[test]
fn a_logged_session_record_renders_markers_never_the_credentials() {
    let record = seeded_session_record();

    let output = capture_output(|| tracing::error!(record = ?record, "seeded leak probe"));

    for seeded in [
        SEEDED_ID_TOKEN,
        SEEDED_REFRESH_TOKEN,
        SEEDED_COOKIE_CREDENTIAL,
        SEEDED_CSRF_TOKEN,
        SEEDED_EMAIL,
    ] {
        assert!(!output.contains(seeded), "leaked: {seeded} in {output}");
    }
    assert!(output.contains("<redacted>"), "no marker in {output}");
    assert!(output.contains(&record.person_id), "person_id must survive");
}

#[test]
fn a_logged_login_state_renders_markers_never_the_secrets() {
    let state = LoginState {
        pkce_verifier: SEEDED_PKCE_VERIFIER.to_owned(),
        nonce: SEEDED_NONCE.to_owned(),
        return_to: "/dashboard".to_owned(),
        issuer: "https://idp.example.com/realms/seeded".to_owned(),
        override_email: SEEDED_EMAIL.to_owned(),
    };

    let output = capture_output(|| tracing::warn!(state = ?state, "seeded leak probe"));

    for seeded in [SEEDED_PKCE_VERIFIER, SEEDED_NONCE, SEEDED_EMAIL] {
        assert!(!output.contains(seeded), "leaked: {seeded} in {output}");
    }
    assert!(output.contains("<redacted>"), "no marker in {output}");
}

#[test]
fn a_logged_idp_config_renders_a_marker_never_the_client_secret() {
    let hosts = std::collections::HashMap::from([(
        "app.example.com".to_owned(),
        HostIdpConfig {
            client_secret: SEEDED_CLIENT_SECRET.to_owned(),
            ..HostIdpConfig::default()
        },
    )]);
    let config = IdpConfig {
        client_secret: SEEDED_CLIENT_SECRET.to_owned(),
        hosts,
        ..IdpConfig::default()
    };

    let output = capture_output(|| tracing::info!(config = ?config, "seeded leak probe"));

    assert!(
        !output.contains(SEEDED_CLIENT_SECRET),
        "leaked: client_secret in {output}"
    );
    assert!(output.contains("<redacted>"), "no marker in {output}");
}

#[test]
#[ignore = "requires MariaDB and Redis; set INTEGRATION_TESTS_MARIADB_URL and INTEGRATION_TESTS_REDIS_URL"]
fn the_sql_token_routes_log_neither_the_token_nor_the_label_nor_a_name() -> R {
    const SEEDED_LABEL: &str = "seeded-label-3192";

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut outcome: R = Ok(());
    let mut token = String::new();
    let mut ran = false;

    let output = capture_output(|| {
        outcome = runtime.block_on(async {
            let Some(env) = env_or_skip().await else {
                return Ok(());
            };
            ran = true;
            let identity = spawn_identity(StubSpec::default()).await?;
            let app = app(
                &env.redis_url,
                &identity,
                Some(env.db.clone()),
                uuid::Uuid::now_v7(),
            )
            .await?;

            let created = body_json(
                tower::ServiceExt::oneshot(
                    app.clone(),
                    request(
                        "POST",
                        "/v1/sql-tokens",
                        Some(&serde_json::json!({
                            "person_id": KNOWN_PERSON.to_string(),
                            "label": SEEDED_LABEL,
                        })),
                    )?,
                )
                .await?,
            )
            .await?;
            token = created["token"].as_str().unwrap_or_default().to_owned();
            let token_id = created["token_id"].as_str().unwrap_or_default().to_owned();

            tower::ServiceExt::oneshot(app.clone(), request("GET", "/v1/sql-tokens", None)?)
                .await?;
            tower::ServiceExt::oneshot(
                app,
                request("DELETE", &format!("/v1/sql-tokens/{token_id}"), None)?,
            )
            .await?;
            Ok(())
        });
    });
    outcome?;

    if !ran {
        return Ok(());
    }
    assert!(token.starts_with("isql_"), "no token was created");
    for seeded in [
        token.as_str(),
        SEEDED_LABEL,
        KNOWN_PERSON_NAME,
        KNOWN_PERSON_EMAIL,
    ] {
        assert!(!output.contains(seeded), "leaked: {seeded} in {output}");
    }
    assert!(
        output.contains(&KNOWN_PERSON.to_string()) && output.contains(&ADMIN.to_string()),
        "the audit lines must name the holder and the admin by id: {output}"
    );
    Ok(())
}
