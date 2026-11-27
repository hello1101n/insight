use insight_external_sources::ExternalSourceRegistry;
use serde_json::{Map, Value};

use super::query::metric_query::carried_column;

const SILVER_DATABASE: &str = "silver";
const PROVIDER_COLUMN: &str = "data_source";
const PROVIDER_PREFIX: &str = "insight_";
const GIT_REPOSITORY: Repository = Repository {
    project: "project_key",
    slug: "repo_slug",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordRelation {
    Commit,
    PullRequest,
    Issue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Home {
    Silver,
    Gold,
}

#[derive(Debug, Clone, Copy)]
struct Repository {
    project: &'static str,
    slug: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct Shape {
    home: Home,
    table: &'static str,
    kind: &'static str,
    source_id: &'static str,
    repository: Option<Repository>,
    reference: &'static str,
}

impl RecordRelation {
    const ALL: [Self; 3] = [Self::Commit, Self::PullRequest, Self::Issue];

    // INVARIANT: the repository and the reference are the values that the gold
    // evidence models write to `details`. Then both drilldowns link a record to one URL.
    fn shape(self) -> Shape {
        match self {
            Self::Commit => Shape {
                home: Home::Silver,
                table: "class_git_commits",
                kind: "commit",
                source_id: "source_id",
                repository: Some(GIT_REPOSITORY),
                reference: "commit_hash",
            },
            Self::PullRequest => Shape {
                home: Home::Silver,
                table: "class_git_pull_requests",
                kind: "pull_request",
                source_id: "source_id",
                repository: Some(GIT_REPOSITORY),
                reference: "pr_number",
            },
            Self::Issue => Shape {
                home: Home::Gold,
                table: "task_issue_state",
                kind: "issue",
                source_id: "insight_source_id",
                repository: None,
                reference: "id_readable",
            },
        }
    }

    pub(crate) fn keys(self) -> Vec<&'static str> {
        let shape = self.shape();
        let mut keys = vec![PROVIDER_COLUMN, shape.source_id, shape.reference];
        if let Some(repository) = shape.repository {
            keys.extend([repository.project, repository.slug]);
        }

        keys
    }
}

#[derive(Debug, Default)]
pub(crate) struct RecordLinks {
    sources: ExternalSourceRegistry,
    gold_database: String,
}

impl RecordLinks {
    pub(crate) fn new(sources: ExternalSourceRegistry, gold_database: &str) -> Self {
        Self {
            sources,
            gold_database: gold_database.to_owned(),
        }
    }

    pub(crate) fn relation_of(
        &self,
        database: Option<&str>,
        table: &str,
    ) -> Option<RecordRelation> {
        if self.sources.is_empty() {
            return None;
        }
        let database = database.unwrap_or(&self.gold_database);

        RecordRelation::ALL.into_iter().find(|relation| {
            let shape = relation.shape();
            let home = match shape.home {
                Home::Silver => SILVER_DATABASE,
                Home::Gold => self.gold_database.as_str(),
            };

            shape.table == table && home == database
        })
    }

    pub(crate) fn link(
        &self,
        relation: RecordRelation,
        row: &Map<String, Value>,
    ) -> Option<String> {
        let shape = relation.shape();
        let read = |column: &str| {
            row.get(&carried_column(column))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        };

        let provider = read(PROVIDER_COLUMN)?;
        let provider = provider.strip_prefix(PROVIDER_PREFIX).unwrap_or(provider);
        let source_id = read(shape.source_id)?;
        let repository = match shape.repository {
            Some(repository) => Some(repository_path(
                read(repository.project),
                read(repository.slug)?,
            )),
            None => None,
        };
        let reference = read(shape.reference)?;

        self.sources
            .evidence_links(
                provider,
                source_id,
                shape.kind,
                repository.as_deref(),
                Some(reference),
            )
            .record
    }
}

fn repository_path(project: Option<&str>, slug: &str) -> String {
    match project {
        Some(project) => format!("{project}/{slug}"),
        None => slug.to_owned(),
    }
}

#[cfg(test)]
mod tests;
