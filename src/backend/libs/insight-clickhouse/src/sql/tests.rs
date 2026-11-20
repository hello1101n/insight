use super::*;
use crate::{Client, Config};

type R = Result<(), Box<dyn std::error::Error>>;

const TENANT: Uuid = Uuid::from_u128(0x7e);

fn day(raw: &str) -> Result<NaiveDate, chrono::ParseError> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
}

fn named(name: &str, param: Param) -> (String, Param) {
    (name.to_owned(), param)
}

#[test]
fn a_value_renders_as_a_placeholder_naming_its_clickhouse_type() -> R {
    let cases = [
        (Param::string("a"), "String"),
        (Param::uuid(TENANT), "UUID"),
        (Param::date(day("2026-01-31")?), "Date"),
        (Param::int64(-1), "Int64"),
        (Param::uint64(1), "UInt64"),
        (Param::float64(0.5), "Float64"),
        (Param::bool(true), "Bool"),
        (Param::strings(["a", "b"]), "Array(String)"),
        (Param::uuids([TENANT]), "Array(UUID)"),
    ];

    for (param, clickhouse_type) in cases {
        let rendered = sql!("x = {v}", v = param.clone()).render();

        assert_eq!(rendered.sql, format!("x = {{v:{clickhouse_type}}}"));
        assert_eq!(rendered.params, [named("v", param)], "{clickhouse_type}");
    }
    Ok(())
}

#[test]
fn captured_text_is_spliced_and_named_arguments_are_bound() {
    const TABLE: &str = "product_usage.usage_events";
    let needle = "x'); DROP TABLE t; --";

    let rendered = sql!(
        "SELECT 1 FROM {TABLE} WHERE name = {needle}",
        needle = Param::string(needle),
    )
    .render();

    assert_eq!(
        rendered.sql,
        "SELECT 1 FROM product_usage.usage_events WHERE name = {needle:String}"
    );
    assert_eq!(rendered.params, [named("needle", Param::string(needle))]);
}

#[test]
fn a_nested_fragment_brings_its_values_with_it() -> R {
    let since = day("2026-01-01")?;
    let window = sql!("ts >= {since}", since = Param::date(since));

    let rendered = sql!(
        "SELECT * FROM (SELECT * FROM t WHERE {window}) WHERE kind = {kind}",
        window = window,
        kind = Param::string("page_view"),
    )
    .render();

    assert_eq!(
        rendered.sql,
        "SELECT * FROM (SELECT * FROM t WHERE ts >= {since:Date}) WHERE kind = {kind:String}"
    );
    assert_eq!(
        rendered.params,
        [
            named("since", Param::date(since)),
            named("kind", Param::string("page_view"))
        ]
    );
    Ok(())
}

#[test]
fn one_value_referenced_from_many_fragments_binds_once() {
    let scope = || sql!("tenant_id = {tenant}", tenant = Param::uuid(TENANT));

    let rendered = sql!(
        "SELECT * FROM a WHERE {outer} AND id IN (SELECT id FROM b WHERE {inner}) AND {outer}",
        outer = scope(),
        inner = scope(),
    )
    .render();

    assert_eq!(
        rendered.sql.matches("{tenant:UUID}").count(),
        3,
        "{}",
        rendered.sql
    );
    assert_eq!(rendered.params, [named("tenant", Param::uuid(TENANT))]);
}

#[test]
fn one_name_bound_to_different_values_takes_a_fresh_name_per_value() -> R {
    let window = |from: &str| -> Result<Sql, chrono::ParseError> {
        Ok(sql!("d >= {from}", from = Param::date(day(from)?)))
    };

    let rendered = Sql::join(
        [
            window("2026-01-01")?,
            window("2025-01-01")?,
            sql!("e = {from_1}", from_1 = Param::string("taken")),
            window("2026-01-01")?,
        ],
        " OR ",
    )
    .render();

    assert_eq!(
        rendered.sql,
        "d >= {from:Date} OR d >= {from_1:Date} OR e = {from_1_1:String} OR d >= {from:Date}"
    );
    assert_eq!(
        rendered.params,
        [
            named("from", Param::date(day("2026-01-01")?)),
            named("from_1", Param::date(day("2025-01-01")?)),
            named("from_1_1", Param::string("taken")),
        ]
    );
    Ok(())
}

#[test]
fn a_slot_whose_name_prefixes_another_fills_only_its_own_place() {
    let rendered = sql!("{a} {ab}", a = Param::int64(1), ab = Param::int64(2)).render();

    assert_eq!(rendered.sql, "{a:Int64} {ab:Int64}");
    assert_eq!(
        rendered.params,
        [named("a", Param::int64(1)), named("ab", Param::int64(2))]
    );
}

#[test]
fn join_puts_the_separator_between_parts_only() {
    let parts = (1..=3).map(|n| {
        sql!(
            "{column} = {v}",
            column = Sql::raw(format!("c{n}")),
            v = Param::int64(n)
        )
    });

    let rendered = Sql::join(parts, " AND ").render();

    assert_eq!(
        rendered.sql,
        "c1 = {v:Int64} AND c2 = {v_1:Int64} AND c3 = {v_2:Int64}"
    );
    assert!(Sql::join([], " AND ").is_empty());
    assert!(Sql::join([sql!(""), sql!("")], "").is_empty());
    assert!(!sql!("{v}", v = Param::int64(0)).is_empty());
}

