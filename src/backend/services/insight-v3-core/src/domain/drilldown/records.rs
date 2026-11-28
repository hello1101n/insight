use super::{
    Column, DrilldownError, Drilldowns, Ordered, Page, Sort, columns_of, cursor, default_sort,
    page_size,
};
use crate::domain::access::PersonId;
use crate::domain::personal::PersonalMetric;
use crate::domain::query::metric_query::{MetricQuery, RECORD_TIME_COLUMN};
use crate::domain::query::time_window::Window;
use crate::domain::surfaces::CustomError;

const SELECTION: &str = "personal_records";

#[derive(Debug)]
pub(crate) struct Records {
    pub(crate) person: PersonId,
    pub(crate) window: Window,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: usize,
}

impl Drilldowns<'_> {
    pub(crate) async fn records(
        &self,
        personal_metric: &PersonalMetric,
        asked: &Records,
    ) -> Result<Page, DrilldownError> {
        page_size(asked.limit)?;

        let resume = asked.cursor.as_deref().map(cursor::decode).transpose()?;
        let query: MetricQuery = serde_json::from_value(personal_metric.body.clone())
            .map_err(|error| DrilldownError::Custom(CustomError::Body(error)))?;
        let reading = self
            .runs
            .reading(&query)
            .await
            .map_err(DrilldownError::Custom)?;
        let compiled = self
            .runs
            .compile_read(&reading, |people, engine, over| {
                query.personal_records(
                    &personal_metric.settings,
                    asked.person,
                    &asked.window,
                    people,
                    engine,
                    over,
                )
            })
            .map_err(DrilldownError::Custom)?;
        let columns = columns_of(
            &query.personal_record_kinds(reading.declaration()),
            &compiled,
        );

        let sort = newest_first(query.own_order(), &columns);
        let fingerprint = cursor::fingerprint(&(
            SELECTION,
            &personal_metric.id,
            &personal_metric.body,
            &personal_metric.settings,
            asked.person.to_string(),
            &asked.window,
            &sort,
            &columns,
        ));

        self.ordered(Ordered {
            compiled: &compiled,
            columns,
            sort,
            source: &reading.source(&query),
            window: &asked.window,
            fingerprint,
            resume,
            limit: asked.limit,
            relation: None,
        })
        .await
    }
}

pub(super) fn newest_first(own: Option<(&str, bool)>, columns: &[Column]) -> Sort {
    if columns
        .iter()
        .any(|column| column.key == RECORD_TIME_COLUMN)
    {
        return Sort {
            key: RECORD_TIME_COLUMN.to_owned(),
            descending: true,
        };
    }

    let own = own.map(|(key, descending)| (key.to_owned(), descending));

    default_sort(own.as_ref(), columns)
}
