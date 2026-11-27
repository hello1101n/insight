use uuid::Uuid;

use super::person_roles_repo::{get_by_id, insert, try_soft_delete_protecting_last_admin};
use super::roles_repo::ADMIN_ROLE_ID;
use super::test_fixture::{FIXTURE_REASON, Fixture, fixture_or_skip};

type TestResult = anyhow::Result<()>;

async fn admin(f: &Fixture, email: &str) -> anyhow::Result<Uuid> {
    let person = f.person(email).await?;
    let grant = Uuid::now_v7();
    insert(
        &f.db,
        grant,
        f.tenant,
        person,
        ADMIN_ROLE_ID,
        None,
        person,
        Some(FIXTURE_REASON),
    )
    .await?;
    Ok(grant)
}

#[tokio::test]
async fn revoking_an_admin_who_is_not_the_last_records_the_reason_given() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    admin(&f, "stays@person-roles.test").await?;
    let leaving = admin(&f, "leaves@person-roles.test").await?;

    let revoked =
        try_soft_delete_protecting_last_admin(&f.db, leaving, ADMIN_ROLE_ID, Some("rotated off"))
            .await?;

    assert_eq!(revoked, 1);
    let row = get_by_id(&f.db, f.tenant, leaving)
        .await?
        .ok_or_else(|| anyhow::anyhow!("the revoked assignment vanished"))?;
    assert!(row.valid_to.is_some(), "the assignment must be closed");
    assert_eq!(row.reason.as_deref(), Some("rotated off"));
    Ok(())
}

#[tokio::test]
async fn the_last_admin_stays_even_when_the_revoke_names_a_reason() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let sole = admin(&f, "sole@person-roles.test").await?;

    let revoked =
        try_soft_delete_protecting_last_admin(&f.db, sole, ADMIN_ROLE_ID, Some("one too many"))
            .await?;

    assert_eq!(revoked, 0, "the tenant must keep its last admin");
    let row = get_by_id(&f.db, f.tenant, sole)
        .await?
        .ok_or_else(|| anyhow::anyhow!("the assignment vanished"))?;
    assert!(row.valid_to.is_none(), "the assignment must stay open");
    assert_eq!(row.reason.as_deref(), Some(FIXTURE_REASON));
    Ok(())
}