#[test]
fn push_appends_a_fragment_with_its_values() {
    let mut query = sql!("SELECT 1 WHERE a = {a}", a = Param::bool(true));

    query.push(sql!(" AND b = {b}", b = Param::bool(false)));

    let rendered = query.render();
    assert_eq!(rendered.sql, "SELECT 1 WHERE a = {a:Bool} AND b = {b:Bool}");
    assert_eq!(
        rendered.params,
        [
            named("a", Param::bool(true)),
            named("b", Param::bool(false))
        ]
    );
}

#[tokio::test]
async fn the_server_receives_the_text_verbatim_and_each_value_once_by_name() -> R {
    let mock = clickhouse::test::Mock::new();
    let recorded = mock.add(clickhouse::test::handlers::record_ddl());
    let client = Client::new(Config::new(mock.url(), "insight"));
    let query = sql!(
        "SELECT '?' FROM t WHERE tenant_id = {tenant} AND id IN {ids} AND owner = {tenant}",
        tenant = Param::uuid(TENANT),
        ids = Param::uuids([TENANT]),
    );

    client.query_sql(&query).execute().await?;

    let body = recorded.query().await;
    assert!(
        body.contains(
            "SELECT '?' FROM t WHERE tenant_id = {tenant:UUID} AND id IN {ids:Array(UUID)} \
             AND owner = {tenant:UUID}"
        ),
        "{body}"
    );
    assert_eq!(body.matches("name=\"param_tenant\"").count(), 1, "{body}");
    assert!(
        body.contains(&format!("name=\"param_tenant\"\r\n\r\n{TENANT}\r\n")),
        "{body}"
    );
    assert!(
        body.contains(&format!("name=\"param_ids\"\r\n\r\n['{TENANT}']\r\n")),
        "{body}"
    );
    Ok(())
}

fn live_client_or_skip() -> Option<Client> {
    let url = std::env::var("INTEGRATION_TESTS_CLICKHOUSE_URL").unwrap_or_default();
    if url.is_empty() {
        eprintln!("skipping: INTEGRATION_TESTS_CLICKHOUSE_URL not set");
        return None;
    }

    let mut config = Config::new(url, "default");
    if let (Ok(user), Ok(password)) = (
        std::env::var("INTEGRATION_TESTS_CLICKHOUSE_USER"),
        std::env::var("INTEGRATION_TESTS_CLICKHOUSE_PASSWORD"),
    ) && !user.is_empty()
    {
        config = config.with_auth(user, password);
    }
    Some(Client::new(config))
}

#[tokio::test]
async fn a_composed_query_binds_by_name_on_a_live_server() -> R {
    let Some(client) = live_client_or_skip() else {
        return Ok(());
    };
    let other_tenant = Uuid::from_u128(0x7f);
    let person = Uuid::from_u128(0x1);
    let colleague = Uuid::from_u128(0x2);
    let rows = format!(
        "values('tenant_id UUID, person_id UUID', \
         ('{TENANT}', '{person}'), ('{TENANT}', '{colleague}'), ('{other_tenant}', '{person}'))"
    );
    let tenant_people = sql!(
        "SELECT person_id FROM {rows} WHERE tenant_id = {tenant}",
        rows = Sql::raw(&rows),
        tenant = Param::uuid(TENANT),
    );
    let query = sql!(
        "SELECT count() FROM {rows} WHERE tenant_id = {tenant} \
         AND person_id = {person} AND person_id IN {listed} AND person_id IN ({tenant_people})",
        tenant = Param::uuid(TENANT),
        person = Param::string(person.to_string()),
        listed = Param::uuids([person, colleague]),
        tenant_people = tenant_people,
        rows = Sql::raw(rows),
    );

    let rendered = query.render();
    let names: Vec<&str> = rendered
        .params
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(names, ["tenant", "person", "listed"], "{}", rendered.sql);

    let matched: u64 = client.query_sql(&query).fetch_one().await?;
    assert_eq!(matched, 1, "{}", rendered.sql);
    Ok(())
}

#[tokio::test]
async fn an_identifier_param_names_a_table_on_a_live_server() -> R {
    let Some(client) = live_client_or_skip() else {
        return Ok(());
    };
    let table = "sql_identifier_probe";
    client
        .query_sql(&sql!(
            "CREATE OR REPLACE TABLE {table} (id UInt8) ENGINE = Memory",
            table = Param::identifier(table),
        ))
        .execute()
        .await?;
    client
        .query_sql(&sql!(
            "INSERT INTO {table} VALUES (1), (2)",
            table = Param::identifier(table),
        ))
        .execute()
        .await?;

    let count: u64 = client
        .query_sql(&sql!(
            "SELECT count() FROM {table}",
            table = Param::identifier(table),
        ))
        .fetch_one()
        .await?;
    let refused = client
        .query_sql(&sql!(
            "SELECT count() FROM {table}",
            table = Param::identifier(format!("{table} WHERE 0 = 1")),
        ))
        .fetch_one::<u64>()
        .await;

    client
        .query_sql(&sql!(
            "DROP TABLE {table}",
            table = Param::identifier(table)
        ))
        .execute()
        .await?;
    assert_eq!(count, 2);
    assert!(
        refused.is_err(),
        "an identifier must not carry SQL: {refused:?}"
    );
    Ok(())
}
