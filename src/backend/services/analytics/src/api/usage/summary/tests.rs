use super::super::tests::{window_binds, window_params};
use super::*;

#[test]
fn every_caller_value_in_a_read_is_a_placeholder() {
    let binds = window_binds();
    for sql in [totals_sql(&binds, "V"), by_day_sql(&binds, "V")] {
        let rendered = sql.render();

        assert_eq!(rendered.params, window_params(&binds), "{}", rendered.sql);
        assert!(
            !rendered.sql.contains(&binds.tenant.to_string()) && !rendered.sql.contains("2026-"),
            "a read has interpolated a window value: {}",
            rendered.sql
        );
    }
}
