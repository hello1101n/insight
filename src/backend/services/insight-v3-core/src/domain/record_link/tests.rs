use insight_external_sources::{ExternalSourceConfig, ExternalSourceProvider};
use serde_json::json;

use super::*;

fn source(id: &str, provider: ExternalSourceProvider, web_base_url: &str) -> ExternalSourceConfig {
    ExternalSourceConfig {
        id: id.to_owned(),
        provider,
        web_base_url: web_base_url.to_owned(),
    }
}

fn links() -> RecordLinks {
    let sources = ExternalSourceRegistry::new(&[
        source(
            "source-a",
            ExternalSourceProvider::Github,
            "https://git.example.com",
        ),
        source(
            "source-b",
            ExternalSourceProvider::Gitlab,
            "https://gitlab.example.com/",
        ),
        source(
            "tracker-a",
            ExternalSourceProvider::Youtrack,
            "https://tracker.example.com",
        ),
    ])
    .unwrap_or_else(|error| panic!("the sources must be valid: {error}"));

    RecordLinks::new(sources, "insight")
}

fn row(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(column, value)| (carried_column(column), value.clone()))
        .collect()
}

fn a_commit() -> Vec<(&'static str, Value)> {
    vec![
        ("data_source", json!("insight_github")),
        ("insight_source_id", json!("source-a")),
        ("project_key", json!("group")),
        ("repo_slug", json!("app")),
        ("commit_hash", json!("a1b2c3")),
    ]
}

fn without(pairs: &[(&'static str, Value)], column: &str) -> Vec<(&'static str, Value)> {
    pairs
        .iter()
        .filter(|(name, _)| *name != column)
        .cloned()
        .collect()
}

fn with(
    pairs: &[(&'static str, Value)],
    column: &'static str,
    value: Value,
) -> Vec<(&'static str, Value)> {
    let mut changed = without(pairs, column);
    changed.push((column, value));
    changed
}

#[test]
fn a_record_links_to_its_page_in_the_source_system() {
    let cases = [
        (
            "a commit",
            RecordRelation::Commit,
            a_commit(),
            "https://git.example.com/group/app/commit/a1b2c3",
        ),
        (
            "a merge request",
            RecordRelation::PullRequest,
            vec![
                ("data_source", json!("insight_gitlab")),
                ("insight_source_id", json!("source-b")),
                ("project_key", json!("group")),
                ("repo_slug", json!("app")),
                ("pr_number", json!("42")),
            ],
            "https://gitlab.example.com/group/app/-/merge_requests/42",
        ),
        (
            "a pull request of a repository with no project",
            RecordRelation::PullRequest,
            vec![
                ("data_source", json!("insight_github")),
                ("insight_source_id", json!("source-a")),
                ("project_key", json!("")),
                ("repo_slug", json!("group/app")),
                ("pr_number", json!("7")),
            ],
            "https://git.example.com/group/app/pull/7",
        ),
        (
            "an issue",
            RecordRelation::Issue,
            vec![
                ("data_source", json!("youtrack")),
                ("insight_source_id", json!("tracker-a")),
                ("id_readable", json!("APP-12")),
            ],
            "https://tracker.example.com/issue/APP-12",
        ),
    ];

    for (label, relation, pairs, expected) in cases {
        assert_eq!(
            links().link(relation, &row(&pairs)).as_deref(),
            Some(expected),
            "should link: {label}"
        );
    }
}

#[test]
fn a_record_the_registry_cannot_place_has_no_link() {
    let cases = [
        (
            "an unknown provider",
            with(&a_commit(), "data_source", json!("insight_svn")),
        ),
        (
            "an unknown source",
            with(&a_commit(), "insight_source_id", json!("source-z")),
        ),
        (
            "a source of another provider",
            with(&a_commit(), "data_source", json!("insight_gitlab")),
        ),
        ("a missing reference", without(&a_commit(), "commit_hash")),
        (
            "an empty reference",
            with(&a_commit(), "commit_hash", json!("")),
        ),
        (
            "a null source",
            with(&a_commit(), "insight_source_id", Value::Null),
        ),
        ("a missing repository", without(&a_commit(), "repo_slug")),
    ];

    for (label, pairs) in cases {
        assert_eq!(
            links().link(RecordRelation::Commit, &row(&pairs)),
            None,
            "should not link: {label}"
        );
    }
}

#[test]
fn only_the_record_relations_in_their_own_databases_carry_links() {
    let cases = [
        (
            Some("silver"),
            "class_git_commits",
            Some(RecordRelation::Commit),
        ),
        (
            Some("silver"),
            "class_git_pull_requests",
            Some(RecordRelation::PullRequest),
        ),
        (None, "task_issue_state", Some(RecordRelation::Issue)),
        (
            Some("insight"),
            "task_issue_state",
            Some(RecordRelation::Issue),
        ),
        (Some("silver"), "task_issue_state", None),
        (None, "class_git_commits", None),
        (Some("staging"), "class_git_commits", None),
        (Some("silver"), "class_git_ci_runs", None),
    ];

    for (database, table, expected) in cases {
        assert_eq!(
            links().relation_of(database, table),
            expected,
            "{database:?}.{table}"
        );
    }
}

#[test]
fn with_no_source_configured_no_relation_carries_links() {
    let unconfigured = RecordLinks::new(ExternalSourceRegistry::default(), "insight");

    assert_eq!(
        unconfigured.relation_of(Some("silver"), "class_git_commits"),
        None
    );
}
