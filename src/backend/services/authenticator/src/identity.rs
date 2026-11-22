use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use async_trait::async_trait;
use uuid::Uuid;

use crate::jwt::{GatewayClaims, KeyStore};

const IDENTITY_REQUEST_TIMEOUT_SECS: u64 = 20;
const IDENTITY_CONNECT_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone)]
pub enum ResolveTarget {
    ExternalId(String),
    Email(String),
    RosterEmail(String),
}

#[derive(Debug, Clone)]
pub struct IdpIdentity {
    pub sub: String,
    pub email: String,
    pub tenant_id: String,
    pub resolve_by: ResolveTarget,
}

#[derive(Debug, Clone)]
pub struct PersonResolution {
    pub person_id: String,
    pub tenant_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RosterPerson {
    pub person_id: Uuid,
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub email: Option<String>,
}

#[async_trait]
pub trait PersonResolver: Send + Sync {
    async fn resolve(&self, id: &IdpIdentity) -> anyhow::Result<Option<PersonResolution>>;

    async fn provision(&self, id: &IdpIdentity) -> anyhow::Result<Option<PersonResolution>> {
        let _ = id;
        Ok(None)
    }

    async fn active_roles(&self, person_id: &str, tenant_id: &str) -> anyhow::Result<Vec<String>> {
        let _ = (person_id, tenant_id);
        Ok(Vec::new())
    }

    async fn tenant_people(
        &self,
        person_ids: &[Uuid],
        authorization: Option<&str>,
    ) -> anyhow::Result<Vec<RosterPerson>> {
        let _ = (person_ids, authorization);
        Ok(Vec::new())
    }
}

#[derive(Clone)]
pub struct IdentityPersonResolver {
    base_url: String,
    http: reqwest::Client,
    keystore: Arc<KeyStore>,
    issuer: String,
    audience: String,
    source_type: String,
}

#[derive(serde::Deserialize)]
struct ResolveProfile {
    insight_source_id: Option<Uuid>,
}

fn provisionable_external_id(target: &ResolveTarget) -> Option<&str> {
    match target {
        ResolveTarget::ExternalId(external_id) => Some(external_id),
        ResolveTarget::Email(_) | ResolveTarget::RosterEmail(_) => None,
    }
}

impl IdentityPersonResolver {
    pub fn new(
        base_url: &str,
        keystore: Arc<KeyStore>,
        issuer: String,
        audience: String,
        source_type: String,
    ) -> anyhow::Result<Self> {
        let http = insight_http_client::client_builder()?
            .timeout(std::time::Duration::from_secs(
                IDENTITY_REQUEST_TIMEOUT_SECS,
            ))
            .connect_timeout(std::time::Duration::from_secs(
                IDENTITY_CONNECT_TIMEOUT_SECS,
            ))
            .build()
            .context("building the Identity HTTP client")?;

        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            http,
            keystore,
            issuer,
            audience,
            source_type,
        })
    }

    fn mint_service_token(&self, tenant_id: &str) -> anyhow::Result<String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock before epoch")?
            .as_secs();
        let claims = GatewayClaims {
            sub: Uuid::new_v5(&Uuid::NAMESPACE_URL, b"service:authenticator").to_string(),
            tenant_id: tenant_id.to_owned(),
            roles: vec!["service".to_owned()],
            sub_type: "service".to_owned(),
            sid: "service:authenticator".to_owned(),
            iss: self.issuer.clone(),
            aud: self.audience.clone(),
            iat: now,
            exp: now + 60,
            jti: Uuid::now_v7().to_string(),
        };
        self.keystore.sign(&claims)
    }

    async fn resolve_query(
        &self,
        path: &str,
        tenant_id: &str,
        query: &[(&str, &str)],
    ) -> anyhow::Result<Option<Uuid>> {
        if self.base_url.is_empty() {
            return Ok(None);
        }
        let url = format!("{}{path}", self.base_url);
        let token = self.mint_service_token(tenant_id)?;
        let resp = self
            .http
            .get(&url)
            .query(query)
            .bearer_auth(token)
            .send()
            .await
            .context("Identity request")?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        anyhow::ensure!(
            resp.status().is_success(),
            "Identity returned {} for {path}?{query:?}",
            resp.status()
        );
        let profile: ResolveProfile = resp.json().await.context("decode ResolveProfile")?;
        Ok(profile.insight_source_id.filter(|id| !id.is_nil()))
    }

    fn resolve_request<'a>(
        &'a self,
        target: &'a ResolveTarget,
    ) -> (&'static str, Vec<(&'static str, &'a str)>) {
        resolve_request(&self.source_type, target)
    }
}

