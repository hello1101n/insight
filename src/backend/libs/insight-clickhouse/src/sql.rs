use std::fmt;

use chrono::NaiveDate;
use clickhouse::query::Query;
use uuid::Uuid;

// INVARIANT: SQL text never contains NUL. Thus the text of a template never
// matches the marker of a slot.
const MARK: char = '\0';

/// SQL text with the values that its placeholders name.
///
/// Make one with [`sql!`](crate::sql!). Run it with
/// [`Client::query_sql`](crate::Client::query_sql). A value exists only as a
/// placeholder in a fragment. Thus the server never gets text without its
/// values, or a value without its placeholder.
#[derive(Debug, Clone, Default)]
pub struct Sql {
    pieces: Vec<Piece>,
}

#[derive(Debug, Clone)]
enum Piece {
    Text(String),
    Param { name: &'static str, param: Param },
}

/// One value and the ClickHouse type that its placeholder declares.
#[derive(Debug, Clone, PartialEq)]
pub struct Param(Value);

#[derive(Debug, Clone, PartialEq)]
enum Value {
    String(String),
    Uuid(Uuid),
    Date(NaiveDate),
    Int64(i64),
    UInt64(u64),
    Float64(f64),
    Bool(bool),
    Strings(Vec<String>),
    Uuids(Vec<Uuid>),
}

/// The text of a fragment, with a name in each placeholder, and the value
/// that each name binds.
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub sql: String,
    pub params: Vec<(String, Param)>,
}

impl Sql {
    /// Text that goes into the query as SQL, unescaped. Only for text built
    /// from fixed keywords or validated identifiers, never from a caller value.
    #[must_use]
    pub fn raw(text: impl Into<String>) -> Sql {
        let mut sql = Sql::default();
        sql.push_text(&text.into());
        sql
    }

    pub fn push(&mut self, other: Sql) {
        self.pieces.extend(other.pieces);
    }

    #[must_use]
    pub fn join(parts: impl IntoIterator<Item = Sql>, separator: &str) -> Sql {
        let mut joined = Sql::default();
        for (index, part) in parts.into_iter().enumerate() {
            if index > 0 {
                joined.push_text(separator);
            }
            joined.push(part);
        }

        joined
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pieces
            .iter()
            .all(|piece| matches!(piece, Piece::Text(text) if text.is_empty()))
    }

