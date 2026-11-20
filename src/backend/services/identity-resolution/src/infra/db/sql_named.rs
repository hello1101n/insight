//! SeaORM's `Statement` takes only positional `?` placeholders, so [`bind_named`]
//! rewrites each `@name` to a `?` and emits its bound value once per occurrence,
//! in left-to-right order.

use std::collections::HashMap;

use sea_orm::Value;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum BindError {
    #[error("no value is bound for @{0}")]
    Unbound(String),
    #[error("@{0} is bound but the SQL never uses it")]
    Unused(String),
    #[error("@{0} is bound more than once")]
    Duplicate(String),
}

pub fn bind_named<N: AsRef<str>>(
    sql: &str,
    params: &[(N, Value)],
) -> Result<(String, Vec<Value>), BindError> {
    let mut slots = HashMap::with_capacity(params.len());
    for (index, (name, _)) in params.iter().enumerate() {
        if slots.insert(name.as_ref(), index).is_some() {
            return Err(BindError::Duplicate(name.as_ref().to_owned()));
        }
    }

    let mut used = vec![false; params.len()];
    let mut out = String::with_capacity(sql.len());
    let mut values = Vec::new();
    let mut chars = sql.chars().peekable();

    while let Some(c) = chars.next() {
        if c != '@' {
            out.push(c);
            continue;
        }
        let mut name = String::new();
        while let Some(&next) = chars.peek() {
            if next.is_ascii_alphanumeric() || next == '_' {
                name.push(next);
                chars.next();
            } else {
                break;
            }
        }
        if name.is_empty() {
            out.push('@');
            continue;
        }
        let index = *slots
            .get(name.as_str())
            .ok_or_else(|| BindError::Unbound(name.clone()))?;
        used[index] = true;
        out.push('?');
        values.push(params[index].1.clone());
    }

    if let Some(index) = used.iter().position(|&bound| !bound) {
        return Err(BindError::Unused(params[index].0.as_ref().to_owned()));
    }
    Ok((out, values))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_repeated_params_in_order() -> anyhow::Result<()> {
        let sql = "SELECT * FROM t WHERE a = @tenant_id AND b = @x OR c = @tenant_id";
        let (out, values) = bind_named(
            sql,
            &[("tenant_id", Value::from(1_i32)), ("x", Value::from(2_i32))],
        )?;
        assert_eq!(out, "SELECT * FROM t WHERE a = ? AND b = ? OR c = ?");
        assert_eq!(values.len(), 3);
        assert_eq!(values[0], Value::from(1_i32));
        assert_eq!(values[1], Value::from(2_i32));
        assert_eq!(values[2], Value::from(1_i32));
        Ok(())
    }

    #[test]
    fn stops_identifier_at_non_word_char() -> anyhow::Result<()> {
        let (out, values) = bind_named(
            "@a,@b)",
            &[("a", Value::from(7_i32)), ("b", Value::from(8_i32))],
        )?;
        assert_eq!(out, "?,?)");
        assert_eq!(values, vec![Value::from(7_i32), Value::from(8_i32)]);
        Ok(())
    }

    #[test]
    fn passes_through_bare_at() -> anyhow::Result<()> {
        let (out, values) = bind_named::<&str>("a @ b", &[])?;
        assert_eq!(out, "a @ b");
        assert!(values.is_empty());
        Ok(())
    }

    #[test]
    fn a_placeholder_and_value_mismatch_is_refused() {
        let one = || Value::from(1_i32);
        for (case, sql, params, expected) in [
            (
                "a placeholder no value fills",
                "WHERE a = @a AND b = @b",
                vec![("a", one())],
                BindError::Unbound("b".to_owned()),
            ),
            (
                "a value no placeholder uses",
                "WHERE a = @a",
                vec![("a", one()), ("b", one())],
                BindError::Unused("b".to_owned()),
            ),
            (
                "a name bound twice",
                "WHERE a = @a",
                vec![("a", one()), ("a", Value::from(2_i32))],
                BindError::Duplicate("a".to_owned()),
            ),
        ] {
            assert_eq!(
                bind_named(sql, &params).err(),
                Some(expected),
                "should reject: {case}"
            );
        }
    }
}
