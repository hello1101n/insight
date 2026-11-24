use super::*;

#[test]
fn the_admin_role_id_matches_the_identity_services_own_constant() {
    assert_eq!(
        ADMIN_ROLE_ID.to_string(),
        "a4d11000-0000-4000-8000-000000000001"
    );
}

#[test]
fn a_trailing_slash_does_not_double_up_in_the_path() {
    let client = IdentityClient::new("http://identity-resolution:8082/")
        .unwrap_or_else(|error| panic!("the client builds: {error}"));

    let Mode::Live { base_url, .. } = &client.mode else {
        panic!("a configured client is live");
    };
    assert_eq!(base_url, "http://identity-resolution:8082");
    assert!(client.is_configured());
}

#[test]
fn identity_refusing_the_caller_is_told_apart_from_identity_failing() {
    assert!(IdentityError::Refused(401).is_about_the_caller());
    assert!(IdentityError::Refused(403).is_about_the_caller());
    assert!(!IdentityError::Refused(500).is_about_the_caller());
    assert!(!IdentityError::Refused(502).is_about_the_caller());
}

#[test]
fn an_unset_url_is_not_configured() {
    let client =
        IdentityClient::new("").unwrap_or_else(|error| panic!("the client builds: {error}"));

    assert!(!client.is_configured());
}

#[test]
fn the_roles_a_caller_holds_decide() {
    let admin: MeResponse = serde_json::from_value(serde_json::json!({
        "person_id": "00000000-0000-4000-8000-000000000001",
        "roles": [{ "role_id": "a4d11000-0000-4000-8000-000000000001" }]
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"));
    let other: MeResponse = serde_json::from_value(serde_json::json!({
        "person_id": "00000000-0000-4000-8000-000000000002",
        "roles": [{ "role_id": "00000000-0000-4000-8000-000000000009" }]
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"));

    assert!(admin.roles.iter().any(|role| role.role_id == ADMIN_ROLE_ID));
    assert!(!other.roles.iter().any(|role| role.role_id == ADMIN_ROLE_ID));
}

fn assignments(count: usize, person: u128) -> AssignmentList {
    AssignmentList {
        items: (0..count)
            .map(|_| Assignment {
                person_id: Uuid::from_u128(person),
            })
            .collect(),
    }
}

#[test]
fn a_listing_of_administrators_names_each_person_once() {
    let listed: AssignmentList = serde_json::from_value(serde_json::json!({
        "items": [
            { "person_id": "00000000-0000-4000-8000-000000000002", "role_id": "a4d11000-0000-4000-8000-000000000001" },
            { "person_id": "00000000-0000-4000-8000-000000000001", "role_id": "a4d11000-0000-4000-8000-000000000001" },
            { "person_id": "00000000-0000-4000-8000-000000000002", "role_id": "a4d11000-0000-4000-8000-000000000001" }
        ],
        "next_cursor": null
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"));

    let people = administrators_in(&listed).unwrap_or_else(|error| panic!("{error}"));

    assert_eq!(people.len(), 2, "{people:?}");
}

#[test]
fn a_full_page_of_administrators_is_refused_as_possibly_cut_short() {
    let cases = [
        (ASSIGNMENTS_PAGE - 1, false),
        (ASSIGNMENTS_PAGE, true),
        (0, false),
    ];

    for (count, refused) in cases {
        let answered = administrators_in(&assignments(count, 7));

        assert_eq!(
            matches!(answered, Err(IdentityError::Truncated)),
            refused,
            "for {count} assignments: {answered:?}"
        );
    }
}

#[test]
fn a_cut_short_listing_is_ours_to_fix_not_the_callers() {
    assert!(!IdentityError::Truncated.is_about_the_caller());
}

use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use reqwest::header::HeaderValue;

#[derive(Debug, Default)]
struct Seen {
    calls: usize,
    authorization: Option<String>,
    asked: Vec<Uuid>,
}

async fn stub_identity(
    answer: StatusCode,
    visible: Vec<Uuid>,
) -> (IdentityClient, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let app = axum::Router::new()
        .route(
            "/v1/visible-persons",
            post(
                move |State(seen): State<Arc<Mutex<Seen>>>,
                      headers: HeaderMap,
                      Json(body): Json<serde_json::Value>| {
                    let visible = visible.clone();
                    async move {
                        let mut seen = seen.lock().unwrap_or_else(|error| panic!("{error}"));
                        seen.calls += 1;
                        seen.authorization = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        seen.asked = body["person_ids"]
                            .as_array()
                            .map(|ids| {
                                ids.iter()
                                    .filter_map(|id| id.as_str().and_then(|id| id.parse().ok()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        (answer, Json(serde_json::json!({ "visible": visible })))
                    }
                },
            ),
        )
        .with_state(Arc::clone(&seen));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|error| panic!("the stub binds: {error}"));
    let address = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("the stub has an address: {error}"));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let client = IdentityClient::new(&format!("http://{address}"))
        .unwrap_or_else(|error| panic!("the client builds: {error}"));

    (client, seen)
}

fn person(number: u128) -> PersonId {
    PersonId::new(Uuid::from_u128(number))
}

#[tokio::test]
async fn visible_returns_only_the_ids_identity_returns() {
    let (client, seen) = stub_identity(StatusCode::OK, vec![Uuid::from_u128(2)]).await;
    let authorization = HeaderValue::from_static("Bearer synthetic-token");

    let visible = client
        .visible(&authorization, &[person(1), person(2), person(3)])
        .await
        .unwrap_or_else(|error| panic!("{error}"));

    assert_eq!(visible, HashSet::from([person(2)]));
    let seen = seen.lock().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        seen.authorization.as_deref(),
        Some("Bearer synthetic-token")
    );
    assert_eq!(
        seen.asked,
        vec![Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3)]
    );
}

#[tokio::test]
async fn visible_asks_nothing_when_given_no_ids() {
    let (client, seen) = stub_identity(StatusCode::OK, vec![Uuid::from_u128(1)]).await;
    let authorization = HeaderValue::from_static("Bearer synthetic-token");

    let visible = client
        .visible(&authorization, &[])
        .await
        .unwrap_or_else(|error| panic!("{error}"));

    assert!(visible.is_empty());
    assert_eq!(
        seen.lock().unwrap_or_else(|error| panic!("{error}")).calls,
        0
    );
}

#[tokio::test]
async fn visible_fails_rather_than_hide_everyone_when_identity_refuses() {
    let (client, _seen) = stub_identity(StatusCode::SERVICE_UNAVAILABLE, Vec::new()).await;
    let authorization = HeaderValue::from_static("Bearer synthetic-token");

    let result = client.visible(&authorization, &[person(1)]).await;

    assert!(
        matches!(result, Err(IdentityError::Refused(503))),
        "{result:?}"
    );
}
