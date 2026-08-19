//! Result-row cap resolution: combines the user-configured `sql.rowCap`
//! setting with an optional per-statement limit (e.g. a SQL `LIMIT`) and an
//! engine-specific ceiling to determine the effective cap applied to a query,
//! along with which of the three sources is responsible for that cap.

use crate::platform::settings;

/// Default cap applied when the `sql.rowCap` setting is absent or unparseable.
pub const DEFAULT_ROW_CAP: u64 = 10_000;
/// Absolute ceiling no setting or statement limit can exceed.
pub const HARD_ROW_CAP: u64 = 1_000_000;
/// Settings key holding the user-configured cap.
pub const SETTING_KEY: &str = "sql.rowCap";

/// Why the effective cap is what it is — and, by implication, whether raising
/// the `sql.rowCap` setting could change the outcome.
///
/// Note there is deliberately no `Statement` variant. A statement limit that
/// the engine honours in full never produces a truncated result (see
/// [`fetch_budget`]), so "the statement's own limit stopped us" is a state the
/// truncation banner can never render. A statement limit big enough to matter
/// is one that ran past [`HARD_ROW_CAP`], which reports [`RowCapSource::HardCeiling`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowCapSource {
    /// The configured `sql.rowCap` is the binding constraint. Raising it helps.
    Setting,
    /// [`HARD_ROW_CAP`] is the binding constraint. Raising the setting cannot help.
    HardCeiling,
    /// An engine's own ceiling below [`HARD_ROW_CAP`] is binding (CloudWatch's
    /// 10,000-record limit). Raising the setting cannot help.
    Engine,
}

/// How many rows to actually pull from the server for a given effective cap.
///
/// Always one more than the cap: fetching a single extra row is what lets us
/// distinguish "there were exactly `cap` rows" from "there were more than `cap`
/// and we stopped". Callers MUST return at most `cap` rows and set
/// `truncated = fetched > cap`.
///
/// Without this, a result that lands exactly on the cap is reported as
/// truncated — so `SELECT … LIMIT 30000` under an effective cap of 30,000 would
/// tell the user their complete result had been cut short, which is the exact
/// confusion this change exists to remove.
pub fn fetch_budget(cap: u64) -> u64 {
    cap.saturating_add(1)
}

/// Reads the configured `sql.rowCap` setting, falling back to
/// [`DEFAULT_ROW_CAP`] on a missing key, a read error, or a value that
/// fails to parse as `u64`. The result is always clamped to
/// `[1, HARD_ROW_CAP]`. Infallible.
pub fn configured_cap(conn: &rusqlite::Connection) -> u64 {
    settings::get(conn, SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_ROW_CAP)
        .clamp(1, HARD_ROW_CAP)
}

