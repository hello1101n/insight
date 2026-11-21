use super::*;

const BUDGET: u64 = 512 * MIB;

async fn complete(db: &DatabaseConnection, stand: &str, req: &Request) -> anyhow::Result<()> {
    let now = Utc::now();
    observe(
        db,
        stand,
        &load(db, stand, req).await?,
        Observation {
            status: Some("succeeded".into()),
            started_at: Some(now),
            finished_at: Some(now),
            peak_bytes: Some(32 * MIB),
            volume_bytes: Some(100),
            ..Default::default()
        },
    )
    .await
}

async fn calibrate(
    db: &DatabaseConnection,
    stand: &str,
    connector: &str,
    stage: &str,
) -> anyhow::Result<Request> {
    let trained = request(connector, stage);
    if stage != "bronze" {
        record_bronze_input(db, stand, &trained, Utc::now(), Some(100)).await?;
    }
    assert_eq!(
        register(db, stand, "tenant", &trained, Utc::now(), BUDGET)
            .await?
            .1
            .decision,
        "granted"
    );
    complete(db, stand, &trained).await?;
    let next = request(connector, stage);
    if stage != "bronze" {
        record_bronze_input(db, stand, &next, Utc::now(), Some(100)).await?;
    }
    Ok(next)
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn tiny_headroom_holds_a_cold_job() -> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let req = request("jira", "bronze");
    assert_eq!(
        register(&db, &stand, "tenant", &req, Utc::now(), 1)
            .await?
            .1
            .decision,
        "queued"
    );
    let row = load(&db, &stand, &req).await?;
    assert!(!promote(&db, &stand, &row, 256 * MIB - 1).await?);
    assert!(promote(&db, &stand, &row, 256 * MIB).await?);
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn ready_cold_job_can_drain_the_stand() -> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let active = calibrate(&db, &stand, "jira", "bronze").await?;
    assert_eq!(
        register(&db, &stand, "tenant", &active, Utc::now(), BUDGET)
            .await?
            .1
            .decision,
        "granted"
    );
    let cold = request("github", "bronze");
    let younger = request("jira", "bronze");
    assert_eq!(
        register(&db, &stand, "tenant", &cold, Utc::now(), BUDGET)
            .await?
            .1
            .decision,
        "queued"
    );
    assert_eq!(
        register(&db, &stand, "tenant", &younger, Utc::now(), BUDGET)
            .await?
            .1
            .decision,
        "queued"
    );
    complete(&db, &stand, &active).await?;
    assert!(promote(&db, &stand, &load(&db, &stand, &cold).await?, BUDGET).await?);
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn conflicting_materializations_wait_and_disjoint_writers_overlap() -> anyhow::Result<()> {
    let db = db().await?;
    let now = Utc::now();
    for (left, right, conflict) in [
        (
            ("mock", "transform-staging"),
            ("mock", "transform-staging"),
            true,
        ),
        (
            ("jira", "transform-jira-staging"),
            ("github", "transform-staging"),
            true,
        ),
        (
            ("jira", "transform-jira-silver"),
            ("github", "transform-legacy"),
            true,
        ),
        (("jira", "identity-seed"), ("github", "identity-seed"), true),
        (
            ("jira", "transform-jira-staging"),
            ("github", "transform-legacy"),
            false,
        ),
    ] {
        let stand = uuid::Uuid::now_v7().to_string();
        let a = calibrate(&db, &stand, left.0, left.1).await?;
        let b = calibrate(&db, &stand, right.0, right.1).await?;
        let (a, b) = tokio::join!(
            register(&db, &stand, "tenant", &a, now, BUDGET),
            register(&db, &stand, "tenant", &b, now, BUDGET)
        );
        let grants = [a?.1, b?.1]
            .into_iter()
            .filter(|x| x.decision == "granted")
            .count();
        assert_eq!(
            grants,
            if conflict { 1 } else { 2 },
            "{left:?} and {right:?}"
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn workers_grant_disjoint_batches_to_observed_suspend_nodes() -> anyhow::Result<()> {
    let db = db().await?;
    let stand = uuid::Uuid::now_v7().to_string();
    let first = calibrate(&db, &stand, "jira", "bronze").await?;
    register(&db, &stand, "tenant", &first, Utc::now(), 0).await?;
    let unobserved = load(&db, &stand, &first).await?.id;
    for _ in 0..40 {
        let req = request("jira", "bronze");
        register(&db, &stand, "tenant", &req, Utc::now(), 0).await?;
    }
    let ready: HashSet<_> = unfinished(&db, &stand)
        .await?
        .into_iter()
        .filter(|r| r.id != unobserved && r.status == "queued")
        .map(|r| r.id)
        .collect();
    assert_eq!(ready.len(), 40);
    let capacity = 2048 * MIB;
    let (first, second) = tokio::try_join!(
        promote_ready(&db, &stand, &ready, capacity),
        promote_ready(&db, &stand, &ready, capacity)
    )?;
    let mut sizes = [first.len(), second.len()];
    sizes.sort_unstable();
    assert_eq!(sizes, [8, 32]);
    assert_eq!(
        first.into_iter().chain(second).collect::<HashSet<_>>(),
        ready
    );
    assert!(
        promote_ready(&db, &stand, &ready, capacity)
            .await?
            .is_empty()
    );
    let remaining = unfinished(&db, &stand)
        .await?
        .into_iter()
        .filter(|r| r.status == "queued")
        .map(|r| r.id)
        .collect::<Vec<_>>();
    assert_eq!(remaining, [unobserved]);
    Ok(())
}

#[tokio::test]
#[ignore = "requires INTEGRATION_TESTS_MARIADB_URL"]
async fn custom_and_legacy_jira_selections_run_alone_and_do_not_train_other_selections()
-> anyhow::Result<()> {
    let db = db().await?;
    for legacy in [false, true] {
        let stand = uuid::Uuid::now_v7().to_string();
        let mut jira = calibrate(&db, &stand, "jira", "transform-jira-staging").await?;
        let github = calibrate(&db, &stand, "github", "transform-legacy").await?;
        assert_eq!(
            register(&db, &stand, "tenant", &github, Utc::now(), BUDGET)
                .await?
                .1
                .decision,
            "granted"
        );
        jira.custom_selection = true;
        assert_eq!(
            register(&db, &stand, "tenant", &jira, Utc::now(), BUDGET)
                .await?
                .1
                .decision,
            "queued"
        );
        let id = load(&db, &stand, &jira).await?.id;
        if legacy {
            db.execute_raw(sql(
                "UPDATE ingestion_stage_attempts SET custom_selection=NULL,cold=FALSE WHERE id=?",
                vec![id.into()],
            ))
            .await?;
        }
        let ready = HashSet::from([id]);
        assert!(load(&db, &stand, &jira).await?.cold);
        assert!(promote_ready(&db, &stand, &ready, BUDGET).await?.is_empty());
        complete(&db, &stand, &github).await?;
        assert_eq!(promote_ready(&db, &stand, &ready, BUDGET).await?, [id]);
        let later = request("github", "bronze");
        assert_eq!(
            register(&db, &stand, "tenant", &later, Utc::now(), BUDGET)
                .await?
                .1
                .decision,
            "queued"
        );
        complete(&db, &stand, &jira).await?;
        db.execute_raw(sql(
            "UPDATE ingestion_stage_attempts SET peak_bytes=? WHERE id=?",
            vec![(2 * BUDGET).into(), id.into()],
        ))
        .await?;
        let next = request("jira", "transform-jira-staging");
        record_bronze_input(&db, &stand, &next, Utc::now(), Some(100)).await?;
        register(&db, &stand, "tenant", &next, Utc::now(), BUDGET).await?;
        let stage = load(&db, &stand, &next).await?;
        assert!(!stage.cold);
        assert_eq!(stage.estimated_bytes, 40 * MIB);
    }
    Ok(())
}
