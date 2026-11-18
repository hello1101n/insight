use chrono::{SubsecRound as _, Utc};
use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use secrecy::ExposeSecret as _;
use uuid::Uuid;

use super::store::{self, NewToken};
use super::{TokenHash, TokenHolder, TokenLabel, mint};

const ENV_VAR: &str = "INTEGRATION_TESTS_MARIADB_URL";

type R = Result<(), Box<dyn std::error::Error>>;

async fn connect_or_skip() -> Option<DatabaseConnection> {
    let Ok(url) = std::env::var(ENV_VAR) else {
        eprintln!("skipping: {ENV_VAR} not set");
        return None;
    };
    let mut opts = ConnectOptions::new(url);
    opts.max_connections(2).sqlx_logging(false);
    match Database::connect(opts).await {
        Ok(db) => Some(db),
        Err(e) => {
            eprintln!("skipping: cannot connect to {ENV_VAR}: {e}");
            None
        }
    }
}

#[tokio::test]
#[ignore = "requires live MariaDB 11+; set INTEGRATION_TESTS_MARIADB_URL to enable"]
async fn a_stored_token_answers_by_hash_until_it_is_removed() -> R {
    let Some(db) = connect_or_skip().await else {
        return Ok(());
    };
    let tenant = Uuid::now_v7();
    let person = Uuid::now_v7();
    let admin = Uuid::now_v7();
    let label = TokenLabel::parse("laptop")?;
    let minted = mint()?;

    let token_id = store::insert(
        &db,
        NewToken {
            tenant_id: tenant,
            person_id: person,
            label: &label,
            created_by: admin,
            hash: &minted.hash,
            created_at: Utc::now().trunc_subsecs(0),
        },
    )
    .await?;

    let holder = store::holder(&db, &TokenHash::of(minted.token.expose_secret())).await?;
    assert_eq!(
        holder,
        Some(TokenHolder {
            person_id: person,
            label,
        })
    );

    assert!(
        store::remove(&db, tenant, token_id).await?,
        "first remove deletes"
    );
    assert!(
        !store::remove(&db, tenant, token_id).await?,
        "second remove finds nothing"
    );
    assert_eq!(store::holder(&db, &minted.hash).await?, None);
    Ok(())
}

#[tokio::test]
#[ignore = "requires live MariaDB 11+; set INTEGRATION_TESTS_MARIADB_URL to enable"]
async fn a_tenant_lists_and_removes_only_its_own_tokens_newest_first() -> R {
    let Some(db) = connect_or_skip().await else {
        return Ok(());
    };
    let tenant = Uuid::now_v7();
    let other_tenant = Uuid::now_v7();
    let admin = Uuid::now_v7();
    let label = TokenLabel::parse("ci")?;
    let now = Utc::now().trunc_subsecs(0);

    let mut stored = Vec::new();
    for (owner, created_at) in [
        (tenant, now - chrono::Duration::minutes(2)),
        (tenant, now - chrono::Duration::minutes(1)),
        (other_tenant, now),
    ] {
        let minted = mint()?;
        let token_id = store::insert(
            &db,
            NewToken {
                tenant_id: owner,
                person_id: Uuid::now_v7(),
                label: &label,
                created_by: admin,
                hash: &minted.hash,
                created_at,
            },
        )
        .await?;
        stored.push(token_id);
    }

    let listed: Vec<Uuid> = store::list(&db, tenant)
        .await?
        .iter()
        .map(|row| row.id)
        .collect();
    assert_eq!(listed, vec![stored[1], stored[0]]);

    assert!(
        !store::remove(&db, tenant, stored[2]).await?,
        "another tenant's token must not be removable"
    );
    assert_eq!(store::list(&db, other_tenant).await?.len(), 1);
    Ok(())
}

#[tokio::test]
#[ignore = "requires live MariaDB 11+; set INTEGRATION_TESTS_MARIADB_URL to enable"]
async fn a_tenant_list_stops_at_the_list_limit() -> R {
    let Some(db) = connect_or_skip().await else {
        return Ok(());
    };
    let tenant = Uuid::now_v7();
    let label = TokenLabel::parse("ci")?;

    for _ in 0..=store::LIST_LIMIT {
        let minted = mint()?;
        store::insert(
            &db,
            NewToken {
                tenant_id: tenant,
                person_id: Uuid::now_v7(),
                label: &label,
                created_by: Uuid::now_v7(),
                hash: &minted.hash,
                created_at: Utc::now().trunc_subsecs(0),
            },
        )
        .await?;
    }

    let listed = store::list(&db, tenant).await?;

    assert_eq!(u64::try_from(listed.len())?, store::LIST_LIMIT);
    Ok(())
}
