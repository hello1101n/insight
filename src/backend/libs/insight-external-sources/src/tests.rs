use super::*;

fn sources() -> Vec<ExternalSourceConfig> {
    vec![
        ExternalSourceConfig {
            id: "github-source".to_owned(),
            provider: ExternalSourceProvider::Github,
            web_base_url: "https://github.example.test/".to_owned(),
        },
        ExternalSourceConfig {
            id: "jira-source".to_owned(),
            provider: ExternalSourceProvider::Jira,
            web_base_url: "https://issues.example.test/jira/".to_owned(),
        },
    ]
}

#[test]
fn resolves_git_repository_and_commit_links() -> anyhow::Result<()> {
    let registry = ExternalSourceRegistry::new(&sources())?;

    let links = registry.evidence_links(
        "github",
        "github-source",
        "commit",
        Some("group/repository"),
        Some("a1b2c3"),
    );

    assert_eq!(
        links.repository.as_deref(),
        Some("https://github.example.test/group/repository")
    );
    assert_eq!(
        links.record.as_deref(),
        Some("https://github.example.test/group/repository/commit/a1b2c3")
    );
    Ok(())
}

#[test]
fn resolves_jira_issue_link() -> anyhow::Result<()> {
    let registry = ExternalSourceRegistry::new(&sources())?;

    let links = registry.evidence_links("jira", "jira-source", "issue", None, Some("OPS-42"));

    assert_eq!(
        links.record.as_deref(),
        Some("https://issues.example.test/jira/browse/OPS-42")
    );
    Ok(())
}

#[test]
fn resolves_provider_specific_record_routes() -> anyhow::Result<()> {
    let entries = [
        ExternalSourceConfig {
            id: "github-source".to_owned(),
            provider: ExternalSourceProvider::Github,
            web_base_url: "https://github.example.test".to_owned(),
        },
        ExternalSourceConfig {
            id: "gitlab-source".to_owned(),
            provider: ExternalSourceProvider::Gitlab,
            web_base_url: "https://gitlab.example.test".to_owned(),
        },
        ExternalSourceConfig {
            id: "bitbucket-source".to_owned(),
            provider: ExternalSourceProvider::BitbucketCloud,
            web_base_url: "https://bitbucket.example.test".to_owned(),
        },
        ExternalSourceConfig {
            id: "youtrack-source".to_owned(),
            provider: ExternalSourceProvider::Youtrack,
            web_base_url: "https://tracker.example.test/youtrack".to_owned(),
        },
    ];
    let registry = ExternalSourceRegistry::new(&entries)?;

    for (provider, source_id, kind, repository, reference, expected) in [
        (
            "github",
            "github-source",
            "issue",
            None,
            "group/repository#42",
            "https://github.example.test/group/repository/issues/42",
        ),
        (
            "gitlab",
            "gitlab-source",
            "commit",
            Some("group/subgroup/repository"),
            "abc123",
            "https://gitlab.example.test/group/subgroup/repository/-/commit/abc123",
        ),
        (
            "gitlab",
            "gitlab-source",
            "pull_request",
            Some("group/subgroup/repository"),
            "42",
            "https://gitlab.example.test/group/subgroup/repository/-/merge_requests/42",
        ),
        (
            "gitlab",
            "gitlab-source",
            "issue",
            None,
            "group/subgroup/repository#42",
            "https://gitlab.example.test/group/subgroup/repository/-/issues/42",
        ),
        (
            "bitbucket_cloud",
            "bitbucket-source",
            "commit",
            Some("workspace/repository"),
            "abc123",
            "https://bitbucket.example.test/workspace/repository/commits/abc123",
        ),
        (
            "bitbucket_cloud",
            "bitbucket-source",
            "pull_request",
            Some("workspace/repository"),
            "42",
            "https://bitbucket.example.test/workspace/repository/pull-requests/42",
        ),
        (
            "bitbucket_cloud",
            "bitbucket-source",
            "issue",
            None,
            "workspace/repository#42",
            "https://bitbucket.example.test/workspace/repository/issues/42",
        ),
        (
            "youtrack",
            "youtrack-source",
            "issue",
            None,
            "APP-42",
            "https://tracker.example.test/youtrack/issue/APP-42",
        ),
    ] {
        let links = registry.evidence_links(provider, source_id, kind, repository, Some(reference));

        assert_eq!(
            links.record.as_deref(),
            Some(expected),
            "should resolve: {provider}"
        );
    }
    Ok(())
}

#[test]
fn rejects_duplicate_provider_and_id() {
    let mut entries = sources();
    entries.push(ExternalSourceConfig {
        id: "github-source".to_owned(),
        provider: ExternalSourceProvider::Github,
        web_base_url: "https://alternate.example.test".to_owned(),
    });

    assert!(matches!(
        ExternalSourceRegistry::new(&entries),
        Err(ExternalSourceRegistryError::DuplicateProviderAndId)
    ));
}

#[test]
fn reports_invalid_ids_and_unparseable_urls() {
    let invalid_id = ExternalSourceConfig {
        id: " github-source".to_owned(),
        provider: ExternalSourceProvider::Github,
        web_base_url: "https://github.example.test".to_owned(),
    };
    assert!(matches!(
        ExternalSourceRegistry::new(&[invalid_id]),
        Err(ExternalSourceRegistryError::InvalidId)
    ));

    let invalid_url = ExternalSourceConfig {
        id: "github-source".to_owned(),
        provider: ExternalSourceProvider::Github,
        web_base_url: "://".to_owned(),
    };
    assert!(matches!(
        ExternalSourceRegistry::new(&[invalid_url]),
        Err(ExternalSourceRegistryError::InvalidWebBaseUrl(_))
    ));
}

#[test]
fn rejects_unsafe_web_base_urls() {
    for web_base_url in [
        "github.example.test",
        "ftp://github.example.test",
        "https://user@github.example.test",
        "https://github.example.test?query=yes",
        "https://github.example.test#fragment",
    ] {
        let entry = ExternalSourceConfig {
            id: "source".to_owned(),
            provider: ExternalSourceProvider::Github,
            web_base_url: web_base_url.to_owned(),
        };

        assert!(
            ExternalSourceRegistry::new(&[entry]).is_err(),
            "should reject: {web_base_url}"
        );
    }
}

#[test]
fn refuses_links_without_valid_context() -> anyhow::Result<()> {
    let registry = ExternalSourceRegistry::new(&sources())?;

    for (provider, source_id, kind, repository, reference) in [
        (
            "github",
            "missing-source",
            "commit",
            Some("group/repository"),
            Some("a1b2c3"),
        ),
        (
            "github",
            "github-source",
            "commit",
            Some("source-a:group/repository"),
            Some("a1b2c3"),
        ),
        (
            "github",
            "github-source",
            "commit",
            Some("repository"),
            Some("a1b2c3"),
        ),
        (
            "github",
            "github-source",
            "commit",
            Some("group/../repository"),
            Some("a1b2c3"),
        ),
        (
            "github",
            "github-source",
            "commit",
            Some("group/./repository"),
            Some("a1b2c3"),
        ),
        (
            "github",
            "github-source",
            "commit",
            Some("group/repository"),
            Some(""),
        ),
        (
            "github",
            "github-source",
            "issue",
            None,
            Some("not-an-issue-ref"),
        ),
        (
            "github",
            "github-source",
            "unsupported",
            Some("group/repository"),
            Some("42"),
        ),
    ] {
        let links = registry.evidence_links(provider, source_id, kind, repository, reference);

        assert!(links.record.is_none(), "should reject: {kind}");
    }
    Ok(())
}