fn resolve_request<'a>(
    source_type: &'a str,
    target: &'a ResolveTarget,
) -> (&'static str, Vec<(&'static str, &'a str)>) {
    {
        match target {
            ResolveTarget::ExternalId(external_id) => (
                "/internal/persons/by-external-id",
                vec![("source_type", source_type), ("external_id", external_id)],
            ),
            ResolveTarget::RosterEmail(email) => {
                ("/internal/persons/by-roster-email", vec![("email", email)])
            }
            ResolveTarget::Email(email) => (
                "/internal/persons/by-email-override",
                vec![("email", email)],
            ),
        }
    }
}

impl IdentityPersonResolver {
    async fn provision_person_by_external_id(
        &self,
        external_id: &str,
        tenant_id: &str,
    ) -> anyhow::Result<Option<Uuid>> {
        if self.base_url.is_empty() {
            return Ok(None);
        }
        let url = format!("{}/internal/persons/provision", self.base_url);
        let token = self.mint_service_token(tenant_id)?;
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({
                "source_type": self.source_type,
                "external_id": external_id,
                "tenant_id": tenant_id,
            }))
            .send()
            .await
            .context("Identity provision request")?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        anyhow::ensure!(
            status.is_success(),
            "Identity returned {status} for /internal/persons/provision"
        );
        let profile: ResolveProfile = resp.json().await.context("decode ResolveProfile")?;
        Ok(profile.insight_source_id.filter(|id| !id.is_nil()))
    }
}

#[derive(serde::Deserialize)]
struct PeopleList {
    items: Vec<RosterPerson>,
}

#[derive(serde::Deserialize)]
struct ActiveRolesProfile {
    roles: Vec<String>,
}

#[async_trait]
impl PersonResolver for IdentityPersonResolver {
    async fn resolve(&self, id: &IdpIdentity) -> anyhow::Result<Option<PersonResolution>> {
        let (path, query) = self.resolve_request(&id.resolve_by);
        let person_id = self.resolve_query(path, &id.tenant_id, &query).await?;
        let Some(person_id) = person_id else {
            return Ok(None);
        };
        Ok(Some(PersonResolution {
            person_id: person_id.to_string(),
            tenant_id: id.tenant_id.clone(),
        }))
    }

    async fn provision(&self, id: &IdpIdentity) -> anyhow::Result<Option<PersonResolution>> {
        let Some(external_id) = provisionable_external_id(&id.resolve_by) else {
            return Ok(None);
        };
        let person_id = self
            .provision_person_by_external_id(external_id, &id.tenant_id)
            .await?;
        Ok(person_id.map(|person_id| PersonResolution {
            person_id: person_id.to_string(),
            tenant_id: id.tenant_id.clone(),
        }))
    }

    async fn active_roles(&self, person_id: &str, tenant_id: &str) -> anyhow::Result<Vec<String>> {
        if self.base_url.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/internal/persons/active-roles", self.base_url);
        let token = self.mint_service_token(tenant_id)?;
        let resp = self
            .http
            .get(&url)
            .query(&[("person_id", person_id)])
            .bearer_auth(token)
            .send()
            .await
            .context("Identity active-roles request")?;
        anyhow::ensure!(
            resp.status().is_success(),
            "Identity returned {} for /internal/persons/active-roles",
            resp.status()
        );
        let profile: ActiveRolesProfile = resp.json().await.context("decode ActiveRolesProfile")?;
        Ok(profile.roles)
    }

