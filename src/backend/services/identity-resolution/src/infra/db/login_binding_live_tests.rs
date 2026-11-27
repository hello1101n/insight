use chrono::NaiveDate;
use sea_orm::prelude::DateTime;
use uuid::Uuid;

use crate::domain::login_bootstrap::LOGIN_BOOTSTRAP_REASON;
use crate::domain::resolution::BindingRow;

use super::resolution_repo::{append_binding_if_unbound, binding_history};
use super::test_fixture::{FIXTURE_REASON, Fixture, fixture_or_skip};

type TestResult = anyhow::Result<()>;

fn signed_in_at() -> anyhow::Result<DateTime> {
    NaiveDate::from_ymd_opt(2026, 1, 2)
        .and_then(|day| day.and_hms_micro_opt(3, 4, 5, 123_456))
        .ok_or_else(|| anyhow::anyhow!("invalid fixture timestamp"))
}

fn sign_in(f: &Fixture, person_id: Uuid) -> anyhow::Result<BindingRow> {
    Ok(BindingRow {
        account: f.account(&format!("login-{}", f.tenant.simple())),
        person_id,
        author_person_id: Uuid::nil(),
        reason: LOGIN_BOOTSTRAP_REASON.to_owned(),
        created_at: signed_in_at()?,
    })
}

#[tokio::test]
async fn a_sign_in_binds_an_unbound_account_to_the_person_it_names() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let row = sign_in(&f, Uuid::now_v7())?;

    assert!(append_binding_if_unbound(&f.db, f.tenant, &row).await?);

    let history = binding_history(&f.db, f.tenant, &row.account).await?;
    let written: Vec<_> = history
        .iter()
        .map(|h| {
            (
                h.person_id,
                h.author_person_id,
                h.reason.as_deref(),
                h.created_at,
            )
        })
        .collect();
    assert_eq!(
        written,
        vec![(
            row.person_id,
            row.author_person_id,
            Some(LOGIN_BOOTSTRAP_REASON),
            row.created_at
        )],
        "the binding must carry exactly the row the sign-in decided"
    );
    Ok(())
}

#[tokio::test]
async fn a_sign_in_never_rebinds_an_account_already_decided() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let holder = f.person("holder@login-binding.test").await?;
    let row = sign_in(&f, Uuid::now_v7())?;
    f.bound_at(&row.account.account_id, holder, FIXTURE_REASON, 60)
        .await?;

    let rebound = append_binding_if_unbound(&f.db, f.tenant, &row).await?;

    assert!(!rebound, "a decided account must not take a second binding");
    let history = binding_history(&f.db, f.tenant, &row.account).await?;
    assert_eq!(
        history.iter().map(|h| h.person_id).collect::<Vec<_>>(),
        vec![holder]
    );
    Ok(())
}
