use super::openapi_document;

#[test]
fn the_document_covers_every_route_this_service_serves() {
    let document = openapi_document().unwrap_or_else(|error| panic!("builds: {error}"));

    let paths: Vec<&str> = document.paths.paths.keys().map(String::as_str).collect();
    for expected in [
        "/v1/raw-data",
        "/v1/datasets",
        "/v1/datasets/{name}",
        "/v1/datasets/{name}/records",
        "/v1/datasets/{name}/dependents",
        "/v1/metrics",
        "/v1/metrics/{id}",
        "/v1/metrics/{id}/run",
        "/v1/metrics/{id}/drilldown",
        "/v1/metrics/{id}/dependents",
        "/v1/widgets",
        "/v1/dashboards",
        "/v1/dashboards/{id}/duplicate",
        "/v1/dashboards/{id}/tags",
        "/v1/dashboards/{id}/grants",
        "/v1/dashboards/{id}/grants/{grantee}",
        "/v1/dashboards/{id}/transfer",
        "/v1/dashboards/{id}/widgets",
        "/v1/dashboards/{id}/widgets/{widget_id}/run",
        "/v1/dashboards/{id}/widgets/{widget_id}/drilldown",
        "/v1/folders",
        "/v1/folders/{id}",
        "/v1/folders/{id}/grants",
        "/v1/folders/{id}/grants/{grantee}",
        "/v1/folders/{id}/dashboards/{dashboard_id}",
        "/v1/folders/{id}/transfer",
        "/v1/orphaned-dashboards",
        "/v1/orphaned-folders",
        "/v1/pins/{dashboard_id}",
        "/v1/personal-metrics",
        "/v1/personal-metrics/values",
        "/v1/personal-metrics/{id}/records",
        "/v1/chat",
    ] {
        assert!(
            paths.contains(&expected),
            "{expected} missing from {paths:?}"
        );
    }

    assert!(
        !paths.iter().any(|path| path.ends_with("/rename")),
        "no definition is renamed by route: {paths:?}"
    );
    for gone in ["/v1/dashboards/{id}/folder", "/v1/dashboards/{id}/shares"] {
        assert!(!paths.contains(&gone), "{gone} is still served");
    }
    assert_eq!(document.info.title, "Insight v3 Core API");
}

#[test]
fn a_grants_listing_says_who_reads_it() {
    let document = openapi_document().unwrap_or_else(|error| panic!("builds: {error}"));
    let summary = |path: &str| {
        document
            .paths
            .paths
            .get(path)
            .and_then(|item| item.get.as_ref())
            .and_then(|operation| operation.summary.clone())
            .unwrap_or_else(|| panic!("{path} lists its grants"))
    };

    assert_eq!(
        summary("/v1/metrics/{id}/grants"),
        "List the grants of a metric; administrators only"
    );
    assert_eq!(
        summary("/v1/dashboards/{id}/grants"),
        "List the grants of a dashboard the caller owns or edits"
    );
    assert_eq!(
        summary("/v1/folders/{id}/grants"),
        "List the grants of a folder the caller owns or edits"
    );
}
