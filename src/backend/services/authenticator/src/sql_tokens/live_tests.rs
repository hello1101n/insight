use chrono::{SubsecRound as _, Utc};
use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait as _;
use secrecy::ExposeSecret as _;
use uuid::Uuid;

use super::store::{self, NewToken};
use super::{TokenHash, TokenHolder, TokenLabel, mint};
use crate::migration::Migrator;

const ENV_VAR: &str = "INTEGRATION_TESTS_MARIADB_URL";

static MIGRATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

type R = Result<(), Box<dyn std::error::Error>>;

async fn connect_or_skip() -> Option<DatabaseConnection> {
    let Ok(url) = std::env::var(ENV_VAR) else {
        eprintln!("skipping: {ENV_VAR} not set");
        return None;
    };
    let mut opts = ConnectOptions::new(url);
    opts.max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .sqlx_logging(false);
    let db = Database::connect(opts)
        .await
        .unwrap_or_else(|e| panic!("cannot connect to {ENV_VAR}: {e}"));
    MIGRATED
        .get_or_init(|| async {
            Migrator::up(&db, None)
                .await
                .unwrap_or_else(|e| panic!("cannot migrate {ENV_VAR}: {e}"));
        })
        .await;
    Some(db)
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
            expires_at: Utc::now() + chrono::Duration::days(1),
        },
    )
    .await?;

    let holder = store::holder(
        &db,
        &TokenHash::of(minted.token.expose_secret()),
        Utc::now(),
    )
    .await?;
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
    assert_eq!(store::holder(&db, &minted.hash, Utc::now()).await?, None);
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
                expires_at: created_at + chrono::Duration::days(1),
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
                expires_at: Utc::now() + chrono::Duration::days(1),
            },
        )
        .await?;
    }

    let listed = store::list(&db, tenant).await?;

    assert_eq!(u64::try_from(listed.len())?, store::LIST_LIMIT);
    Ok(())
}

#[tokio::test]
#[ignore = "requires live MariaDB 11+; set INTEGRATION_TESTS_MARIADB_URL to enable"]
async fn a_token_stops_answering_when_it_expires() -> R {
    let Some(db) = connect_or_skip().await else {
        return Ok(());
    };
    let label = TokenLabel::parse("laptop")?;
    let minted = mint()?;
    let created_at = Utc::now().trunc_subsecs(0);
    let expires_at = created_at + chrono::Duration::days(1);

    store::insert(
        &db,
        NewToken {
            tenant_id: Uuid::now_v7(),
            person_id: Uuid::now_v7(),
            label: &label,
            created_by: Uuid::now_v7(),
            hash: &minted.hash,
            created_at,
            expires_at,
        },
    )
    .await?;

    let before =
        store::holder(&db, &minted.hash, expires_at - chrono::Duration::seconds(1)).await?;
    let at_expiry = store::holder(&db, &minted.hash, expires_at).await?;

    assert!(before.is_some(), "a token answers until it expires");
    assert_eq!(
        at_expiry, None,
        "an expired token answers like an unknown one"
    );
    Ok(())
}
