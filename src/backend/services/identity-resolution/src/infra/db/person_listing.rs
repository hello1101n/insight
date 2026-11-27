use sea_orm::{ConnectionTrait as _, DatabaseConnection, DbBackend, QueryResult, Statement, Value};
use uuid::Uuid;

use crate::config::VisibilityPolicy;
use crate::domain::resolution::EXCLUDED_PERSON;

use super::sql_named::{BindError, bind_named, named_clauses, named_list};
use super::visible_set_sql::CURRENT_VISIBLE_SET_CTE;

/// MariaDB truncates a TEXT sort key at `max_sort_length` (1024 bytes by default) but
/// compares the resume predicate in full, so a longer key would let paging skip a row.
const ORDER_KEY_CHARS: usize = 255;

const _: () = assert!(ORDER_KEY_CHARS * 4 < 1024);

const MAX_CANDIDATES: usize = 2_000;

const PROBE_LIMIT: u64 = MAX_CANDIDATES as u64 + 1;

const FILTERABLE_VALUE_TYPES: [&str; 5] = [
    "email",
    "username",
    "display_name",
    "first_name",
    "last_name",
];

const CANONICAL_BINDING: &str = "id";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listed {
    EveryIdentity,
    AccountHolders,
}

#[derive(Debug, Clone, Copy)]
pub struct Restrict<'a> {
    pub listed: Listed,
    pub visible_to: Option<VisibleTo<'a>>,
}

impl Restrict<'_> {
    #[cfg(test)]
    pub(super) const EVERY_IDENTITY: Self = Self {
        listed: Listed::EveryIdentity,
        visible_to: None,
    };
}

#[derive(Debug, Clone, Copy)]
pub struct VisibleTo<'a> {
    pub viewer_person_id: Uuid,
    pub org_source_type: &'a str,
    pub policy: VisibilityPolicy,
}

#[derive(Debug, Clone)]
pub struct PersonListRow {
    pub person_id: Uuid,
    pub order_key: String,
}

#[derive(Debug, Clone, Copy)]
pub struct After<'a> {
    pub order_key: &'a str,
    pub person_id: Uuid,
}

pub async fn list_persons(
    db: &DatabaseConnection,
    tenant_id: Uuid,
    terms: &[String],
    within: &[Uuid],
    restrict: Restrict<'_>,
    after: Option<After<'_>>,
    limit: u64,
) -> anyhow::Result<Vec<PersonListRow>> {
    match narrowing(db, tenant_id, terms, within).await? {
        Narrowing::Nobody => Ok(Vec::new()),
        Narrowing::Tenant => page(db, tenant_id, terms, None, restrict, after, limit).await,
        Narrowing::Persons(ids) => {
            page(db, tenant_id, terms, Some(&ids), restrict, after, limit).await
        }
    }
}

#[derive(Debug)]
enum Narrowing {
    Tenant,
    Persons(Vec<Uuid>),
    Nobody,
}

async fn page(
    db: &DatabaseConnection,
    tenant_id: Uuid,
    terms: &[String],
    narrowed_to: Option<&[Uuid]>,
    restrict: Restrict<'_>,
    after: Option<After<'_>>,
    limit: u64,
) -> anyhow::Result<Vec<PersonListRow>> {
    let (sql, values) = build_query(tenant_id, terms, narrowed_to, restrict, after, limit)?;
    let stmt = Statement::from_sql_and_values(DbBackend::MySql, &sql, values);
    rows_from(db.query_all_raw(stmt).await?)
}

async fn narrowing(
    db: &DatabaseConnection,
    tenant_id: Uuid,
    terms: &[String],
    within: &[Uuid],
) -> anyhow::Result<Narrowing> {
    if !within.is_empty() {
        return Ok(Narrowing::Persons(within.to_vec()));
    }
    let Some((first, rest)) = terms.split_first() else {
        return Ok(Narrowing::Tenant);
    };

    Ok(from_probe(
        candidate_persons(db, tenant_id, first, rest).await?,
    ))
}

fn from_probe(candidates: Vec<Uuid>) -> Narrowing {
    if candidates.is_empty() {
        return Narrowing::Nobody;
    }
    if candidates.len() > MAX_CANDIDATES {
        return Narrowing::Tenant;
    }
    Narrowing::Persons(candidates)
}

