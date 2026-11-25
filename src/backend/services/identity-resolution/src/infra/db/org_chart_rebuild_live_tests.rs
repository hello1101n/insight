use std::collections::BTreeSet;

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use uuid::Uuid;

use super::seed_repo;
use super::test_fixture::{Fixture, bytes, fixture_or_skip};

type TestResult = anyhow::Result<()>;

type Edge = (Uuid, Option<Uuid>, Uuid);

async fn current_edges(f: &Fixture) -> anyhow::Result<BTreeSet<Edge>> {
    let rows =
        f.db.query_all_raw(Statement::from_sql_and_values(
            DbBackend::MySql,
            "SELECT child_person_id, parent_person_id, author_person_id
             FROM org_chart
             WHERE insight_tenant_id = ? AND valid_to IS NULL",
            [bytes(f.tenant)],
        ))
        .await?;

    rows.iter()
        .map(|row| {
            let child: Vec<u8> = row.try_get("", "child_person_id")?;
            let parent: Option<Vec<u8>> = row.try_get("", "parent_person_id")?;
            let author: Vec<u8> = row.try_get("", "author_person_id")?;
            Ok((
                Uuid::from_slice(&child)?,
                parent.map(|raw| Uuid::from_slice(&raw)).transpose()?,
                Uuid::from_slice(&author)?,
            ))
        })
        .collect()
}

#[tokio::test]
async fn a_rebuild_links_reports_to_managers_and_roots_the_rest_as_the_seed_author() -> TestResult {
    let Some(f) = fixture_or_skip().await? else {
        return Ok(());
    };
    let manager = f.person("manager@org-chart.test").await?;
    let report = f.person("report@org-chart.test").await?;
    f.observed(report, "parent_email", "manager@org-chart.test")
        .await?;
    let seed_author = Uuid::now_v7();

    let counts = seed_repo::apply(&f.db, f.tenant, seed_author, &[], &[], None).await?;

    assert_eq!(counts.org_chart_rows_rebuilt, 2);
    assert_eq!(
        current_edges(&f).await?,
        BTreeSet::from([
            (report, Some(manager), report),
            (manager, None, seed_author)
        ]),
        "the report sits under the manager its observation names, the manager is a root the seed wrote"
    );
    Ok(())
}
