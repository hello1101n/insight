use super::super::super::roster_names::Roster;
use super::super::search::PersonSearch;
use super::super::sort::{ActionsSort, Order, PagesSort, PeopleSort};
use super::super::tests::{window_binds, window_params};
use super::*;
use crate::infra::identity::RosterPerson;

type R = Result<(), Box<dyn std::error::Error>>;

fn people(order: Order<PeopleSort>, search: Option<&PeopleSearch<'_>>) -> String {
    people_sql(&window_binds(), order, search).render().sql
}

#[test]
fn the_actions_breakdown_leaves_out_what_nobody_did() {
    let sql = actions_sql(&window_binds(), "1", Order::default())
        .render()
        .sql;

    assert!(
        sql.contains("NOT IN ('page_view', 'session_start')"),
        "{sql}"
    );
}

#[test]
fn every_caller_value_in_a_read_is_a_placeholder() -> R {
    let binds = window_binds();
    for sql in [
        by_page_sql(&binds, "V", Order::parse(Some("visitors"), Some("asc"))?),
        actions_sql(&binds, "V", Order::parse(Some("people"), Some("asc"))?),
        people_sql(&binds, Order::parse(Some("last_seen"), Some("asc"))?, None),
    ] {
        let rendered = sql.render();

        assert_eq!(rendered.params, window_params(&binds), "{}", rendered.sql);
        assert!(
            !rendered.sql.contains(&binds.tenant.to_string()) && !rendered.sql.contains("2026-"),
            "a read has interpolated a window value: {}",
            rendered.sql
        );
    }
    Ok(())
}

#[test]
fn the_identity_join_reads_the_tenant_the_window_binds() {
    let sql = people(Order::default(), None);

    assert_eq!(sql.matches("{tenant:UUID}").count(), 2, "{sql}");
}

#[test]
fn a_visitor_is_named_from_the_mirrored_identity_rows() {
    let sql = people(Order::default(), None);
    assert!(sql.contains("identity.identity_persons"), "{sql}");
    assert!(sql.contains("display_name"), "{sql}");
}

#[test]
fn a_visitor_without_a_name_is_still_named_by_its_account_handle() {
    let sql = people(Order::default(), None);

    assert!(sql.contains("'username'"), "{sql}");
    assert!(sql.contains("AS username"), "{sql}");
}

#[test]
fn the_cap_keeps_the_rows_the_chosen_order_puts_first() -> R {
    let binds = window_binds();
    let people = people(
        Order::<PeopleSort>::parse(Some("last_seen"), Some("desc"))?,
        None,
    );
    let pages = by_page_sql(
        &binds,
        "V",
        Order::<PagesSort>::parse(Some("visitors"), Some("asc"))?,
    )
    .render()
    .sql;
    let actions = actions_sql(
        &binds,
        "V",
        Order::<ActionsSort>::parse(Some("people"), Some("desc"))?,
    )
    .render()
    .sql;

    assert!(
        people.contains("ORDER BY last_ts DESC, person LIMIT 200"),
        "{people}"
    );
    assert!(
        pages.ends_with("ORDER BY visitors ASC, path LIMIT 200"),
        "{pages}"
    );
    assert!(
        actions.ends_with("ORDER BY people DESC, event_name, target LIMIT 200"),
        "{actions}"
    );
    Ok(())
}

#[test]
fn the_identity_join_keeps_the_order_the_cap_chose() -> R {
    let sql = people(
        Order::<PeopleSort>::parse(Some("page_views"), Some("asc"))?,
        None,
    );

    assert!(
        sql.contains("ORDER BY page_views ASC, visits ASC, person LIMIT 200"),
        "{sql}"
    );
    assert!(
        sql.ends_with("ORDER BY u.page_views ASC, u.visits ASC, u.person"),
        "{sql}"
    );
    Ok(())
}

#[test]
fn last_seen_orders_by_the_instant_and_renders_it_as_text() {
    let sql = people(Order::default(), None);

    assert!(sql.contains("max(ts) AS last_ts"), "{sql}");
    assert!(sql.contains("toString(last_ts) AS last_seen"), "{sql}");
}