async fn candidate_persons(
    db: &DatabaseConnection,
    tenant_id: Uuid,
    first: &str,
    rest: &[String],
) -> anyhow::Result<Vec<Uuid>> {
    let (sql, values) = build_probe(tenant_id, first, rest)?;
    let stmt = Statement::from_sql_and_values(DbBackend::MySql, &sql, values);

    let rows = db.query_all_raw(stmt).await?;
    let mut found = Vec::with_capacity(rows.len());
    for row in rows {
        let raw: Vec<u8> = row.try_get("", "person_id")?;
        found.push(Uuid::from_slice(&raw)?);
    }
    Ok(found)
}

fn build_probe(
    tenant_id: Uuid,
    first: &str,
    rest: &[String],
) -> Result<(String, Vec<Value>), BindError> {
    let type_list = searched_types();
    let (also, mut params) = named_clauses(
        "rest_term",
        rest.iter().map(|term| like_pattern(term).into()),
        |name| {
            format!(
                "\n              AND EXISTS (SELECT 1 FROM persons t \
                 WHERE t.insight_tenant_id = p.insight_tenant_id \
                   AND t.person_id = p.person_id \
                   AND t.value_type IN ({type_list}) \
                   AND t.value_effective LIKE @{name} ESCAPE '!')"
            )
        },
    );
    params.extend([
        ("tenant_id".to_owned(), bytes(tenant_id)),
        ("first_term".to_owned(), like_pattern(first).into()),
        ("probe_limit".to_owned(), PROBE_LIMIT.into()),
    ]);

    let sql = format!(
        r"
        SELECT DISTINCT p.person_id
        FROM persons p
        WHERE p.insight_tenant_id = @tenant_id
          AND p.value_type IN ({type_list})
          AND p.value_effective LIKE @first_term ESCAPE '!'{also}
        LIMIT @probe_limit
    "
    );

    bind_named(&sql, &params)
}

#[cfg(test)]
pub(super) async fn list_persons_unnarrowed(
    db: &DatabaseConnection,
    tenant_id: Uuid,
    terms: &[String],
    after: Option<After<'_>>,
    limit: u64,
) -> anyhow::Result<Vec<PersonListRow>> {
    page(
        db,
        tenant_id,
        terms,
        None,
        Restrict::EVERY_IDENTITY,
        after,
        limit,
    )
    .await
}