/// Combines the configured cap, an optional explicit (e.g. statement-level)
/// limit, and an engine ceiling into an effective cap plus the source that
/// determined it.
pub fn effective_cap(configured: u64, explicit: Option<u64>, engine_ceiling: u64) -> (u64, RowCapSource) {
    let requested = configured.max(explicit.unwrap_or(0));
    let cap = requested.min(engine_ceiling).max(1);

    let source = if cap < requested {
        // Something clamped us below what was asked for.
        if engine_ceiling < HARD_ROW_CAP {
            RowCapSource::Engine
        } else {
            RowCapSource::HardCeiling
        }
    } else if cap >= HARD_ROW_CAP {
        // Sitting exactly on the hard ceiling — raising the setting cannot help.
        RowCapSource::HardCeiling
    } else {
        RowCapSource::Setting
    };

    (cap, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::storage::open_in_memory;

    #[test]
    fn configured_cap_absent_key_defaults() {
        let conn = open_in_memory().unwrap();
        assert_eq!(configured_cap(&conn), DEFAULT_ROW_CAP);
    }

    #[test]
    fn configured_cap_empty_string_defaults() {
        let conn = open_in_memory().unwrap();
        settings::set(&conn, SETTING_KEY, "").unwrap();
        assert_eq!(configured_cap(&conn), DEFAULT_ROW_CAP);
    }

    #[test]
    fn configured_cap_unparseable_defaults() {
        let conn = open_in_memory().unwrap();
        settings::set(&conn, SETTING_KEY, "abc").unwrap();
        assert_eq!(configured_cap(&conn), DEFAULT_ROW_CAP);
    }

    #[test]
    fn configured_cap_zero_clamps_up_to_one() {
        let conn = open_in_memory().unwrap();
        settings::set(&conn, SETTING_KEY, "0").unwrap();
        assert_eq!(configured_cap(&conn), 1);
    }

    #[test]
    fn configured_cap_above_hard_ceiling_clamps_down() {
        let conn = open_in_memory().unwrap();
        settings::set(&conn, SETTING_KEY, "5000000").unwrap();
        assert_eq!(configured_cap(&conn), HARD_ROW_CAP);
    }

    #[test]
    fn configured_cap_within_range_parses() {
        let conn = open_in_memory().unwrap();
        settings::set(&conn, SETTING_KEY, "50000").unwrap();
        assert_eq!(configured_cap(&conn), 50_000);
    }

    #[test]
    fn configured_cap_at_hard_ceiling() {
        let conn = open_in_memory().unwrap();
        settings::set(&conn, SETTING_KEY, "1000000").unwrap();
        assert_eq!(configured_cap(&conn), HARD_ROW_CAP);
    }

    #[test]
    fn effective_cap_no_explicit_uses_configured() {
        assert_eq!(
            effective_cap(10_000, None, HARD_ROW_CAP),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn effective_cap_explicit_below_configured_never_lowers() {
        // A statement limit smaller than the configured cap does not lower
        // the effective cap, and does not count as the deciding source.
        assert_eq!(
            effective_cap(10_000, Some(5), HARD_ROW_CAP),
            (10_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn effective_cap_explicit_above_configured_raises_cap() {
        // The statement limit raises the cap. The source stays `Setting`
        // because the cap is not clamped by any ceiling — and this pairing is
        // never rendered anyway: an honoured limit does not truncate.
        assert_eq!(
            effective_cap(10_000, Some(30_000), HARD_ROW_CAP),
            (30_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn effective_cap_explicit_beyond_hard_ceiling_reports_hard_ceiling() {
        assert_eq!(
            effective_cap(10_000, Some(5_000_000), HARD_ROW_CAP),
            (1_000_000, RowCapSource::HardCeiling)
        );
    }

    #[test]
    fn effective_cap_setting_maxed_reports_hard_ceiling() {
        // The user set the maximum; "raise the limit" would be a lie.
        assert_eq!(
            effective_cap(HARD_ROW_CAP, None, HARD_ROW_CAP),
            (1_000_000, RowCapSource::HardCeiling)
        );
    }

    #[test]
    fn fetch_budget_is_one_past_the_cap() {
        assert_eq!(fetch_budget(10_000), 10_001);
        assert_eq!(fetch_budget(u64::MAX), u64::MAX);
    }

    #[test]
    fn effective_cap_cloudwatch_ceiling_below_configured() {
        assert_eq!(
            effective_cap(100_000, None, 10_000),
            (10_000, RowCapSource::Engine)
        );
    }

    #[test]
    fn effective_cap_cloudwatch_configured_below_ceiling() {
        assert_eq!(
            effective_cap(1_000, None, 10_000),
            (1_000, RowCapSource::Setting)
        );
    }

    #[test]
    fn effective_cap_cloudwatch_ignores_statement_limit() {
        assert_eq!(
            effective_cap(10_000, Some(30_000), 10_000),
            (10_000, RowCapSource::Engine)
        );
    }

    #[test]
    fn effective_cap_never_returns_zero() {
        assert_eq!(effective_cap(1, None, 0).0, 1);
    }
}