fn searching(raw: &str) -> Result<PersonSearch, Box<dyn std::error::Error>> {
    PersonSearch::parse(Some(raw))?.ok_or_else(|| "a real search".into())
}

#[test]
fn a_search_matches_a_visitor_by_name_or_by_handle() -> R {
    let sql = people(
        Order::default(),
        Some(&PeopleSearch {
            needle: &searching("ada")?,
            rostered: &[],
        }),
    );

    assert!(
        sql.contains("positionCaseInsensitiveUTF8(display_name, {needle:String}) > 0"),
        "{sql}"
    );
    assert!(
        sql.contains("positionCaseInsensitiveUTF8(username, {needle:String}) > 0"),
        "{sql}"
    );
    Ok(())
}

#[test]
fn a_search_narrows_the_visitors_before_the_cap_keeps_its_200() -> R {
    let sql = people(
        Order::default(),
        Some(&PeopleSearch {
            needle: &searching("ada")?,
            rostered: &[],
        }),
    );

    let filter = sql.find("positionCaseInsensitiveUTF8").ok_or("no filter")?;
    let cap = sql.find("LIMIT 200").ok_or("no cap")?;
    assert!(filter < cap, "{sql}");
    Ok(())
}

#[test]
fn a_search_is_bound_never_spliced_in() -> R {
    let needle = "ada'); DROP TABLE x; --";
    let rostered = [Uuid::from_u128(1)];
    let binds = window_binds();

    let rendered = people_sql(
        &binds,
        Order::default(),
        Some(&PeopleSearch {
            needle: &searching(needle)?,
            rostered: &rostered,
        }),
    )
    .render();

    assert!(!rendered.sql.contains(needle), "{}", rendered.sql);
    let [tenant, since, until] = window_params(&binds);
    assert_eq!(
        rendered.params,
        [
            tenant,
            since,
            until,
            ("needle".to_owned(), Param::string(needle)),
            ("rostered".to_owned(), Param::uuids(rostered)),
        ],
        "the window, the needle and the roster's matches, each once"
    );
    Ok(())
}

#[test]
fn no_search_leaves_the_visitors_unfiltered() {
    let sql = people(Order::default(), None);

    assert!(!sql.contains("positionCaseInsensitiveUTF8"), "{sql}");
}

#[test]
fn a_search_also_keeps_the_visitors_the_roster_names_by_it() -> R {
    let sql = people(
        Order::default(),
        Some(&PeopleSearch {
            needle: &searching("Example")?,
            rostered: &[Uuid::from_u128(1)],
        }),
    );

    assert!(
        sql.contains("OR person_id IN {rostered:Array(UUID)}"),
        "{sql}"
    );
    Ok(())
}

fn visited(person_id: Uuid, display_name: &str) -> UsagePersonRow {
    UsagePersonRow {
        person_id,
        display_name: display_name.to_owned(),
        username: display_name.to_owned(),
        visits: 2,
        page_views: 3,
        last_seen: "2026-08-02 10:00:00.000".to_owned(),
    }
}

#[test]
fn a_visitor_on_the_roster_is_served_the_name_people_shows() {
    let ada = Uuid::from_u128(1);
    let mut roster = Roster::new();
    roster.insert(
        ada,
        RosterPerson {
            person_id: ada,
            display_name: Some("Ada Example".to_owned()),
            username: None,
            email: Some("ada@example.com".to_owned()),
        },
    );

    let person = named(visited(ada, "ada"), &roster);

    assert_eq!(person.display_name, "Ada Example");
    assert_eq!(person.email.as_deref(), Some("ada@example.com"));
    assert_eq!((person.visits, person.page_views), (2, 3));
}

#[test]
fn a_visitor_off_the_roster_keeps_the_identity_rows_name() {
    let person = named(visited(Uuid::from_u128(2), "bob"), &Roster::new());

    assert_eq!(person.display_name, "bob");
    assert_eq!(person.email, None);
}
