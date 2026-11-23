//! The roster's employee ID → person pairs, against a live `MariaDB`.
//!
//! `roster_employee_ids` feeds the persons-seed link by employee ID. What has
//! to hold: only the roster's rows count, only the latest ID of each person
//! counts, and the tenant filter applies.
//!
//! INVARIANT: never `#[ignore]` these — the identity CI job runs `cargo test`
//! without `--include-ignored`, so an ignored case silently stops running.

use super::seed_repo;
use super::test_fixture::{SOURCE_TYPE, fixture_or_skip};

type TestResult = anyhow::Result<()>;

#[tokio::test]
async fn a_person_gives_the_latest_employee_id_of_the_roster() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let person = f
        .person(&format!("ann.{}@employeeid.test", f.tenant.simple()))
        .await?;
    let old_id = format!("OLD-{}", f.tenant.simple());
    let new_id = format!("NEW-{}", f.tenant.simple());
    // INVARIANT: the row that must WIN is written FIRST, so the case tests the
    // timestamp rule and not the insert order.
    f.observed_at(person, "employee_id", &new_id, 60).await?;
    f.observed_at(person, "employee_id", &old_id, 86_400)
        .await?;

    let pairs = seed_repo::roster_employee_ids(&f.db, f.tenant, SOURCE_TYPE).await?;

    assert_eq!(
        pairs,
        vec![(new_id, person)],
        "only the latest roster ID counts"
    );
    Ok(())
}

#[tokio::test]
async fn an_employee_id_from_another_source_is_not_returned() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let person = f
        .person(&format!("bob.{}@employeeid.test", f.tenant.simple()))
        .await?;
    f.observed_from(
        "zoom",
        person,
        "employee_id",
        &format!("Z-{}", f.tenant.simple()),
    )
    .await?;

    let pairs = seed_repo::roster_employee_ids(&f.db, f.tenant, SOURCE_TYPE).await?;

    assert_eq!(
        pairs,
        Vec::new(),
        "a non-roster employee ID must not be returned"
    );
    Ok(())
}

#[tokio::test]
async fn two_persons_with_one_employee_id_both_come_back() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let shared = format!("SHARED-{}", f.tenant.simple());
    let first = f
        .person(&format!("first.{}@employeeid.test", f.tenant.simple()))
        .await?;
    let second = f
        .person(&format!("second.{}@employeeid.test", f.tenant.simple()))
        .await?;
    f.observed(first, "employee_id", &shared).await?;
    f.observed(second, "employee_id", &shared).await?;

    let mut pairs = seed_repo::roster_employee_ids(&f.db, f.tenant, SOURCE_TYPE).await?;
    pairs.sort();

    let mut expected = vec![(shared.clone(), first), (shared, second)];
    expected.sort();
    assert_eq!(
        pairs, expected,
        "the caller needs both holders to see the contest"
    );
    Ok(())
}
