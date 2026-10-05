//! Name validation and collision handling.

use std::collections::BTreeSet;

use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

/// Maximum number of Unicode scalar values in a stored item name.
pub const MAX_NAME_CHARS: usize = 255;
pub const DEFAULT_ITEM_NAME: &str = "Untitled";

/// Errors are intentionally free of the offending name so they are safe to
/// cross an IPC boundary or appear in a log.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum NameError {
    #[error("A name is required.")]
    Empty,
    #[error("The name is longer than 255 characters.")]
    TooLong,
    #[error("Names cannot contain '/'.")]
    ContainsSlash,
    #[error("Names cannot contain control characters.")]
    ContainsControl,
}

/// Trim and NFC-normalize a user supplied name, then enforce the v1 rules.
pub fn normalize_name(input: &str) -> Result<String, NameError> {
    let normalized: String = input.nfc().collect();
    let trimmed = normalized.trim();

    if trimmed.is_empty() {
        return Err(NameError::Empty);
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(NameError::TooLong);
    }
    if trimmed.contains('/') {
        return Err(NameError::ContainsSlash);
    }
    if trimmed.chars().any(char::is_control) {
        return Err(NameError::ContainsControl);
    }

    Ok(trimmed.to_owned())
}

/// Return the comparison form used for sibling uniqueness.
///
/// Rust's standard Unicode lowercase mapping is used after NFC normalization.
/// The stored spelling remains NFC and is never replaced by this key.
pub fn comparison_key(name: &str) -> String {
    name.nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .nfc()
        .collect()
}

/// Pick `base`, `base 2`, `base 3`, ... from a set of comparison keys.
pub(crate) fn first_numbered_name(base: &str, used: &BTreeSet<String>) -> String {
    if !used.contains(&comparison_key(base)) {
        return base.to_owned();
    }

    for number in 2usize.. {
        let suffix = format!(" {number}");
        let candidate = with_suffix(base, &suffix);
        if !used.contains(&comparison_key(&candidate)) {
            return candidate;
        }
    }

    unreachable!("the finite sibling set cannot occupy every numeric suffix")
}

/// Pick `base`, `base (2)`, `base (3)`, ... from a set of comparison keys.
pub(crate) fn first_parenthesized_name(base: &str, used: &BTreeSet<String>) -> String {
    if !used.contains(&comparison_key(base)) {
        return base.to_owned();
    }

    for number in 2usize.. {
        let suffix = format!(" ({number})");
        let candidate = with_suffix(base, &suffix);
        if !used.contains(&comparison_key(&candidate)) {
            return candidate;
        }
    }

    unreachable!("the finite sibling set cannot occupy every numeric suffix")
}

fn with_suffix(base: &str, suffix: &str) -> String {
    let suffix_len = suffix.chars().count();
    let keep = MAX_NAME_CHARS.saturating_sub(suffix_len);
    let mut result: String = base.chars().take(keep).collect();
    result.push_str(suffix);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_to_nfc_and_trims() {
        let name = normalize_name("  Cafe\u{301}  ").unwrap();
        assert_eq!(name, "Caf\u{e9}");
        assert_eq!(name.chars().count(), 4);
    }

    #[test]
    fn rejects_invalid_names_without_echoing_them() {
        assert_eq!(normalize_name(" \t "), Err(NameError::Empty));
        assert_eq!(normalize_name("a/b"), Err(NameError::ContainsSlash));
        assert_eq!(normalize_name("a\0b"), Err(NameError::ContainsControl));
        assert_eq!(
            normalize_name(&"x".repeat(MAX_NAME_CHARS + 1)),
            Err(NameError::TooLong)
        );
    }

    #[test]
    fn comparison_is_case_insensitive_and_normalized() {
        assert_eq!(comparison_key("\u{c9}COLE"), comparison_key("e\u{301}cole"));
    }

    #[test]
    fn suffixes_fit_the_limit() {
        let base = "x".repeat(MAX_NAME_CHARS);
        let mut used = BTreeSet::new();
        used.insert(comparison_key(&base));
        let chosen = first_parenthesized_name(&base, &used);
        assert_eq!(chosen.chars().count(), MAX_NAME_CHARS);
        assert!(chosen.ends_with(" (2)"));
    }
}
