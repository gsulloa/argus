//! Table-name normalization (dynamo-table-name-normalization).
//!
//! Folds a live physical DynamoDB table name into a stable logical name using a
//! per-connection [`TableMatch`] rule. Consumed by every Dynamo context lookup
//! and by schema-sync's write path.
//!
//! The transform is intentionally forgiving: an absent/empty rule, a rule that
//! fails to match, or a rule whose regex fails to compile all degrade to the
//! **identity** transform (the input name is returned unchanged). This
//! guarantees a misconfigured rule falls back to today's exact-match behavior
//! rather than hiding every doc.

use regex::Regex;

use crate::modules::dynamo::params::TableMatch;

/// Fold `name` to its logical form using `rule`.
///
/// * `None`/empty rule → `name` unchanged (identity).
/// * Advanced (`regex`) form → the `logical` named capture on match; otherwise
///   `name` unchanged.
/// * Simple form → strip `prefix` if present, then strip the end-anchored
///   `suffix_pattern` match; the residue is returned. A part that does not
///   apply is skipped.
pub fn normalize(name: &str, rule: Option<&TableMatch>) -> String {
    let rule = match rule {
        Some(r) if !r.is_effectively_empty() => r,
        _ => return name.to_string(),
    };

    // Advanced form: capture regex with a `logical` group.
    if let Some(re_str) = rule.regex.as_deref().filter(|s| !s.is_empty()) {
        return match Regex::new(re_str) {
            Ok(re) => re
                .captures(name)
                .and_then(|caps| caps.name("logical"))
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| name.to_string()),
            // Invalid regex (already rejected at save time) → identity.
            Err(_) => name.to_string(),
        };
    }

    // Simple form: prefix strip, then end-anchored suffix-pattern strip.
    let mut residue = name;
    if let Some(prefix) = rule.prefix.as_deref().filter(|s| !s.is_empty()) {
        if let Some(stripped) = residue.strip_prefix(prefix) {
            residue = stripped;
        }
    }

    let mut result = residue.to_string();
    if let Some(suffix) = rule.suffix_pattern.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(re) = Regex::new(suffix) {
            // Only strip a match that reaches the end of the string, so the
            // pattern behaves as a tail strip even when not explicitly anchored.
            let cut = re
                .find(&result)
                .filter(|m| m.end() == result.len())
                .map(|m| m.start());
            if let Some(start) = cut {
                result.truncate(start);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple(prefix: Option<&str>, suffix: Option<&str>) -> TableMatch {
        TableMatch {
            prefix: prefix.map(str::to_string),
            suffix_pattern: suffix.map(str::to_string),
            regex: None,
        }
    }

    fn advanced(re: &str) -> TableMatch {
        TableMatch {
            prefix: None,
            suffix_pattern: None,
            regex: Some(re.to_string()),
        }
    }

    // 1.5 — identity when no rule.
    #[test]
    fn identity_when_no_rule() {
        assert_eq!(normalize("Events", None), "Events");
    }

    // 1.5 — identity when empty rule.
    #[test]
    fn identity_when_empty_rule() {
        let rule = TableMatch::default();
        assert_eq!(normalize("Events", Some(&rule)), "Events");
    }

    // 1.5 — prefix + suffix strip to the logical name.
    #[test]
    fn prefix_and_suffix_strip() {
        let rule = simple(Some("MyApp-prod-"), Some("-[A-Z0-9]+$"));
        assert_eq!(
            normalize("MyApp-prod-EventsTable-3M4N5O6P7Q8R", Some(&rule)),
            "EventsTable"
        );
    }

    // 1.5 — capture regex returns the logical group.
    #[test]
    fn capture_regex_returns_logical_group() {
        let rule = advanced("^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$");
        assert_eq!(
            normalize("MyApp-prod-EventsTable-3M4N5O6P7Q8R", Some(&rule)),
            "EventsTable"
        );
    }

    // 1.5 — random suffix changes still normalize equal.
    #[test]
    fn changing_suffix_normalizes_equal() {
        let rule = simple(Some("MyApp-prod-"), Some("-[A-Z0-9]+$"));
        let a = normalize("MyApp-prod-EventsTable-3M4N5O6P7Q8R", Some(&rule));
        let b = normalize("MyApp-prod-EventsTable-9Z8Y7X6W5V4U", Some(&rule));
        assert_eq!(a, b);
        assert_eq!(a, "EventsTable");
    }

    // 1.5 — non-matching name degrades to identity (regex form).
    #[test]
    fn non_match_degrades_to_identity() {
        let rule = advanced("^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$");
        assert_eq!(normalize("SomeOtherTable", Some(&rule)), "SomeOtherTable");
    }

    // Prefix-only rule strips just the prefix.
    #[test]
    fn prefix_only() {
        let rule = simple(Some("MyApp-dev-"), None);
        assert_eq!(normalize("MyApp-dev-Events", Some(&rule)), "Events");
    }

    // Suffix-only rule strips just the tail.
    #[test]
    fn suffix_only() {
        let rule = simple(None, Some("-[A-Z0-9]+$"));
        assert_eq!(normalize("Events-AB12CD", Some(&rule)), "Events");
    }

    // Simple form where prefix does not apply leaves the name otherwise intact.
    #[test]
    fn simple_prefix_not_present_is_skipped() {
        let rule = simple(Some("Other-"), Some("-[A-Z0-9]+$"));
        assert_eq!(normalize("Events-AB12CD", Some(&rule)), "Events");
    }

    // Normalizing an already-logical name is idempotent (no suffix match).
    #[test]
    fn idempotent_on_logical_name() {
        let rule = simple(Some("MyApp-prod-"), Some("-[A-Z0-9]+$"));
        assert_eq!(normalize("EventsTable", Some(&rule)), "EventsTable");
    }
}
