use std::collections::HashMap;

use serde::Deserialize;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSourceProvider {
    Github,
    Gitlab,
    BitbucketCloud,
    Jira,
    Youtrack,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExternalSourceConfig {
    pub id: String,
    pub provider: ExternalSourceProvider,
    pub web_base_url: String,
}

#[derive(Debug, Clone, Default)]
pub struct ExternalSourceRegistry {
    sources: HashMap<(ExternalSourceProvider, String), Url>,
}

#[derive(Debug, thiserror::Error)]
pub enum ExternalSourceRegistryError {
    #[error("external source id must be non-empty and trimmed")]
    InvalidId,
    #[error("external source provider and id must be unique")]
    DuplicateProviderAndId,
    #[error("external source web_base_url is not a valid URL")]
    InvalidWebBaseUrl(#[from] url::ParseError),
    #[error("external source web_base_url must be an absolute HTTP(S) URL")]
    InvalidWebBaseUrlSchemeOrHost,
    #[error("external source web_base_url must not include userinfo")]
    WebBaseUrlIncludesUserInfo,
    #[error("external source web_base_url must not include a query or fragment")]
    WebBaseUrlIncludesQueryOrFragment,
}

impl ExternalSourceRegistry {
    /// Reads the configured source systems into one lookup.
    ///
    /// # Errors
    /// An entry has an untrimmed or empty id, repeats a provider and id pair, or has a
    /// base URL that is not an absolute HTTP(S) URL without credentials, query or fragment.
    pub fn new(sources: &[ExternalSourceConfig]) -> Result<Self, ExternalSourceRegistryError> {
        let mut registry = HashMap::with_capacity(sources.len());
        for source in sources {
            let id = source.id.trim();
            if id.is_empty() || id != source.id {
                return Err(ExternalSourceRegistryError::InvalidId);
            }

            let url = parse_web_base_url(&source.web_base_url)?;
            let key = (source.provider, id.to_owned());
            if registry.insert(key, url).is_some() {
                return Err(ExternalSourceRegistryError::DuplicateProviderAndId);
            }
        }
        Ok(Self { sources: registry })
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    pub fn evidence_links(
        &self,
        provider: &str,
        source_id: &str,
        record_kind: &str,
        repository: Option<&str>,
        record_ref: Option<&str>,
    ) -> ExternalRecordLinks {
        let Some(provider) = parse_provider(provider) else {
            return ExternalRecordLinks::default();
        };
        let Some(base) = self.sources.get(&(provider, source_id.to_owned())) else {
            return ExternalRecordLinks::default();
        };

        let repository = repository.and_then(repository_segments);
        let repository_href = repository
            .as_deref()
            .and_then(|segments| repository_url(base, provider, segments));
        let record_link = record_url(
            base,
            provider,
            record_kind,
            repository.as_deref(),
            record_ref,
        );

        ExternalRecordLinks {
            repository: repository_href,
            record: record_link,
        }
    }

    #[must_use]
    pub fn repository_href(
        &self,
        provider: Option<&str>,
        source_id: Option<&str>,
        repository: Option<&str>,
    ) -> Option<String> {
        let provider = parse_provider(provider?)?;
        let source_id = source_id?.trim();
        let base = self.sources.get(&(provider, source_id.to_owned()))?;
        let repository = repository_segments(repository?)?;
        repository_url(base, provider, &repository)
    }
}

#[derive(Debug, Default)]
pub struct ExternalRecordLinks {
    pub repository: Option<String>,
    pub record: Option<String>,
}

fn parse_web_base_url(value: &str) -> Result<Url, ExternalSourceRegistryError> {
    let mut url = Url::parse(value.trim())?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(ExternalSourceRegistryError::InvalidWebBaseUrlSchemeOrHost);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ExternalSourceRegistryError::WebBaseUrlIncludesUserInfo);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ExternalSourceRegistryError::WebBaseUrlIncludesQueryOrFragment);
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url)
}

fn parse_provider(value: &str) -> Option<ExternalSourceProvider> {
    match value.trim() {
        "github" => Some(ExternalSourceProvider::Github),
        "gitlab" => Some(ExternalSourceProvider::Gitlab),
        "bitbucket_cloud" => Some(ExternalSourceProvider::BitbucketCloud),
        "jira" => Some(ExternalSourceProvider::Jira),
        "youtrack" => Some(ExternalSourceProvider::Youtrack),
        _ => None,
    }
}

fn repository_url(
    base: &Url,
    provider: ExternalSourceProvider,
    repository: &[&str],
) -> Option<String> {
    match provider {
        ExternalSourceProvider::Github
        | ExternalSourceProvider::Gitlab
        | ExternalSourceProvider::BitbucketCloud => {
            append_segments(base, repository.iter().copied())
        }
        ExternalSourceProvider::Jira | ExternalSourceProvider::Youtrack => None,
    }
}

fn record_url(
    base: &Url,
    provider: ExternalSourceProvider,
    record_kind: &str,
    repository: Option<&[&str]>,
    record_ref: Option<&str>,
) -> Option<String> {
    let record_ref = record_ref?.trim();
    match provider {
        ExternalSourceProvider::Github => match record_kind {
            "commit" => append_segments(
                base,
                repository?.iter().copied().chain(["commit", record_ref]),
            ),
            "pull_request" => append_segments(
                base,
                repository?.iter().copied().chain(["pull", record_ref]),
            ),
            "issue" => issue_url(base, &["issues"], record_ref),
            _ => None,
        },
        ExternalSourceProvider::Gitlab => match record_kind {
            "commit" => append_segments(
                base,
                repository?
                    .iter()
                    .copied()
                    .chain(["-", "commit", record_ref]),
            ),
            "pull_request" => append_segments(
                base,
                repository?
                    .iter()
                    .copied()
                    .chain(["-", "merge_requests", record_ref]),
            ),
            "issue" => issue_url(base, &["-", "issues"], record_ref),
            _ => None,
        },
        ExternalSourceProvider::BitbucketCloud => match record_kind {
            "commit" => append_segments(
                base,
                repository?.iter().copied().chain(["commits", record_ref]),
            ),
            "pull_request" => append_segments(
                base,
                repository?
                    .iter()
                    .copied()
                    .chain(["pull-requests", record_ref]),
            ),
            "issue" => issue_url(base, &["issues"], record_ref),
            _ => None,
        },
        ExternalSourceProvider::Jira => match record_kind {
            "issue" => append_segments(base, ["browse", record_ref]),
            _ => None,
        },
        ExternalSourceProvider::Youtrack => match record_kind {
            "issue" => append_segments(base, ["issue", record_ref]),
            _ => None,
        },
    }
}

fn issue_url(base: &Url, suffix: &[&str], record_ref: &str) -> Option<String> {
    let (repository, number) = record_ref.rsplit_once('#')?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let repository = repository_segments(repository)?;
    append_segments(
        base,
        repository
            .into_iter()
            .chain(suffix.iter().copied())
            .chain([number]),
    )
}

fn repository_segments(value: &str) -> Option<Vec<&str>> {
    let value = value.trim();
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() < 2 || segments.iter().any(|segment| !valid_segment(segment)) {
        return None;
    }
    Some(segments)
}

fn append_segments<'a>(base: &Url, segments: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut url = base.clone();
    let mut path = url.path_segments_mut().ok()?;
    for segment in segments {
        if !valid_segment(segment) {
            return None;
        }
        path.push(segment);
    }
    drop(path);
    Some(url.into())
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('/')
        && !segment.contains(':')
}

#[cfg(test)]
mod tests;
