use serde_json::json;

use super::*;

fn metric() -> Metric {
    Metric::parse(json!({
        "dataset": "events",
        "fields": [
            { "field": "day", "type": "string", "as_name": "day" },
            { "field": "lines", "type": "int", "agg": "sum", "as_name": "total_lines" }
        ],
        "group_by": ["day"],
        "filters": []
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"))
}

const CLOCKED: bool = true;
const CLOCKLESS: bool = false;

fn widget(value: serde_json::Value) -> Widget {
    serde_json::from_value(value).unwrap_or_else(|error| panic!("the fixture parses: {error}"))
}

#[test]
fn every_kind_that_draws_two_columns_checks_both() {
    for kind in ["line", "bar", "area"] {
        let drawn = widget(json!({
            "type": kind, "metric": "lines_per_day", "x": "day", "y": "total_lines"
        }));
        assert!(
            drawn.check_against(&metric(), CLOCKLESS).is_ok(),
            "{kind} draws its metric"
        );

        let wrong = widget(json!({
            "type": kind, "metric": "lines_per_day", "x": "day", "y": "lines"
        }));
        assert!(
            matches!(
                wrong.check_against(&metric(), CLOCKLESS),
                Err(WidgetError::UnknownColumn { .. })
            ),
            "{kind} refuses a column the metric has not got"
        );
    }
}

fn stacked_metric() -> Metric {
    Metric::parse(json!({
        "dataset": "runs",
        "fields": [
            { "field": "outcome", "type": "string", "as_name": "outcome" },
            { "agg": "count", "type": "int", "as_name": "runs" }
        ],
        "group_by": ["bucket", "outcome"],
        "filters": []
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"))
}

#[test]
fn a_bar_stacks_by_a_column_its_metric_produces() {
    let drawn = widget(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "series": "outcome", "labels": true
    }));

    assert!(drawn.check_against(&stacked_metric(), CLOCKED).is_ok());
}

#[test]
fn a_bar_stacked_by_a_column_the_metric_does_not_produce_is_refused() {
    let drawn = widget(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "series": "severity"
    }));

    assert!(matches!(
        drawn.check_against(&stacked_metric(), CLOCKED),
        Err(WidgetError::UnknownColumn { ref column, .. }) if column == "severity"
    ));
}

#[test]
fn a_bar_says_whether_it_labels_its_totals_with_a_flag() {
    let refused: Result<Widget, _> = serde_json::from_value(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "labels": "on top"
    }));

    assert!(refused.is_err());
}

#[test]
fn a_bar_colours_its_series_values_with_named_tones() {
    let drawn = widget(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "series": "outcome",
        "colors": {
            "completed": "success", "gate_refused": "danger", "error": "warning",
            "submitted": "info", "aborted": "neutral"
        }
    }));

    assert!(drawn.check_against(&stacked_metric(), CLOCKED).is_ok());
}

#[test]
fn a_bar_colour_outside_the_named_tones_is_refused() {
    let refused: Result<Widget, _> = serde_json::from_value(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "series": "outcome", "colors": { "completed": "#00ff00" }
    }));

    assert!(refused.is_err());
}

#[test]
fn a_stat_reads_one_value() {
    let drawn = widget(json!({
        "type": "stat", "metric": "lines_per_day", "value": "total_lines", "label": "Lines"
    }));

    assert!(drawn.check_against(&metric(), CLOCKLESS).is_ok());
}

#[test]
fn a_chart_can_author_the_bucket_injected_by_a_clocked_metric() {
    let drawn = widget(json!({
        "type": "line", "metric": "events_over_time", "x": "bucket", "y": "total_lines"
    }));

    assert!(drawn.check_against(&metric(), CLOCKED).is_ok());
}

#[test]
fn a_clockless_metric_has_no_bucket_to_draw() {
    let drawn = widget(json!({
        "type": "line", "metric": "lines_per_day", "x": "bucket", "y": "total_lines"
    }));

    assert!(matches!(
        drawn.check_against(&metric(), CLOCKLESS),
        Err(WidgetError::UnknownColumn { .. })
    ));
}

