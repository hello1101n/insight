use secrecy::ExposeSecret as _;
use toolkit_security::crypto::hash::Sha256;

use super::*;

type R = Result<(), Box<dyn std::error::Error>>;

#[test]
fn a_minted_token_passes_the_sql_api_shape_check() -> R {
    let minted = mint()?;
    let token = minted.token.expose_secret();

    assert!(token.starts_with(TOKEN_PREFIX), "prefix missing: {token}");
    assert!(
        (32..=1024).contains(&token.len()),
        "length: {}",
        token.len()
    );
    assert!(
        token.bytes().all(|b| b.is_ascii_graphic()),
        "not printable ASCII: {token}"
    );
    Ok(())
}

#[test]
fn a_minted_token_is_stored_as_its_sha256() -> R {
    let minted = mint()?;

    let expected = Sha256::digest(minted.token.expose_secret().as_bytes());

    assert_eq!(minted.hash.as_bytes(), &expected);
    assert_eq!(TokenHash::of(minted.token.expose_secret()), minted.hash);
    Ok(())
}

#[test]
fn two_mints_never_share_a_token() -> R {
    let first = mint()?;
    let second = mint()?;

    assert_ne!(first.token.expose_secret(), second.token.expose_secret());
    assert_ne!(first.hash, second.hash);
    Ok(())
}

#[test]
fn a_label_is_trimmed_and_must_hold_text_within_its_column() {
    let at_budget = "x".repeat(LABEL_MAX_CHARS);
    let over_budget = "x".repeat(LABEL_MAX_CHARS + 1);
    let multibyte_at_budget = "é".repeat(LABEL_MAX_CHARS);

    for (raw, expected) in [
        ("  laptop  ", Ok("laptop")),
        (at_budget.as_str(), Ok(at_budget.as_str())),
        (
            multibyte_at_budget.as_str(),
            Ok(multibyte_at_budget.as_str()),
        ),
        ("lap\ntop", Err(LabelRejected::ControlCharacter)),
        ("lap\u{7}top", Err(LabelRejected::ControlCharacter)),
        ("", Err(LabelRejected::Empty)),
        ("   ", Err(LabelRejected::Empty)),
        (over_budget.as_str(), Err(LabelRejected::TooLong)),
    ] {
        let parsed = TokenLabel::parse(raw);
        assert_eq!(
            parsed.as_ref().map(TokenLabel::as_str).map_err(|e| *e),
            expected,
            "label case: {raw:?}"
        );
    }
}

#[test]
fn only_a_token_shaped_like_a_minted_one_is_worth_looking_up() -> R {
    let minted = mint()?;
    assert!(looks_minted(minted.token.expose_secret()));

    let body = "a".repeat(43);
    for (candidate, expected) in [
        (format!("isql_{body}"), true),
        (format!("isql_{}", "a".repeat(42)), false),
        (format!("isql_{}", "a".repeat(44)), false),
        (format!("isql_{}+", "a".repeat(42)), false),
        (format!("isqx_{body}"), false),
        (
            "synthetic-instance-token-0123456789abcdef".to_owned(),
            false,
        ),
    ] {
        assert_eq!(looks_minted(&candidate), expected, "candidate: {candidate}");
    }
    Ok(())
}
