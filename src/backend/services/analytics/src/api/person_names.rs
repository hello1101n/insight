use std::collections::HashMap;

use insight_clickhouse::{Param, Sql, sql};
use serde::Deserialize;
use uuid::Uuid;

pub(crate) fn named_persons(tenant: Uuid) -> Sql {
    sql!("({named})", named = aggregate(tenant, Sql::default()))
}

#[derive(Debug, Deserialize, clickhouse::Row)]
pub(crate) struct PersonName {
    #[serde(with = "clickhouse::serde::uuid")]
    person_id: Uuid,
    pub(crate) display_name: String,
    pub(crate) username: String,
}

pub(crate) async fn lookup(
    ch: &insight_clickhouse::Client,
    tenant: Uuid,
    ids: &[Uuid],
) -> HashMap<Uuid, PersonName> {
    lookup_bounded(ch, tenant, ids, |query| query).await
}

pub(crate) async fn lookup_bounded(
    ch: &insight_clickhouse::Client,
    tenant: Uuid,
    ids: &[Uuid],
    bound: impl FnOnce(clickhouse::query::Query) -> clickhouse::query::Query,
) -> HashMap<Uuid, PersonName> {
    if ids.is_empty() {
        return HashMap::new();
    }

    match bound(ch.query_sql(&named_among(tenant, ids)))
        .fetch_all::<PersonName>()
        .await
    {
        Ok(found) => by_person(found),
        Err(error) => {
            tracing::warn!(error = %error, "naming people from the identity rows failed");
            HashMap::new()
        }
    }
}

#[cfg(test)]
impl PersonName {
    pub(crate) fn named(display_name: &str, username: &str) -> Self {
        Self {
            person_id: Uuid::nil(),
            display_name: display_name.to_owned(),
            username: username.to_owned(),
        }
    }
}

fn by_person(found: Vec<PersonName>) -> HashMap<Uuid, PersonName> {
    found
        .into_iter()
        .map(|name| (name.person_id, name))
        .collect()
}

fn named_among(tenant: Uuid, ids: &[Uuid]) -> Sql {
    let among = sql!(
        " AND person_id IN {ids}",
        ids = Param::uuids(ids.iter().copied())
    );
    aggregate(tenant, among)
}

/// INVARIANT: every selected name coalesces to `''`. A `nullIf` left uncovered
/// makes the column `Nullable(String)`, which the row type refuses to decode —
/// and the refusal surfaces only against a real server.
fn aggregate(tenant: Uuid, person: Sql) -> Sql {
    sql!(
        "SELECT person_id, \
         coalesce(\
           nullIf(argMaxIf(value_effective, (created_at, id), value_type = 'display_name'), ''), \
           nullIf(trimBoth(concat(\
             coalesce(argMaxIf(value_effective, (created_at, id), value_type = 'first_name'), ''), \
             ' ', \
             coalesce(argMaxIf(value_effective, (created_at, id), value_type = 'last_name'), '') \
           )), ''), \
           '' \
         ) AS display_name, \
         coalesce(nullIf(argMaxIf(value_effective, (created_at, id), value_type = 'username'), ''), '') AS username \
         FROM identity.identity_persons \
         WHERE value_type IN ('display_name', 'first_name', 'last_name', 'username') \
         AND insight_tenant_id = {tenant}{person} \
         GROUP BY person_id",
        tenant = Param::uuid(tenant),
        person = person,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offline_client() -> insight_clickhouse::Client {
        insight_clickhouse::Client::new(insight_clickhouse::Config {
            url: "http://127.0.0.1:1".to_owned(),
            database: "identity".to_owned(),
            user: None,
            password: None,
            query_timeout: None,
            query_max_threads: None,
            query_max_memory_bytes: None,
            topology: insight_clickhouse::Topology::Standalone,
        })
    }

    #[tokio::test]
    async fn nobody_to_name_asks_the_server_nothing() {
        let names = lookup(&offline_client(), Uuid::now_v7(), &[]).await;

        assert!(names.is_empty());
    }

    #[test]
    fn a_name_is_keyed_by_the_person_it_belongs_to() {
        let alice = Uuid::now_v7();
        let bob = Uuid::now_v7();
        let mut found = vec![
            PersonName::named("Alice Example", "alice"),
            PersonName::named("Bob Park", "bob"),
        ];
        found[0].person_id = alice;
        found[1].person_id = bob;

        let names = by_person(found);

        assert_eq!(
            names.get(&alice).map(|n| n.username.as_str()),
            Some("alice")
        );
        assert_eq!(
            names.get(&bob).map(|n| n.display_name.as_str()),
            Some("Bob Park")
        );
    }

    const TENANT: Uuid = Uuid::from_u128(0x7e);

    #[test]
    fn the_relation_binds_the_tenant_and_nothing_else() {
        let params = named_persons(TENANT).render().params;

        assert_eq!(params, [("tenant".to_owned(), Param::uuid(TENANT))]);
    }

    #[test]
    fn the_lookup_binds_the_tenant_and_the_person_set() {
        let ids = [Uuid::from_u128(1), Uuid::from_u128(2)];

        let params = named_among(TENANT, &ids).render().params;

        assert_eq!(
            params,
            [
                ("tenant".to_owned(), Param::uuid(TENANT)),
                ("ids".to_owned(), Param::uuids(ids)),
            ]
        );
    }

    #[test]
    fn every_name_the_aggregate_selects_is_never_null() {
        let sql: String = named_persons(TENANT)
            .render()
            .sql
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();

        assert!(sql.contains(",'')ASdisplay_name"), "{sql}");
        assert!(sql.contains(",'')ASusername"), "{sql}");
    }

    #[test]
    fn the_person_filter_sits_before_the_grouping() {
        let sql = named_among(TENANT, &[Uuid::from_u128(1)]).render().sql;

        assert!(
            sql.find("person_id IN {ids:Array(UUID)}") < sql.find("GROUP BY"),
            "filtering after the GROUP BY aggregates the whole tenant: {sql}"
        );
    }
}
