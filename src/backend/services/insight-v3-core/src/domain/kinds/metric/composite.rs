use crate::domain::datasets::{self, Datasets, Ready};
use crate::domain::definition::{DefinitionKind, Lookup};
use crate::domain::kinds::KindError;
use crate::domain::kinds::metric::answerable::EffectiveClock;
use crate::domain::query::composite::{
    Admitted, Alias, Candidate, Composite, CompositeError, Stacked,
};
use crate::domain::query::metric::Metric;
use crate::domain::query::metric_query::over::Over;
use crate::domain::query::metric_query::{
    ColumnKind, CompiledQuery, MetricQuery, MetricRunError, MetricRunner, People, TableEngine,
};
use crate::domain::query::time_window::Window;

#[derive(Debug)]
pub(crate) struct Children {
    children: Vec<Child>,
    admitted: Admitted,
}

#[derive(Debug)]
struct Child {
    alias: Alias,
    query: MetricQuery,
    source: Source,
}

#[derive(Debug)]
enum Source {
    Dataset(Ready),
    Table(TableEngine),
}

impl Child {
    fn candidate(&self) -> Candidate<'_> {
        let declaration = match &self.source {
            Source::Dataset(ready) => Some(&ready.declaration),
            Source::Table(_) => None,
        };

        Candidate {
            alias: &self.alias,
            query: &self.query,
            kinds: self.query.column_kinds(declaration, false),
            dated: self.clock().is_some(),
        }
    }

    fn clock(&self) -> Option<EffectiveClock> {
        match &self.source {
            Source::Dataset(ready) => EffectiveClock::of(&self.query, &ready.declaration),
            Source::Table(_) => EffectiveClock::of_table(&self.query),
        }
    }
}

pub(crate) async fn children(
    composite: &Composite,
    definitions: &dyn Lookup,
    datasets: &dyn Datasets,
) -> Result<Children, KindError> {
    let mut children = Vec::with_capacity(composite.combine().len());

    for combined in composite.combine() {
        let alias = combined.alias.as_str();
        let Some(body) = definitions
            .get(DefinitionKind::Metric, &combined.metric)
            .await
            .map_err(KindError::Store)?
        else {
            return Err(KindError::Composite(CompositeError::Missing {
                alias: alias.to_owned(),
                metric: combined.metric.as_str().to_owned(),
            }));
        };
        let query = match Metric::parse(body) {
            Ok(Metric::Query(query)) => query,
            Ok(Metric::Composite(_)) => {
                return Err(KindError::Composite(CompositeError::Nested(
                    alias.to_owned(),
                )));
            }
            Err(error) => {
                return Err(KindError::Composite(CompositeError::Unreadable {
                    alias: alias.to_owned(),
                    reason: error.to_string(),
                }));
            }
        };
        let source = match query.dataset() {
            Some(named) => Source::Dataset(
                datasets::ready(datasets, named)
                    .await
                    .map_err(KindError::Datasets)?
                    .ok_or_else(|| KindError::DatasetNotReady(named.to_owned()))?,
            ),
            None => Source::Table(TableEngine::Other),
        };

        children.push(Child {
            alias: combined.alias.clone(),
            query,
            source,
        });
    }

    let candidates: Vec<Candidate<'_>> = children.iter().map(Child::candidate).collect();
    let admitted = composite.admit(&candidates).map_err(KindError::Composite)?;

    Ok(Children { children, admitted })
}

impl Children {
    pub(crate) fn dated(&self) -> bool {
        self.admitted.dated()
    }

    pub(crate) fn column_kinds(&self, clocked: bool) -> Vec<(String, ColumnKind)> {
        self.admitted.column_kinds(clocked)
    }

    pub(crate) fn clock(&self) -> Option<EffectiveClock> {
        if !self.dated() {
            return None;
        }

        self.children.first().and_then(Child::clock)
    }

    pub(crate) async fn read_engines(
        &mut self,
        runner: &MetricRunner,
    ) -> Result<(), MetricRunError> {
        for child in &mut self.children {
            if let Source::Table(engine) = &mut child.source {
                *engine = runner
                    .engine_of(child.query.database(), child.query.table_name())
                    .await?;
            }
        }

        Ok(())
    }

    pub(crate) fn compile(
        &self,
        composite: &Composite,
        people: &People,
        window: &Window,
        database: &str,
    ) -> Result<CompiledQuery, CompositeError> {
        let mut stacked = Vec::with_capacity(self.children.len());
        for child in &self.children {
            let (engine, over) = match &child.source {
                Source::Dataset(ready) => (
                    TableEngine::Other,
                    Some(Over {
                        declaration: &ready.declaration,
                        database,
                        table: &ready.table,
                    }),
                ),
                Source::Table(engine) => (*engine, None),
            };
            let compiled = child
                .query
                .compile_subquery(people, window, engine, over)
                .map_err(|source| CompositeError::Compile {
                    alias: child.alias.as_str().to_owned(),
                    source,
                })?;

            stacked.push(Stacked {
                alias: &child.alias,
                query: &child.query,
                compiled,
            });
        }

        Ok(composite.compile(&self.admitted, &stacked, window.grain().is_some()))
    }
}