#[test]
fn a_stat_naming_nothing_the_metric_returns_is_refused() {
    let drawn = widget(json!({
        "type": "stat", "metric": "lines_per_day", "value": "lines"
    }));

    assert!(matches!(
        drawn.check_against(&metric(), CLOCKLESS),
        Err(WidgetError::UnknownColumn { .. })
    ));
}

#[test]
fn a_pie_reads_a_label_and_a_value() {
    let drawn = widget(json!({
        "type": "pie", "metric": "lines_per_day", "label": "day", "value": "total_lines"
    }));

    assert!(drawn.check_against(&metric(), CLOCKLESS).is_ok());
}

#[test]
fn a_pie_whose_label_is_not_a_column_is_refused() {
    let drawn = widget(json!({
        "type": "pie", "metric": "lines_per_day", "label": "author", "value": "total_lines"
    }));

    assert!(matches!(
        drawn.check_against(&metric(), CLOCKLESS),
        Err(WidgetError::UnknownColumn { .. })
    ));
}

#[test]
fn a_kind_the_renderer_does_not_have_is_not_a_widget() {
    let refused: Result<Widget, _> = serde_json::from_value(json!({
        "type": "sankey", "metric": "lines_per_day", "x": "day", "y": "total_lines"
    }));

    assert!(refused.is_err());
}

#[test]
fn a_line_naming_the_metrics_own_columns_is_accepted() {
    let widget = widget(json!({
        "type": "line", "metric": "lines_per_day", "x": "day", "y": "total_lines"
    }));

    assert!(widget.check_against(&metric(), CLOCKLESS).is_ok());
}

#[test]
fn a_line_naming_the_raw_field_instead_of_the_alias_is_refused() {
    let widget = widget(json!({
        "type": "line", "metric": "lines_per_day", "x": "day", "y": "lines"
    }));

    let Err(error) = widget.check_against(&metric(), CLOCKLESS) else {
        panic!("a column the metric does not produce must be refused");
    };

    let message = error.to_string();
    assert!(message.contains("`lines` is not a column"), "{message}");
    assert!(message.contains("day, total_lines"), "{message}");
}

#[test]
fn a_table_column_the_metric_does_not_produce_is_refused() {
    let widget = widget(json!({
        "type": "table", "metric": "lines_per_day", "columns": ["day", "author"]
    }));

    assert!(widget.check_against(&metric(), CLOCKLESS).is_err());
}

#[test]
fn a_table_naming_no_columns_is_refused() {
    let widget = widget(json!({ "type": "table", "metric": "lines_per_day" }));

    let refusal = widget.check_against(&metric(), CLOCKLESS);

    assert!(
        matches!(refusal, Err(WidgetError::NoColumns)),
        "an empty column list renders an empty table: {refusal:?}"
    );
}

#[test]
fn a_table_drawing_every_column_it_names_is_accepted() {
    let widget = widget(json!({
        "type": "table", "metric": "lines_per_day", "columns": ["day", "total_lines"]
    }));

    assert!(widget.check_against(&metric(), CLOCKLESS).is_ok());
}