    #[doc(hidden)]
    #[must_use]
    pub fn assemble(formatted: &str, slots: &[(&'static str, Sql)]) -> Sql {
        let mut assembled = Sql::default();
        let mut rest = formatted;

        while let Some(start) = rest.find(MARK) {
            let after = &rest[start + MARK.len_utf8()..];
            let slot = slots.iter().find(|(name, _)| {
                after
                    .strip_prefix(name)
                    .is_some_and(|tail| tail.starts_with(MARK))
            });
            let Some((name, fragment)) = slot else {
                assembled.push_text(&rest[..start + MARK.len_utf8()]);
                rest = after;
                continue;
            };

            assembled.push_text(&rest[..start]);
            assembled.pieces.extend(fragment.pieces.iter().cloned());
            rest = &after[name.len() + MARK.len_utf8()..];
        }
        assembled.push_text(rest);

        assembled
    }

    /// Returns the text and the parameters that
    /// [`Client::query_sql`](crate::Client::query_sql) sends. Placeholders with
    /// the same name and the same value use one parameter. A name that another
    /// value uses gets the next free `_<n>` suffix.
    #[must_use]
    pub fn render(&self) -> Rendered {
        let mut sql = String::new();
        let mut bound: Vec<(&'static str, String, &Param)> = Vec::new();

        for piece in &self.pieces {
            let (hint, param) = match piece {
                Piece::Text(text) => {
                    sql.push_str(text);
                    continue;
                }
                Piece::Param { name, param } => (*name, param),
            };

            let existing = bound.iter().position(|(bound_hint, _, bound_param)| {
                *bound_hint == hint && *bound_param == param
            });
            let index = existing.unwrap_or_else(|| {
                bound.push((hint, free_name(hint, &bound), param));
                bound.len() - 1
            });
            sql.push_str(&param.placeholder(&bound[index].1));
        }

        Rendered {
            sql,
            params: bound
                .into_iter()
                .map(|(_, name, param)| (name, param.clone()))
                .collect(),
        }
    }

    fn push_text(&mut self, text: &str) {
        if !text.is_empty() {
            self.pieces.push(Piece::Text(text.to_owned()));
        }
    }
}

fn free_name(hint: &str, bound: &[(&'static str, String, &Param)]) -> String {
    let taken = |candidate: &str| bound.iter().any(|(_, name, _)| name == candidate);

    let mut name = hint.to_owned();
    let mut suffix = 1_u32;
    while taken(&name) {
        name = format!("{hint}_{suffix}");
        suffix += 1;
    }

    name
}

impl Param {
    #[must_use]
    pub fn string(value: impl Into<String>) -> Self {
        Self(Value::String(value.into()))
    }

    #[must_use]
    pub fn uuid(value: Uuid) -> Self {
        Self(Value::Uuid(value))
    }

    #[must_use]
    pub fn date(value: NaiveDate) -> Self {
        Self(Value::Date(value))
    }

    #[must_use]
    pub fn int64(value: i64) -> Self {
        Self(Value::Int64(value))
    }

    #[must_use]
    pub fn uint64(value: u64) -> Self {
        Self(Value::UInt64(value))
    }

    #[must_use]
    pub fn float64(value: f64) -> Self {
        Self(Value::Float64(value))
    }

    #[must_use]
    pub fn bool(value: bool) -> Self {
        Self(Value::Bool(value))
    }

    #[must_use]
    pub fn strings<S: Into<String>>(values: impl IntoIterator<Item = S>) -> Self {
        Self(Value::Strings(values.into_iter().map(Into::into).collect()))
    }

    #[must_use]
    pub fn uuids(values: impl IntoIterator<Item = Uuid>) -> Self {
        Self(Value::Uuids(values.into_iter().collect()))
    }

    fn placeholder(&self, name: &str) -> String {
        let clickhouse_type = match &self.0 {
            Value::String(_) => "String",
            Value::Uuid(_) => "UUID",
            Value::Date(_) => "Date",
            Value::Int64(_) => "Int64",
            Value::UInt64(_) => "UInt64",
            // WORKAROUND: ClickHouse parses a Float64 parameter inexactly (1.14 arrives as 1.1400000000000001); its bits arrive exact.
            Value::Float64(_) => return format!("reinterpretAsFloat64({{{name}:UInt64}})"),
            Value::Bool(_) => "Bool",
            Value::Strings(_) => "Array(String)",
            Value::Uuids(_) => "Array(UUID)",
        };

        format!("{{{name}:{clickhouse_type}}}")
    }

    pub(crate) fn bind(&self, query: Query, name: &str) -> Query {
        match &self.0 {
            Value::String(value) => query.param(name, value),
            Value::Uuid(value) => query.param(name, value.to_string()),
            Value::Date(value) => query.param(name, value.to_string()),
            Value::Int64(value) => query.param(name, value),
            Value::UInt64(value) => query.param(name, value),
            Value::Float64(value) => query.param(name, value.to_bits()),
            Value::Bool(value) => query.param(name, value),
            Value::Strings(values) => query.param(name, values),
            Value::Uuids(values) => {
                let values: Vec<String> = values.iter().map(Uuid::to_string).collect();
                query.param(name, values)
            }
        }
    }
}

#[doc(hidden)]
pub trait Fragment {
    fn into_sql(self, name: &'static str) -> Sql;
}

impl Fragment for Sql {
    fn into_sql(self, _name: &'static str) -> Sql {
        self
    }
}

impl Fragment for Param {
    fn into_sql(self, name: &'static str) -> Sql {
        Sql {
            pieces: vec![Piece::Param { name, param: self }],
        }
    }
}

#[doc(hidden)]
#[derive(Debug)]
pub struct Marker(pub &'static str);

impl fmt::Display for Marker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{MARK}{}{MARK}", self.0)
    }
}

/// Makes a [`Sql`] fragment from a `format!` template.
///
/// A named argument is a [`Param`] or a [`Sql`] fragment. The query binds a
/// [`Param`] as the server-side parameter `{name:Type}`. A fragment goes into
/// the text with its values. `format!` refuses a named argument that the
/// template does not use. The template may name a `const` or `static` as SQL
/// text, but not a local variable, so a runtime value reaches the text only as
/// a named argument. Runtime text that is already safe SQL goes in through
/// [`Sql::raw`].
///
/// ```
/// use insight_clickhouse::{Param, Sql, sql};
///
/// const TABLE: &str = "t";
/// let tenant = uuid::Uuid::nil();
/// let scope = sql!("tenant_id = {tenant}", tenant = Param::uuid(tenant));
/// let query: Sql = sql!(
///     "SELECT count() FROM {TABLE} WHERE {scope} AND owner IN (SELECT id FROM u WHERE {tenant_scope})",
///     scope = scope,
///     tenant_scope = sql!("tenant_id = {tenant}", tenant = Param::uuid(tenant)),
/// );
/// ```
///
/// ```compile_fail,E0434
/// use insight_clickhouse::sql;
///
/// let search = String::from("x' OR 1 = 1 --");
/// let query = sql!("SELECT * FROM t WHERE name = '{search}'");
/// ```
#[macro_export]
macro_rules! sql {
    ($template:literal $(, $name:ident = $value:expr)* $(,)?) => {
        $crate::sql::Sql::assemble(
            &{
                // SAFETY: a fn item cannot capture locals, so the template can paste only items as SQL text.
                fn template() -> ::std::string::String {
                    ::std::format!($template $(, $name = $crate::sql::Marker(::std::stringify!($name)))*)
                }
                template()
            },
            &[$((
                ::std::stringify!($name),
                $crate::sql::Fragment::into_sql($value, ::std::stringify!($name)),
            )),*],
        )
    };
}

#[cfg(test)]
mod tests;
