use super::seed_repo;
use super::test_fixture::fixture_or_skip;

type TestResult = anyhow::Result<()>;

#[tokio::test]
async fn a_tenant_beside_other_tenants_is_not_reported() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let other = f.in_another_tenant();
    other
        .person(&format!("elsewhere.{}@guard.test", other.tenant.simple()))
        .await?;
    f.person(&format!("ours.{}@guard.test", f.tenant.simple()))
        .await?;

    let found = seed_repo::other_tenant_only(&f.db, f.tenant).await?;

    assert_eq!(
        found, None,
        "a tenant that holds its own persons seeds beside others"
    );
    Ok(())
}

#[tokio::test]
async fn a_tenant_without_persons_beside_another_is_reported() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let other = f.in_another_tenant();
    other
        .person(&format!("elsewhere.{}@guard.test", other.tenant.simple()))
        .await?;

    let found = seed_repo::other_tenant_only(&f.db, f.tenant).await?;

    assert!(
        found.is_some_and(|t| t != f.tenant),
        "persons holding only other tenants must name one of them: {found:?}"
    );
    Ok(())
}