    async fn tenant_people(
        &self,
        person_ids: &[Uuid],
        authorization: Option<&str>,
    ) -> anyhow::Result<Vec<RosterPerson>> {
        if self.base_url.is_empty() || person_ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = person_ids
            .iter()
            .map(Uuid::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let limit = person_ids.len().to_string();
        let url = format!("{}/v1/people", self.base_url);
        let mut request = self.http.get(&url).query(&[
            ("visibility", "tenant"),
            ("ids", ids.as_str()),
            ("limit", limit.as_str()),
        ]);
        if let Some(authorization) = authorization {
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        let resp = request
            .send()
            .await
            .context("Identity tenant roster request")?;
        anyhow::ensure!(
            resp.status().is_success(),
            "Identity returned {} for /v1/people",
            resp.status()
        );
        let page: PeopleList = resp.json().await.context("decode PeopleList")?;
        Ok(page.items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct LookupOnly;

    #[async_trait]
    impl PersonResolver for LookupOnly {
        async fn resolve(&self, _id: &IdpIdentity) -> anyhow::Result<Option<PersonResolution>> {
            Ok(None)
        }
    }

    fn identity(resolve_by: ResolveTarget) -> IdpIdentity {
        IdpIdentity {
            sub: "subject".to_owned(),
            email: "someone@example.com".to_owned(),
            tenant_id: Uuid::from_u128(7).to_string(),
            resolve_by,
        }
    }

    #[test]
    fn only_a_login_is_provisionable_never_the_view_as_override() {
        assert_eq!(
            provisionable_external_id(&ResolveTarget::ExternalId("octocat".to_owned())),
            Some("octocat"),
        );
        assert_eq!(
            provisionable_external_id(&ResolveTarget::Email("typo@example.com".to_owned())),
            None,
            "an operator's typed email must never mint the person it names",
        );
        assert_eq!(
            provisionable_external_id(&ResolveTarget::RosterEmail("ivan@vz.com".to_owned())),
            None,
            "a login resolved by address cannot mint either — minting needs the \
             source-native id the roster observed, and an address is not it",
        );
    }

    #[test]
    fn each_target_resolves_through_its_own_route() {
        let login = ResolveTarget::ExternalId("00000000-oid".to_owned());
        let (path, query) = resolve_request("ms-entra", &login);
        assert_eq!(path, "/internal/persons/by-external-id");
        assert_eq!(
            query,
            vec![("source_type", "ms-entra"), ("external_id", "00000000-oid")]
        );

        let roster_login = ResolveTarget::RosterEmail("ivan@vz.com".to_owned());
        let (path, query) = resolve_request("bamboohr", &roster_login);
        assert_eq!(path, "/internal/persons/by-roster-email");
        assert_eq!(query, vec![("email", "ivan@vz.com")]);

        let override_target = ResolveTarget::Email("ops@vz.com".to_owned());
        let (path, query) = resolve_request("bamboohr", &override_target);
        assert_eq!(path, "/internal/persons/by-email-override");
        assert_eq!(query, vec![("email", "ops@vz.com")]);
    }

    #[test]
    fn no_address_target_carries_the_source_type() {
        for target in [
            ResolveTarget::RosterEmail("ivan@vz.com".to_owned()),
            ResolveTarget::Email("ops@vz.com".to_owned()),
        ] {
            let (_, query) = resolve_request("bamboohr", &target);
            assert!(
                query.iter().all(|(k, _)| *k != "source_type"),
                "{target:?} must not send source_type",
            );
        }
    }

    #[tokio::test]
    async fn a_resolver_without_a_roles_source_grants_nothing() -> anyhow::Result<()> {
        let roles = LookupOnly.active_roles("person", "tenant").await?;

        assert!(roles.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn a_resolver_without_minting_power_fails_closed() -> anyhow::Result<()> {
        let provisioned = LookupOnly
            .provision(&identity(ResolveTarget::ExternalId("octocat".to_owned())))
            .await?;

        assert!(provisioned.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn the_tenant_roster_is_read_for_exactly_these_ids_as_the_caller() -> anyhow::Result<()> {
        use axum::extract::Query;
        use axum::http::{HeaderMap, header::AUTHORIZATION};
        use std::collections::HashMap;
        use std::sync::Mutex;

        type Seen = Arc<Mutex<Vec<(Option<String>, HashMap<String, String>)>>>;
        let seen: Seen = Arc::default();
        let record = Arc::clone(&seen);
        let ada = Uuid::from_u128(0xa);
        let bob = Uuid::from_u128(0xb);
        let router = axum::Router::new().route(
            "/v1/people",
            axum::routing::get(
                move |headers: HeaderMap, Query(params): Query<HashMap<String, String>>| {
                    let auth = headers
                        .get(AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    record
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push((auth, params));
                    async move {
                        axum::Json(serde_json::json!({
                            "items": [{
                                "person_id": ada.to_string(),
                                "display_name": "Ada Example",
                                "username": "ada",
                                "email": "ada@example.com",
                                "attributes": {},
                            }],
                            "next_cursor": null,
                        }))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        tokio::spawn(async move { axum::serve(listener, router).await });
        let pem = {
            use p256::elliptic_curve::Generate as _;
            use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
            p256::SecretKey::generate().to_pkcs8_pem(LineEnding::LF)?
        };
        let resolver = IdentityPersonResolver::new(
            &url,
            Arc::new(KeyStore::from_pem_for_test(&pem)?),
            "issuer".to_owned(),
            "audience".to_owned(),
            "source".to_owned(),
        )?;

        let people = resolver
            .tenant_people(&[ada, bob], Some("Bearer caller"))
            .await?;

        assert_eq!(people.len(), 1);
        assert_eq!(people[0].person_id, ada);
        assert_eq!(people[0].display_name.as_deref(), Some("Ada Example"));
        let seen = seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (auth, params) = &seen[0];
        assert_eq!(auth.as_deref(), Some("Bearer caller"));
        assert_eq!(params.get("visibility").map(String::as_str), Some("tenant"));
        assert_eq!(params.get("ids").cloned(), Some(format!("{ada},{bob}")));
        assert_eq!(params.get("limit").map(String::as_str), Some("2"));
        Ok(())
    }

    #[tokio::test]
    async fn a_resolver_without_a_roster_source_knows_nobody() -> anyhow::Result<()> {
        let people = LookupOnly
            .tenant_people(&[Uuid::from_u128(1)], None)
            .await?;

        assert!(people.is_empty());
        Ok(())
    }
}
