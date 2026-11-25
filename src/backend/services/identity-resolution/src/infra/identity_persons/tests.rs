use super::*;
use crate::domain::sync_service::PersonsLogRow;

#[test]
fn maps_log_row_preserving_micros_and_nulls() -> anyhow::Result<()> {
    let created = DateTime::parse_from_str("2026-07-29 12:34:56.123456", "%Y-%m-%d %H:%M:%S%.f")?;
    let row = PersonsLogRow {
        id: 9,
        value_type: "email".to_owned(),
        insight_source_type: "bamboohr".to_owned(),
        insight_source_id: Uuid::from_u128(1),
        insight_tenant_id: Uuid::from_u128(2),
        value_id: Some("a@example.com".to_owned()),
        value_full_text: None,
        value: None,
        value_effective: Some("a@example.com".to_owned()),
        person_id: Uuid::from_u128(3),
        author_person_id: Uuid::from_u128(4),
        reason: None,
        created_at: created,
    };
    let synced = DateTime::parse_from_str("2026-07-29 13:00:00", "%Y-%m-%d %H:%M:%S")?.and_utc();

    let wire = to_wire_row(&row, synced);

    assert_eq!(wire.id, 9);
    assert_eq!(wire.created_at.timestamp_subsec_micros(), 123_456);
    assert_eq!(wire.synced_at, synced);
    assert_eq!(wire.reason, None);
    Ok(())
}

fn writer(topology: Topology) -> ClickHouseIdentityPersonsWriter {
    ClickHouseIdentityPersonsWriter::connect("http://ch:8123", "", "", topology)
}

fn swap(state: Target) -> anyhow::Result<String> {
    Ok(writer(Topology::Standalone).client.ddl_sql(&swap_ddl(
        "identity_persons_staging_abc",
        TARGET,
        state,
    ))?)
}

fn replace() -> anyhow::Result<String> {
    Ok(writer(Topology::Standalone)
        .client
        .ddl_sql(&Ddl::replace_partition(
            DATABASE,
            TARGET,
            Uuid::from_u128(2),
            "identity_persons_staging_abc",
        ))?)
}

#[test]
fn a_published_table_is_swapped_for_atomically() -> anyhow::Result<()> {
    assert_eq!(
        swap(Target::Published)?,
        "EXCHANGE TABLES `identity`.`identity_persons_staging_abc` \
         AND `identity`.`identity_persons`"
    );
    Ok(())
}

#[test]
fn a_table_no_creator_has_made_yet_is_renamed_into_place() -> anyhow::Result<()> {
    assert_eq!(
        swap(Target::Absent)?,
        "RENAME TABLE `identity`.`identity_persons_staging_abc` \
         TO `identity`.`identity_persons`"
    );
    Ok(())
}

#[test]
fn a_clustered_install_stages_into_a_replicated_table() -> anyhow::Result<()> {
    let clustered = writer(Topology::new(true, "insight_cluster"))
        .client
        .ddl_sql(&staging_spec("identity_persons_staging_abc"))?;
    let standalone = writer(Topology::Standalone)
        .client
        .ddl_sql(&staging_spec("identity_persons_staging_abc"))?;

    assert!(
        clustered.ends_with(
            ") ENGINE = ReplicatedMergeTree PARTITION BY insight_tenant_id \
             ORDER BY (insight_tenant_id, id)"
        ),
        "{clustered}"
    );
    assert!(
        standalone.ends_with(
            ") ENGINE = MergeTree PARTITION BY insight_tenant_id ORDER BY (insight_tenant_id, id)"
        ),
        "{standalone}"
    );
    assert!(!clustered.contains("ON CLUSTER"), "{clustered}");
    Ok(())
}

#[test]
fn the_staging_table_is_the_shape_the_publish_expects() -> anyhow::Result<()> {
    let sql = writer(Topology::Standalone)
        .client
        .ddl_sql(&staging_spec("identity_persons_staging_abc"))?;

    assert!(
        sql.starts_with("CREATE TABLE `identity`.`identity_persons_staging_abc` ("),
        "{sql}"
    );
    for (name, data_type) in COLUMNS {
        assert!(
            sql.contains(&format!("\n    {name} {data_type}")),
            "`{name} {data_type}` must be declared: {sql}"
        );
    }
    Ok(())
}

#[test]
fn publishing_never_creates_the_table_dbt_owns() -> anyhow::Result<()> {
    for sql in [swap(Target::Published)?, swap(Target::Absent)?, replace()?] {
        assert!(
            !sql.contains("CREATE"),
            "the publish must not become a second creator: {sql}"
        );
    }
    Ok(())
}

fn keys(partition_key: &str, sorting_key: &str) -> TableKeys {
    TableKeys {
        partition_key: partition_key.to_owned(),
        sorting_key: sorting_key.to_owned(),
    }
}

fn columns(drop: Option<&str>, retype: Option<(&str, &str)>) -> Vec<TableColumn> {
    COLUMNS
        .iter()
        .filter(|(name, _)| Some(*name) != drop)
        .map(|(name, data_type)| TableColumn {
            name: (*name).to_owned(),
            data_type: match retype {
                Some((retyped, new_type)) if retyped == *name => new_type.to_owned(),
                _ => (*data_type).to_owned(),
            },
        })
        .collect()
}

#[test]
fn only_the_published_structure_takes_a_partition_replace() {
    let current = keys("insight_tenant_id", "insight_tenant_id, id");
    let cases = [
        (
            "current",
            &current,
            columns(None, None),
            Layout::Partitioned,
        ),
        (
            "unpartitioned",
            &keys("", "id"),
            columns(None, None),
            Layout::Stale,
        ),
        (
            "old sort key",
            &keys("insight_tenant_id", "id"),
            columns(None, None),
            Layout::Stale,
        ),
        (
            "missing column",
            &current,
            columns(Some("reason"), None),
            Layout::Stale,
        ),
        (
            "retyped column",
            &current,
            columns(None, Some(("value", "String"))),
            Layout::Stale,
        ),
    ];

    for (case, keys, columns, expected) in cases {
        assert_eq!(layout_of(keys, &columns), expected, "case: {case}");
    }
}