fn detail() -> MetricQuery {
    serde_json::from_value(json!({
        "dataset": "events",
        "fields": [
            { "field": "day", "type": "string", "as_name": "day" },
            { "field": "lines", "type": "int", "as_name": "lines" }
        ]
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"))
}

#[test]
fn a_detail_that_carries_the_column_a_bar_stands_for_is_accepted() {
    let drawn = widget(json!({
        "type": "bar", "metric": "lines_per_day", "detail": "line_events",
        "x": "day", "y": "total_lines"
    }));

    assert!(
        drawn
            .check_detail_against(&metric(), &detail(), CLOCKLESS)
            .is_ok()
    );
}

#[test]
fn a_detail_without_the_column_a_bar_stands_for_is_refused() {
    let drawn = widget(json!({
        "type": "bar", "metric": "lines_per_day", "detail": "line_events",
        "x": "author", "y": "total_lines"
    }));

    assert!(matches!(
        drawn.check_detail_against(&metric(), &detail(), CLOCKLESS),
        Err(WidgetError::DetailLacksColumn { ref column, ref detail, .. })
            if column == "author" && detail == "line_events"
    ));
}

#[test]
fn a_stat_stands_for_no_group_so_any_detail_narrows_it() {
    let drawn = widget(json!({
        "type": "stat", "metric": "lines_per_day", "detail": "line_events",
        "value": "total_lines"
    }));

    assert!(
        drawn
            .check_detail_against(&metric(), &detail(), CLOCKLESS)
            .is_ok()
    );
}

#[test]
fn a_chart_over_time_needs_a_detail_a_window_can_bucket() {
    let drawn = widget(json!({
        "type": "line", "metric": "events_over_time", "detail": "line_events",
        "x": "bucket", "y": "total_lines"
    }));

    assert!(
        drawn
            .check_detail_against(&metric(), &detail(), CLOCKED)
            .is_ok()
    );
    assert!(matches!(
        drawn.check_detail_against(&metric(), &detail(), CLOCKLESS),
        Err(WidgetError::DetailLacksColumn { .. })
    ));
}

#[test]
fn a_widget_names_its_detail_beside_its_metric_and_once_when_they_are_one() {
    let two = json!({ "type": "bar", "metric": "m", "detail": "d", "x": "a", "y": "b" });
    let one = json!({ "type": "bar", "metric": "m", "detail": "m", "x": "a", "y": "b" });

    assert_eq!(
        refers_to(&two),
        vec![
            Reference::new(DefinitionKind::Metric, "m"),
            Reference::new(DefinitionKind::Metric, "d"),
        ]
    );
    assert_eq!(
        refers_to(&one),
        vec![Reference::new(DefinitionKind::Metric, "m")]
    );
}

#[test]
fn renaming_a_metric_follows_it_into_the_detail() {
    let before = json!({ "type": "bar", "metric": "m", "detail": "old", "x": "a", "y": "b" });

    let after = rename_reference(before, "old", "new");

    assert_eq!(after["detail"], "new");
    assert_eq!(after["metric"], "m");
}

#[test]
fn a_table_narrows_its_detail_by_the_groups_it_draws_and_not_by_its_sums() {
    let drawn = widget(json!({
        "type": "table", "metric": "lines_per_day", "detail": "line_events",
        "columns": ["day", "total_lines"]
    }));

    assert!(
        drawn
            .check_detail_against(&metric(), &detail(), CLOCKLESS)
            .is_ok()
    );

    let elsewhere = widget(json!({
        "type": "table", "metric": "lines_per_day", "detail": "line_events",
        "columns": ["author", "total_lines"]
    }));
    assert!(
        elsewhere
            .check_detail_against(&metric(), &detail(), CLOCKLESS)
            .is_ok()
    );
}

#[test]
fn a_bar_stacks_to_a_hundred_percent_only_by_a_series() {
    let by_outcome = widget(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "series": "outcome", "stack": "percent"
    }));
    let by_nothing = widget(json!({
        "type": "bar", "metric": "runs_per_week", "x": "bucket", "y": "runs",
        "stack": "percent"
    }));

    assert!(by_outcome.check_against(&stacked_metric(), CLOCKED).is_ok());
    assert!(matches!(
        by_nothing.check_against(&stacked_metric(), CLOCKED),
        Err(WidgetError::StackWithoutSeries)
    ));
}

#[test]
fn a_line_and_an_area_draw_one_line_per_value_of_a_series_the_metric_produces() {
    for kind in ["line", "area"] {
        let by_outcome = widget(json!({
            "type": kind, "metric": "runs_per_week", "x": "bucket", "y": "runs",
            "series": "outcome"
        }));
        let by_severity = widget(json!({
            "type": kind, "metric": "runs_per_week", "x": "bucket", "y": "runs",
            "series": "severity"
        }));

        assert!(
            by_outcome.check_against(&stacked_metric(), CLOCKED).is_ok(),
            "{kind} draws a series its metric produces"
        );
        assert!(
            matches!(
                by_severity.check_against(&stacked_metric(), CLOCKED),
                Err(WidgetError::UnknownColumn { ref column, .. }) if column == "severity"
            ),
            "{kind} refuses a series its metric does not produce"
        );
    }
}

#[test]
fn the_options_of_a_chart_are_accepted_in_their_shape() {
    let accepted = [
        json!({ "type": "stat", "metric": "m", "value": "runs", "compare": {} }),
        json!({ "type": "stat", "metric": "m", "value": "runs", "compare": { "better": "lower" } }),
        json!({ "type": "stat", "metric": "m", "value": "runs", "compare": { "better": "neutral" } }),
        json!({ "type": "bar", "metric": "m", "x": "outcome", "y": "runs", "horizontal": true }),
        json!({ "type": "line", "metric": "m", "x": "bucket", "y": "runs",
                "target": { "value": 15, "label": "Goal" } }),
        json!({ "type": "area", "metric": "m", "x": "bucket", "y": "runs",
                "target": { "value": 2.5 } }),
        json!({ "type": "bar", "metric": "m", "x": "outcome", "y": "runs",
                "target": { "value": 15 } }),
    ];

    for body in accepted {
        let drawn: Result<Widget, _> = serde_json::from_value(body.clone());
        assert!(drawn.is_ok(), "should accept: {body}");
    }
}

#[test]
fn an_option_out_of_its_shape_is_not_a_widget() {
    let refused = [
        json!({ "type": "stat", "metric": "m", "value": "runs", "compare": true }),
        json!({ "type": "stat", "metric": "m", "value": "runs", "compare": { "better": "up" } }),
        json!({ "type": "stat", "metric": "m", "value": "runs", "compare": { "worse": "lower" } }),
        json!({ "type": "bar", "metric": "m", "x": "outcome", "y": "runs", "horizontal": "yes" }),
        json!({ "type": "bar", "metric": "m", "x": "outcome", "y": "runs", "series": "a",
                "stack": "absolute" }),
        json!({ "type": "line", "metric": "m", "x": "bucket", "y": "runs",
                "target": { "value": "high" } }),
        json!({ "type": "line", "metric": "m", "x": "bucket", "y": "runs",
                "target": { "label": "Goal" } }),
        json!({ "type": "area", "metric": "m", "x": "bucket", "y": "runs",
                "target": { "value": 1, "colour": "red" } }),
    ];

    for body in refused {
        let drawn: Result<Widget, _> = serde_json::from_value(body.clone());
        assert!(drawn.is_err(), "should refuse: {body}");
    }
}

fn funnel_metric() -> Metric {
    Metric::parse(json!({
        "dataset": "reviews",
        "fields": [
            { "agg": "count", "type": "int", "as_name": "opened" },
            { "agg": "count", "type": "int", "as_name": "reviewed" },
            { "agg": "count", "type": "int", "as_name": "merged" }
        ],
        "filters": []
    }))
    .unwrap_or_else(|error| panic!("the fixture parses: {error}"))
}

#[test]
fn each_new_kind_draws_the_columns_its_metric_produces() {
    let accepted = [
        json!({ "type": "heatmap", "metric": "m", "x": "outcome", "y": "bucket", "value": "runs" }),
        json!({ "type": "heatmap", "metric": "m", "x": "bucket", "value": "runs" }),
        json!({ "type": "treemap", "metric": "m", "label": "outcome", "value": "runs" }),
        json!({ "type": "treemap", "metric": "m", "label": "outcome", "value": "runs",
                "group": "bucket" }),
        json!({ "type": "scatter", "metric": "m", "x": "runs", "y": "runs" }),
        json!({ "type": "scatter", "metric": "m", "x": "bucket", "y": "runs", "size": "runs",
                "series": "outcome", "label": "outcome" }),
    ];

    for body in accepted {
        assert!(
            widget(body.clone())
                .check_against(&stacked_metric(), CLOCKED)
                .is_ok(),
            "should accept: {body}"
        );
    }
}

#[test]
fn each_column_a_new_kind_names_must_be_one_its_metric_produces() {
    let refused = [
        json!({ "type": "heatmap", "metric": "m", "x": "outcome", "y": "team", "value": "runs" }),
        json!({ "type": "heatmap", "metric": "m", "x": "outcome", "y": "bucket", "value": "team" }),
        json!({ "type": "treemap", "metric": "m", "label": "outcome", "value": "runs",
                "group": "team" }),
        json!({ "type": "scatter", "metric": "m", "x": "runs", "y": "runs", "size": "team" }),
        json!({ "type": "scatter", "metric": "m", "x": "runs", "y": "runs", "series": "team" }),
        json!({ "type": "scatter", "metric": "m", "x": "runs", "y": "runs", "label": "team" }),
        json!({ "type": "funnel", "metric": "m", "stages": ["runs", "team"] }),
    ];

    for body in refused {
        let checked = widget(body.clone()).check_against(&stacked_metric(), CLOCKED);
        assert!(
            matches!(checked, Err(WidgetError::UnknownColumn { ref column, .. }) if column == "team"),
            "should refuse: {body}: {checked:?}"
        );
    }
}

#[test]
fn a_heatmap_without_y_is_a_calendar_drawn_by_the_bucket() {
    let by_outcome = widget(json!({
        "type": "heatmap", "metric": "m", "x": "outcome", "value": "runs"
    }));

    assert!(matches!(
        by_outcome.check_against(&stacked_metric(), CLOCKED),
        Err(WidgetError::CalendarNotByBucket(ref column)) if column == "outcome"
    ));
}

#[test]
fn a_funnel_draws_two_to_twelve_stages_from_one_row() {
    let two = widget(json!({ "type": "funnel", "metric": "m", "stages": ["opened", "merged"] }));
    let three = widget(json!({
        "type": "funnel", "metric": "m", "stages": ["opened", "reviewed", "merged"]
    }));

    assert!(two.check_against(&funnel_metric(), CLOCKLESS).is_ok());
    assert!(three.check_against(&funnel_metric(), CLOCKLESS).is_ok());

    for count in [0, 1, 13] {
        let stages: Vec<String> = (0..count).map(|stage| format!("stage_{stage}")).collect();
        let drawn = widget(json!({ "type": "funnel", "metric": "m", "stages": stages }));

        assert!(
            matches!(
                drawn.check_against(&funnel_metric(), CLOCKLESS),
                Err(WidgetError::FunnelStages(named)) if named == count
            ),
            "should refuse {count} stages"
        );
    }
}

#[test]
fn a_funnel_names_each_stage_once() {
    let drawn = widget(json!({
        "type": "funnel", "metric": "m", "stages": ["opened", "merged", "opened"]
    }));

    assert!(matches!(
        drawn.check_against(&funnel_metric(), CLOCKLESS),
        Err(WidgetError::RepeatedStage(ref stage)) if stage == "opened"
    ));
}

#[test]
fn a_new_kind_narrows_its_detail_by_the_columns_it_stands_for() {
    let cases = [
        (
            json!({ "type": "heatmap", "x": "day", "y": "author", "value": "total_lines" }),
            "author",
        ),
        (
            json!({ "type": "treemap", "label": "day", "group": "author", "value": "total_lines" }),
            "author",
        ),
        (
            json!({ "type": "treemap", "label": "author", "value": "total_lines" }),
            "author",
        ),
        (
            json!({ "type": "scatter", "x": "total_lines", "y": "total_lines", "label": "author" }),
            "author",
        ),
        (
            json!({ "type": "scatter", "x": "total_lines", "y": "total_lines", "series": "author" }),
            "author",
        ),
    ];

    for (mut body, column) in cases {
        body["metric"] = json!("lines_per_day");
        body["detail"] = json!("line_events");
        let drawn: Widget = serde_json::from_value(body.clone())
            .unwrap_or_else(|error| panic!("the fixture parses: {error}"));

        assert!(
            matches!(
                drawn.check_detail_against(&metric(), &detail(), CLOCKLESS),
                Err(WidgetError::DetailLacksColumn { column: ref lacking, .. }) if lacking == column
            ),
            "should narrow by {column}: {body}"
        );
    }
}

#[test]
fn a_funnel_and_a_scatter_of_sums_stand_for_no_group_so_any_detail_narrows_them() {
    let cases = [
        json!({ "type": "funnel", "stages": ["day", "total_lines"] }),
        json!({ "type": "scatter", "x": "author", "y": "author", "size": "author" }),
    ];

    for mut body in cases {
        body["metric"] = json!("lines_per_day");
        body["detail"] = json!("line_events");
        let drawn: Widget = serde_json::from_value(body.clone())
            .unwrap_or_else(|error| panic!("the fixture parses: {error}"));

        assert!(
            drawn
                .check_detail_against(&metric(), &detail(), CLOCKLESS)
                .is_ok(),
            "should accept: {body}"
        );
    }
}