fn searched_types() -> String {
    FILTERABLE_VALUE_TYPES
        .iter()
        .map(|t| format!("'{t}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

const LABEL_CTES: &str = r"
        current_vals AS (
            SELECT person_id, value_type, value_effective, created_at, id
            FROM ranked
            WHERE rn = 1
        ),
        latest_vals AS (
            SELECT person_id, value_type, value_effective,
                   ROW_NUMBER() OVER (
                       PARTITION BY person_id, value_type
                       ORDER BY created_at DESC, id DESC
                   ) AS rn
            FROM current_vals
        ),
        card AS (
            SELECT person_id,
                   COALESCE(
                       NULLIF(TRIM(display_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ',
                           NULLIF(TRIM(first_name), ''),
                           NULLIF(TRIM(last_name), ''))), ''),
                       NULLIF(TRIM(username), ''),
                       NULLIF(TRIM(email), '')
                   ) AS label
            FROM (
                SELECT person_id,
                       MAX(CASE WHEN value_type = 'display_name' THEN value_effective END) AS display_name,
                       MAX(CASE WHEN value_type = 'first_name'   THEN value_effective END) AS first_name,
                       MAX(CASE WHEN value_type = 'last_name'    THEN value_effective END) AS last_name,
                       MAX(CASE WHEN value_type = 'email'        THEN value_effective END) AS email,
                       MAX(CASE WHEN value_type = 'username'     THEN value_effective END) AS username
                FROM latest_vals
                WHERE rn = 1
                GROUP BY person_id
            ) pivoted
        )";

struct VisibleScopeSql {
    recursive: &'static str,
    cte: String,
    filter: &'static str,
    params: Vec<(String, Value)>,
}

fn visible_scope(visible_to: Option<VisibleTo<'_>>) -> VisibleScopeSql {
    let Some(scope) = visible_to else {
        return VisibleScopeSql {
            recursive: "",
            cte: String::new(),
            filter: "",
            params: Vec::new(),
        };
    };

    VisibleScopeSql {
        recursive: "RECURSIVE ",
        cte: format!(",\n{CURRENT_VISIBLE_SET_CTE}"),
        filter: " AND EXISTS (SELECT 1 FROM visible_set vs WHERE vs.person_id = p.person_id)",
        params: vec![
            ("viewer_person_id".to_owned(), bytes(scope.viewer_person_id)),
            ("flat_tenant".to_owned(), scope.policy.is_flat().into()),
            ("org_source_type".to_owned(), scope.org_source_type.into()),
        ],
    }
}

fn build_query(
    tenant_id: Uuid,
    terms: &[String],
    narrowed_to: Option<&[Uuid]>,
    restrict: Restrict<'_>,
    after: Option<After<'_>>,
    limit: u64,
) -> Result<(String, Vec<Value>), BindError> {
    let type_list = searched_types();
    let mut params = vec![
        ("tenant_id".to_owned(), bytes(tenant_id)),
        ("excluded_person".to_owned(), bytes(EXCLUDED_PERSON)),
        ("limit".to_owned(), limit.into()),
    ];

    let roster = match narrowed_to {
        None => String::new(),
        Some(ids) => {
            let (list, named) = named_list("within", ids.iter().copied().map(bytes));
            params.extend(named);
            format!("\n              AND person_id IN ({list})")
        }
    };

    let claimed = match restrict.listed {
        Listed::EveryIdentity => String::new(),
        Listed::AccountHolders => format!(
            "\n              AND person_id IN (\
             \n                  SELECT person_id FROM persons \
             \n                  WHERE insight_tenant_id = @tenant_id AND value_type = '{CANONICAL_BINDING}'\
             \n              )"
        ),
    };

    let ranked_within = if roster.is_empty() && claimed.is_empty() {
        ""
    } else {
        "\n              AND person_id IN (SELECT person_id FROM people)"
    };

    let scope = visible_scope(restrict.visible_to);
    let visible_cte = scope.cte;
    let recursive = scope.recursive;
    params.extend(scope.params);

    let (term_filters, term_params) = named_clauses(
        "term",
        terms.iter().map(|term| like_pattern(term).into()),
        |name| {
            format!(
                " AND EXISTS (SELECT 1 FROM current_vals t \
                 WHERE t.person_id = p.person_id AND t.value_effective LIKE @{name} ESCAPE '!')"
            )
        },
    );
    let filters = format!("{}{term_filters}", scope.filter);
    params.extend(term_params);

    let mut resume = "";
    if let Some(after) = after {
        resume = " WHERE (order_key > @after_key \
                  OR (order_key = @after_key AND person_id > @after_person_id))";
        params.push(("after_key".to_owned(), after.order_key.into()));
        params.push(("after_person_id".to_owned(), bytes(after.person_id)));
    }

    let sql = format!(
        r"
        WITH {recursive}people AS (
            SELECT DISTINCT person_id
            FROM persons
            WHERE insight_tenant_id = @tenant_id AND person_id != @excluded_person{roster}{claimed}
        ),
        ranked AS (
            SELECT person_id, value_type, value_effective, created_at, id,
                   ROW_NUMBER() OVER (
                       PARTITION BY person_id, insight_source_type, insight_source_id, value_type
                       ORDER BY created_at DESC, id DESC
                   ) AS rn
            FROM persons
            WHERE insight_tenant_id = @tenant_id
              AND value_type IN ({type_list}){ranked_within}
        ),
{LABEL_CTES}{visible_cte}
        SELECT person_id, order_key FROM (
            SELECT p.person_id AS person_id,
                   CONCAT(
                       IF(c.label IS NULL, '1', '0'),
                       LEFT(LOWER(COALESCE(c.label, '')), {ORDER_KEY_CHARS})
                   ) AS order_key
            FROM people p
            LEFT JOIN card c ON c.person_id = p.person_id
            WHERE 1 = 1{filters}
        ) keyed{resume}
        ORDER BY order_key, person_id
        LIMIT @limit
    "
    );

    bind_named(&sql, &params)
}

fn bytes(id: Uuid) -> Value {
    id.as_bytes().to_vec().into()
}

fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('!', "!!")
        .replace('%', "!%")
        .replace('_', "!_");
    format!("%{escaped}%")
}

fn rows_from(rows: Vec<QueryResult>) -> anyhow::Result<Vec<PersonListRow>> {
    let mut listed = Vec::with_capacity(rows.len());
    for row in rows {
        let bytes: Vec<u8> = row.try_get("", "person_id")?;
        listed.push(PersonListRow {
            person_id: Uuid::from_slice(&bytes)?,
            order_key: row.try_get("", "order_key")?,
        });
    }
    Ok(listed)
}

#[cfg(test)]
mod tests {
    use super::*;

    type R = anyhow::Result<()>;

    fn query(
        terms: &[String],
        narrowed_to: Option<&[Uuid]>,
        after: Option<After<'_>>,
    ) -> anyhow::Result<String> {
        Ok(build_query(
            Uuid::nil(),
            terms,
            narrowed_to,
            Restrict::EVERY_IDENTITY,
            after,
            50,
        )?
        .0)
    }

    fn visible_to(policy: VisibilityPolicy) -> VisibleTo<'static> {
        VisibleTo {
            viewer_person_id: Uuid::from_u128(7),
            org_source_type: "bamboohr",
            policy,
        }
    }

    fn visible_query(policy: VisibilityPolicy) -> anyhow::Result<String> {
        Ok(build_query(
            Uuid::nil(),
            &[],
            None,
            Restrict {
                listed: Listed::EveryIdentity,
                visible_to: Some(visible_to(policy)),
            },
            None,
            50,
        )?
        .0)
    }

    fn listed_query(listed: Listed) -> anyhow::Result<String> {
        Ok(build_query(
            Uuid::nil(),
            &[],
            None,
            Restrict {
                listed,
                visible_to: None,
            },
            None,
            50,
        )?
        .0)
    }

    #[test]
    fn a_roster_admits_only_the_persons_a_connector_claims() -> R {
        let sql = listed_query(Listed::AccountHolders)?;

        assert!(
            sql.contains("value_type = 'id'"),
            "the roster must require a canonical binding: {sql}"
        );
        Ok(())
    }

    #[test]
    fn the_operator_surface_still_lists_an_identity_nobody_claims() -> R {
        let sql = listed_query(Listed::EveryIdentity)?;

        assert!(
            !sql.contains("value_type = 'id'"),
            "the picker must not require a binding: {sql}"
        );
        Ok(())
    }

    #[test]
    fn every_listing_shape_binds_each_placeholder_to_a_value() {
        let terms = ["iva".to_owned(), "example.com".to_owned()];
        let within = [Uuid::from_u128(0xB2), Uuid::from_u128(0xB3)];
        let after = After {
            order_key: "0ivanov",
            person_id: Uuid::from_u128(0xC3),
        };

        for shape in 0..32_u8 {
            let bit = |n: u8| shape & (1 << n) != 0;
            let restrict = Restrict {
                listed: if bit(0) {
                    Listed::AccountHolders
                } else {
                    Listed::EveryIdentity
                },
                visible_to: bit(1).then_some(visible_to(VisibilityPolicy::OrgChart)),
            };

            let bound = build_query(
                Uuid::from_u128(0xA1),
                if bit(2) { &terms } else { &[] },
                bit(3).then_some(&within[..]),
                restrict,
                bit(4).then_some(after),
                50,
            );

            assert!(bound.is_ok(), "shape {shape:05b}: {bound:?}");
        }
    }

    #[test]
    fn a_query_with_no_terms_filters_nothing_and_still_pages() -> R {
        let sql = query(&[], None, None)?;

        assert!(!sql.contains("EXISTS"), "no term filter when browsing");
        assert!(!sql.contains("order_key >"), "no resume on a first page");
        assert!(sql.contains("ORDER BY order_key, person_id"));
        assert!(sql.contains("LIMIT ?"));
        Ok(())
    }

    #[test]
    fn every_term_becomes_its_own_match_requirement() -> R {
        let terms = ["iva".to_owned(), "example.com".to_owned()];

        let sql = query(&terms, None, None)?;

        assert_eq!(
            sql.matches("FROM current_vals t").count(),
            terms.len(),
            "the exact filter must probe once per term: {sql}"
        );
        assert!(
            !sql.contains("OR EXISTS"),
            "a person must match both terms, not either: {sql}"
        );
        Ok(())
    }

    #[test]
    fn a_narrowed_page_ranks_the_named_persons_and_not_the_tenant() -> R {
        let ids = [Uuid::from_u128(0xB2), Uuid::from_u128(0xB3)];

        let sql = query(&["iva".to_owned()], Some(&ids), None)?;

        assert!(
            sql.contains("AND person_id IN (?, ?)"),
            "the roster must be cut to the named persons: {sql}"
        );
        assert!(
            sql.contains("AND person_id IN (SELECT person_id FROM people)"),
            "the ranking must read the cut roster: {sql}"
        );
        Ok(())
    }

    #[test]
    fn an_unnarrowed_page_ranks_the_tenant_without_a_semi_join() -> R {
        let sql = query(&["iva".to_owned()], None, None)?;

        assert!(
            !sql.contains("IN (SELECT person_id FROM people)"),
            "an unnarrowed roster must stay a plain scan: {sql}"
        );
        assert!(
            sql.contains("FROM current_vals t"),
            "the exact filter still applies: {sql}"
        );
        Ok(())
    }

    #[test]
    fn the_probe_requires_every_term_of_a_person() -> R {
        let terms = ["iva".to_owned(), "example.com".to_owned()];

        let (sql, values) = build_probe(Uuid::nil(), &terms[0], &terms[1..])?;

        assert_eq!(
            sql.matches("LIKE ?").count(),
            terms.len(),
            "one probe per term: {sql}"
        );
        assert!(!sql.contains("OR "), "terms are ANDed, never ORed: {sql}");
        assert!(
            sql.contains("LIMIT ?"),
            "the probe must stop at the cap: {sql}"
        );
        assert_eq!(
            values.last(),
            Some(&Value::from(PROBE_LIMIT)),
            "the probe reads one row past the cap, so a full set is recognisable"
        );
        Ok(())
    }

    #[test]
    fn the_probes_answer_decides_which_shape_runs() {
        let under: Vec<Uuid> = (0..3).map(Uuid::from_u128).collect();
        let over: Vec<Uuid> = (0..=MAX_CANDIDATES as u128).map(Uuid::from_u128).collect();

        assert!(
            matches!(from_probe(under.clone()), Narrowing::Persons(ids) if ids == under),
            "a small set narrows the ranking"
        );
        assert!(
            matches!(from_probe(over), Narrowing::Tenant),
            "a set past the cap falls back to the tenant"
        );
        assert!(matches!(from_probe(Vec::new()), Narrowing::Nobody));
    }

    #[test]
    fn resuming_compares_the_key_then_breaks_the_tie_on_the_id() -> R {
        let sql = query(
            &[],
            None,
            Some(After {
                order_key: "0ivanov",
                person_id: Uuid::nil(),
            }),
        )?;

        assert!(sql.contains("order_key > ? OR (order_key = ? AND person_id > ?)"));
        Ok(())
    }

    #[test]
    fn the_order_key_is_cut_to_what_the_sort_can_compare() -> R {
        assert!(query(&[], None, None)?.contains(&format!("), {ORDER_KEY_CHARS})")));
        Ok(())
    }

    #[test]
    fn an_unrestricted_listing_asks_nothing_about_visibility() -> R {
        let sql = query(&[], None, None)?;

        assert!(
            !sql.contains("visible_set"),
            "the operator surface is unfiltered"
        );
        assert!(
            !sql.contains("RECURSIVE"),
            "no recursion without a visible set"
        );
        Ok(())
    }

    #[test]
    fn a_restricted_listing_narrows_the_set_to_the_visible_one() -> R {
        let sql = visible_query(VisibilityPolicy::OrgChart)?;

        assert!(
            sql.contains("WITH RECURSIVE"),
            "the visible set recurses: {sql}"
        );
        assert!(sql.contains("visible_set"));
        assert!(
            sql.contains("EXISTS (SELECT 1 FROM visible_set"),
            "the restriction is a filter over the listed people: {sql}"
        );
        Ok(())
    }

    #[test]
    fn the_policy_reaches_the_visible_set_as_a_bound_flag() -> R {
        for (policy, expected) in [
            (VisibilityPolicy::OrgChart, false),
            (VisibilityPolicy::Flat, true),
        ] {
            let (_, values) = build_query(
                Uuid::nil(),
                &[],
                None,
                Restrict {
                    listed: Listed::EveryIdentity,
                    visible_to: Some(visible_to(policy)),
                },
                None,
                50,
            )?;

            assert!(
                values.contains(&Value::from(expected)),
                "{policy:?} must bind {expected}"
            );
        }
        Ok(())
    }

    #[test]
    fn like_pattern_neutralises_wildcards() {
        for (term, expected) in [
            ("alice", "%alice%"),
            ("50%", "%50!%%"),
            ("a_b", "%a!_b%"),
            ("!", "%!!%"),
        ] {
            assert_eq!(like_pattern(term), expected, "should escape: {term:?}");
        }
    }
}
