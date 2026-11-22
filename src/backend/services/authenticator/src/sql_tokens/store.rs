use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveValue::Set, ColumnTrait as _, ConnectionTrait, DbErr, EntityTrait as _, Order,
    QueryFilter as _, QueryOrder as _, QuerySelect as _,
};
use uuid::Uuid;

use super::entity::sql_api_tokens;
use super::{TokenHash, TokenHolder, TokenLabel};

pub(crate) const LIST_LIMIT: u64 = 1000;

#[derive(Debug)]
pub(crate) struct NewToken<'a> {
    pub(crate) tenant_id: Uuid,
    pub(crate) person_id: Uuid,
    pub(crate) label: &'a TokenLabel,
    pub(crate) created_by: Uuid,
    pub(crate) hash: &'a TokenHash,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
}

pub(crate) async fn insert(db: &impl ConnectionTrait, token: NewToken<'_>) -> Result<Uuid, DbErr> {
    let token_id = Uuid::now_v7();

    sql_api_tokens::Entity::insert(sql_api_tokens::ActiveModel {
        id: Set(token_id),
        insight_tenant_id: Set(token.tenant_id),
        token_hash: Set(token.hash.as_bytes().to_vec()),
        person_id: Set(token.person_id),
        label: Set(token.label.as_str().to_owned()),
        created_by: Set(token.created_by),
        created_at: Set(token.created_at),
        expires_at: Set(token.expires_at),
    })
    .exec(db)
    .await?;

    Ok(token_id)
}

pub(crate) async fn list(
    db: &impl ConnectionTrait,
    tenant_id: Uuid,
) -> Result<Vec<sql_api_tokens::Model>, DbErr> {
    sql_api_tokens::Entity::find()
        .filter(sql_api_tokens::Column::InsightTenantId.eq(tenant_id))
        .order_by(sql_api_tokens::Column::CreatedAt, Order::Desc)
        .order_by(sql_api_tokens::Column::Id, Order::Desc)
        .limit(LIST_LIMIT)
        .all(db)
        .await
}

pub(crate) async fn remove(
    db: &impl ConnectionTrait,
    tenant_id: Uuid,
    token_id: Uuid,
) -> Result<bool, DbErr> {
    let deleted = sql_api_tokens::Entity::delete_many()
        .filter(sql_api_tokens::Column::InsightTenantId.eq(tenant_id))
        .filter(sql_api_tokens::Column::Id.eq(token_id))
        .exec(db)
        .await?;

    Ok(deleted.rows_affected > 0)
}

pub(crate) async fn holder(
    db: &impl ConnectionTrait,
    hash: &TokenHash,
    at: DateTime<Utc>,
) -> Result<Option<TokenHolder>, DbErr> {
    let row = sql_api_tokens::Entity::find()
        .filter(sql_api_tokens::Column::TokenHash.eq(hash.as_bytes().to_vec()))
        .one(db)
        .await?;

    Ok(row
        .filter(|row| row.expires_at > at)
        .map(|row| TokenHolder {
            person_id: row.person_id,
            label: TokenLabel(row.label),
        }))
}
