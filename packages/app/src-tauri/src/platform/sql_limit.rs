//! Conservative, hand-rolled detection of an *explicit* row limit already
//! present in a SQL statement (`LIMIT`, `TOP`, `FETCH FIRST/NEXT … ROWS
//! ONLY`, …), so the row-cap resolver in [`crate::platform::row_cap`] can
//! raise the effective cap above the configured setting when the statement
//! already bounds itself.
//!
//! This is deliberately NOT a SQL parser. It is a two-pass scanner:
//!
//! 1. [`tokenize`] walks the statement once, discarding whitespace, comments,
//!    string/identifier literals, and anything inside parentheses — except
//!    for the single carve-out of a parenthesized lone integer (`TOP (25000)`),
//!    which is emitted as [`Token::ParenInt`] at depth 0. Everything at
//!    parenthesis depth > 0 is invisible to pass 2, which is what makes a
//!    `LIMIT` inside a subquery invisible to the caller.
//! 2. The dialect-specific `*_limit` functions pattern-match the resulting
//!    token stream from the end, returning `None` for any shape they cannot
//!    resolve unambiguously. False negatives (returning `None` when a limit
//!    really is present) are acceptable — the configured cap still applies.
//!    False positives are not: they would silently let a runaway query far
//!    past the intended cap.

/// SQL dialect the scanner should apply comment/quoting/limit-syntax rules
/// for. `Presto` covers both Presto and Athena (identical LIMIT syntax).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    MySql,
    TSql,
    Presto,
}

/// A significant token at parenthesis depth 0. `Word` text is lowercased so
/// keyword comparisons are case-insensitive; digit runs are unaffected by
/// lowercasing, so the same field also serves integer parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Word(String),
    Punct(char),
    /// A parenthesized group whose entire (trimmed) contents were a single
    /// integer literal, e.g. the `(25000)` in `TOP (25000)`. Emitted at
    /// depth 0 in place of the whole `( … )` group.
    ParenInt(u64),
}

/// Scanner sub-state used while walking the statement byte-by-byte (well,
/// char-by-char — see [`tokenize`]'s doc comment for why).
#[derive(Debug, Clone)]
enum Mode {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    Bracket,
    Dollar(String),
    LineComment,
    /// Depth-tracked so nested `/* /* … */ */` blocks close correctly.
    BlockComment(u32),
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '@' || c == '$'
}

fn flush_word(word: &mut String, tokens: &mut Vec<Token>) {
    if !word.is_empty() {
        tokens.push(Token::Word(std::mem::take(word).to_lowercase()));
    }
}

/// Try to read a Postgres dollar-quote tag opener starting at `chars[i]`
/// (which must be `'$'`). Returns the tag (empty for `$$`) and the index
/// just past the opening delimiter's closing `$`, or `None` if this isn't a
/// valid opener (e.g. a bind parameter like `$1` with no matching `$`).
fn read_dollar_tag(chars: &[char], i: usize) -> Option<(String, usize)> {
    if chars.get(i) != Some(&'$') {
        return None;
    }
    let mut j = i + 1;
    while j < chars.len() {
        let c = chars[j];
        if c == '$' {
            let tag: String = chars[i + 1..j].iter().collect();
            return Some((tag, j + 1));
        }
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        j += 1;
    }
    None
}

/// Pass 1: tokenize `sql` into the significant tokens at parenthesis depth 0.
///
/// Iterates over `char`s (not bytes) so multi-byte UTF-8 content inside
/// strings/comments/identifiers can never be misinterpreted as ASCII
/// punctuation — unlike a byte-indexed scan, which would have to special-case
/// continuation bytes.
fn tokenize(sql: &str, dialect: Dialect) -> Vec<Token> {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut i = 0usize;
    let mut mode = Mode::Normal;
    let mut tokens: Vec<Token> = Vec::new();
    let mut depth: u32 = 0;
    // Byte (char-index) offset of the first character inside the outermost
    // tracked paren group, i.e. the position right after its opening `(`.
    // `None` when depth == 0.
    let mut capture_start: Option<usize> = None;
    let mut word = String::new();

    while i < n {
        let c = chars[i];
        match &mode {
            Mode::Normal => {
                // Comments (checked before quotes/words so e.g. `--` always
                // wins over being parsed as two punctuation tokens).
                if c == '-' && i + 1 < n && chars[i + 1] == '-' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::LineComment;
                    i += 2;
                    continue;
                }
                if dialect == Dialect::MySql && c == '#' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::LineComment;
                    i += 1;
                    continue;
                }
                if c == '/' && i + 1 < n && chars[i + 1] == '*' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::BlockComment(1);
                    i += 2;
                    continue;
                }
                // String / identifier literals.
                if c == '\'' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::SingleQuote;
                    i += 1;
                    continue;
                }
                if c == '"' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::DoubleQuote;
                    i += 1;
                    continue;
                }
                if dialect == Dialect::MySql && c == '`' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::Backtick;
                    i += 1;
                    continue;
                }
                if dialect == Dialect::TSql && c == '[' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                    }
                    mode = Mode::Bracket;
                    i += 1;
                    continue;
                }
                if dialect == Dialect::Postgres && c == '$' {
                    if let Some((tag, next)) = read_dollar_tag(&chars, i) {
                        if depth == 0 {
                            flush_word(&mut word, &mut tokens);
                        }
                        mode = Mode::Dollar(tag);
                        i = next;
                        continue;
                    }
                    // Not a valid dollar-quote opener (e.g. `$1` bind param)
                    // — fall through to the generic word-char handling below.
                }
                // Parenthesis depth tracking (only reachable outside all
                // quoting/comment states, since those branches `continue`
                // before reaching here).
                if c == '(' {
                    if depth == 0 {
                        flush_word(&mut word, &mut tokens);
                        capture_start = Some(i + 1);
                    }
                    depth += 1;
                    i += 1;
                    continue;
                }
                if c == ')' {
                    if depth == 0 {
                        // Unbalanced close-paren in otherwise-invalid SQL —
                        // ignore rather than underflow.
                        i += 1;
                        continue;
                    }
                    depth -= 1;
                    if depth == 0 {
                        if let Some(start) = capture_start.take() {
                            let inner: String = chars[start..i].iter().collect();
                            let trimmed = inner.trim();
                            if !trimmed.is_empty()
                                && trimmed.chars().all(|ch| ch.is_ascii_digit())
                            {
                                if let Ok(v) = trimmed.parse::<u64>() {
                                    tokens.push(Token::ParenInt(v));
                                }
                            }
                        }
                    }
                    i += 1;
                    continue;
                }
                if depth > 0 {
                    // Discarded — this is what makes subquery/expression
                    // content at depth > 0 invisible to pass 2.
                    i += 1;
                    continue;
                }
                if is_word_char(c) {
                    word.push(c);
                    i += 1;
                    continue;
                }
                if c.is_whitespace() {
                    flush_word(&mut word, &mut tokens);
                    i += 1;
                    continue;
                }
                flush_word(&mut word, &mut tokens);
                tokens.push(Token::Punct(c));
                i += 1;
            }
            Mode::SingleQuote => {
                if c == '\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if c == '\'' {
                    if i + 1 < n && chars[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    mode = Mode::Normal;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            Mode::DoubleQuote => {
                if c == '\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if c == '"' {
                    if i + 1 < n && chars[i + 1] == '"' {
                        i += 2;
                        continue;
                    }
                    mode = Mode::Normal;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            Mode::Backtick => {
                if c == '`' {
                    if i + 1 < n && chars[i + 1] == '`' {
                        i += 2;
                        continue;
                    }
                    mode = Mode::Normal;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            Mode::Bracket => {
                if c == ']' {
                    if i + 1 < n && chars[i + 1] == ']' {
                        i += 2;
                        continue;
                    }
                    mode = Mode::Normal;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            Mode::Dollar(tag) => {
                if c == '$' {
                    let delim_len = tag.chars().count() + 2;
                    if i + delim_len <= n {
                        let candidate: String = chars[i..i + delim_len].iter().collect();
                        if candidate == format!("${}$", tag) {
                            i += delim_len;
                            mode = Mode::Normal;
                            continue;
                        }
                    }
                }
                i += 1;
            }
            Mode::LineComment => {
                if c == '\n' {
                    mode = Mode::Normal;
                }
                i += 1;
            }
            Mode::BlockComment(depth_bc) => {
                let depth_bc = *depth_bc;
                if c == '/' && i + 1 < n && chars[i + 1] == '*' {
                    mode = Mode::BlockComment(depth_bc + 1);
                    i += 2;
                    continue;
                }
                if c == '*' && i + 1 < n && chars[i + 1] == '/' {
                    mode = if depth_bc > 1 {
                        Mode::BlockComment(depth_bc - 1)
                    } else {
                        Mode::Normal
                    };
                    i += 2;
                    continue;
                }
                i += 1;
            }
        }
    }
    // A statement can't end mid-paren-capture in valid SQL, but if it does
    // (unbalanced input), just drop it — nothing to emit either way.
    flush_word(&mut word, &mut tokens);
    tokens
}

/// Interpret a token as an integer, if it plausibly is one. `ParenInt` is
/// already numeric; a `Word` counts only when every character is an ASCII
/// digit (rejects `$1`, `@n`, `all`, `null`, …).
fn as_int(tok: &Token) -> Option<u64> {
    match tok {
        Token::ParenInt(v) => Some(*v),
        Token::Word(w) => {
            if !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit()) {
                w.parse::<u64>().ok()
            } else {
                None
            }
        }
        Token::Punct(_) => None,
    }
}

fn word_eq(tok: &Token, s: &str) -> bool {
    matches!(tok, Token::Word(w) if w == s)
}

/// Postgres and Presto/Athena share `LIMIT`/`OFFSET` syntax; only Postgres
/// additionally recognizes the SQL-standard `FETCH FIRST/NEXT … ROWS ONLY`.
fn postgres_presto_limit(tokens: &[Token], dialect: Dialect) -> Option<u64> {
    let len = tokens.len();

    if dialect == Dialect::Postgres && len >= 5 {
        let t = &tokens[len - 5..];
        if word_eq(&t[0], "fetch")
            && (word_eq(&t[1], "first") || word_eq(&t[1], "next"))
            && (word_eq(&t[3], "row") || word_eq(&t[3], "rows"))
            && word_eq(&t[4], "only")
        {
            if let Some(v) = as_int(&t[2]) {
                return Some(v);
            }
        }
    }

    if len >= 4 {
        let t = &tokens[len - 4..];
        if word_eq(&t[0], "limit") && word_eq(&t[2], "offset") {
            if let (Some(v), Some(_)) = (as_int(&t[1]), as_int(&t[3])) {
                return Some(v);
            }
        }
    }

    if len >= 2 {
        let t = &tokens[len - 2..];
        if word_eq(&t[0], "limit") {
            if let Some(v) = as_int(&t[1]) {
                return Some(v);
            }
        }
    }

    None
}

/// MySQL/MariaDB `LIMIT` forms: plain, `LIMIT offset, count`, and
/// `LIMIT count OFFSET offset`.
fn mysql_limit(tokens: &[Token]) -> Option<u64> {
    let len = tokens.len();

    if len >= 4 {
        let t = &tokens[len - 4..];
        if word_eq(&t[0], "limit") {
            if let Some(count) = as_int(&t[1]) {
                if matches!(&t[2], Token::Punct(',')) {
                    if let Some(second) = as_int(&t[3]) {
                        return Some(second);
                    }
                }
                if word_eq(&t[2], "offset") && as_int(&t[3]).is_some() {
                    return Some(count);
                }
            }
        }
    }

    if len >= 2 {
        let t = &tokens[len - 2..];
        if word_eq(&t[0], "limit") {
            if let Some(v) = as_int(&t[1]) {
                return Some(v);
            }
        }
    }

    None
}

/// Leading `SELECT [ALL|DISTINCT] TOP (<int>|<int>) [PERCENT]` form. Returns
/// `None` (not "no TOP present") when `PERCENT` follows the integer, since a
/// percentage does not bound the absolute row count.
fn tsql_leading_top(tokens: &[Token]) -> Option<u64> {
    if !matches!(tokens.first(), Some(Token::Word(w)) if w == "select") {
        return None;
    }
    let mut idx = 1;
    if matches!(tokens.get(idx), Some(Token::Word(w)) if w == "all" || w == "distinct") {
        idx += 1;
    }
    match tokens.get(idx) {
        Some(Token::Word(w)) if w == "top" => idx += 1,
        _ => return None,
    }
    let value = match tokens.get(idx) {
        Some(tok @ Token::ParenInt(_)) => {
            idx += 1;
            as_int(tok)?
        }
        Some(tok @ Token::Word(_)) => {
            let v = as_int(tok)?;
            idx += 1;
            v
        }
        _ => return None,
    };
    if matches!(tokens.get(idx), Some(Token::Word(w)) if w == "percent") {
        return None;
    }
    Some(value)
}

/// Trailing `OFFSET <int> ROWS FETCH NEXT <int> ROWS ONLY` form (accepting
/// `FIRST` for `NEXT` and `ROW` for `ROWS`, in either occurrence).
fn tsql_trailing_fetch(tokens: &[Token]) -> Option<u64> {
    let len = tokens.len();
    if len < 8 {
        return None;
    }
    let t = &tokens[len - 8..];
    if !word_eq(&t[0], "offset") {
        return None;
    }
    as_int(&t[1])?;
    if !(word_eq(&t[2], "rows") || word_eq(&t[2], "row")) {
        return None;
    }
    if !word_eq(&t[3], "fetch") {
        return None;
    }
    if !(word_eq(&t[4], "next") || word_eq(&t[4], "first")) {
        return None;
    }
    let fetch_val = as_int(&t[5])?;
    if !(word_eq(&t[6], "rows") || word_eq(&t[6], "row")) {
        return None;
    }
    if !word_eq(&t[7], "only") {
        return None;
    }
    Some(fetch_val)
}

/// T-SQL: prefer a leading `TOP` over a trailing `OFFSET … FETCH NEXT` when
/// both are present — `TOP` binds tighter (it wins/executes first
/// conceptually), and mixing the two in the same query is itself invalid
/// T-SQL, so this ordering only matters for defensive robustness.
fn tsql_limit(tokens: &[Token]) -> Option<u64> {
    if let Some(v) = tsql_leading_top(tokens) {
        return Some(v);
    }
    tsql_trailing_fetch(tokens)
}

/// Report a statement's own explicit row limit, if one can be determined
/// unambiguously. Returns `None` — meaning "no explicit limit, the caller
/// should fall back to the configured cap" — for anything else, including
/// every case enumerated in the module tests below.
pub fn explicit_row_limit(sql: &str, dialect: Dialect) -> Option<u64> {
    let mut tokens = tokenize(sql, dialect);

    match tokens.first() {
        Some(Token::Word(w)) if matches!(w.as_str(), "select" | "with" | "table" | "values" | "show") =>
            {}
        _ => return None,
    }

    if matches!(tokens.last(), Some(Token::Punct(';'))) {
        tokens.pop();
    }

    match dialect {
        Dialect::Postgres | Dialect::Presto => postgres_presto_limit(&tokens, dialect),
        Dialect::MySql => mysql_limit(&tokens),
        Dialect::TSql => tsql_limit(&tokens),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Adversarial corpus — every one of these MUST return `None`.
    // -----------------------------------------------------------------------

    #[test]
    fn limit_inside_string_literal_ignored() {
        assert_eq!(
            explicit_row_limit("SELECT 'limit 30000' AS note FROM t", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_inside_line_comment_ignored() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t -- LIMIT 99999", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_inside_leading_block_comment_ignored() {
        assert_eq!(
            explicit_row_limit("/* LIMIT 1 */ SELECT * FROM t", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_inside_subquery_ignored() {
        assert_eq!(
            explicit_row_limit(
                "SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5)",
                Dialect::Postgres
            ),
            None
        );
    }

    #[test]
    fn limit_inside_cte_subquery_ignored() {
        assert_eq!(
            explicit_row_limit(
                "WITH c AS (SELECT * FROM u LIMIT 5) SELECT * FROM c",
                Dialect::Postgres
            ),
            None
        );
    }

    #[test]
    fn limit_inside_dollar_quote_empty_tag_ignored() {
        assert_eq!(
            explicit_row_limit("SELECT $$ LIMIT 42 $$ AS body", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_inside_dollar_quote_named_tag_ignored() {
        assert_eq!(
            explicit_row_limit("SELECT $tag$ LIMIT 42 $tag$ AS body", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_all_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT ALL", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_null_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT NULL", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn limit_bind_param_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT $1", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn mysql_limit_placeholder_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT ?", Dialect::MySql),
            None
        );
    }

    #[test]
    fn mysql_limit_user_variable_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT @n", Dialect::MySql),
            None
        );
    }

    #[test]
    fn limit_expression_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT 1+1", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn top_percent_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT TOP 50 PERCENT * FROM t", Dialect::TSql),
            None
        );
    }

    #[test]
    fn insert_select_limit_gated_by_leading_keyword() {
        assert_eq!(
            explicit_row_limit("INSERT INTO t SELECT * FROM u LIMIT 5", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn update_is_none() {
        assert_eq!(explicit_row_limit("UPDATE t SET a=1", Dialect::Postgres), None);
    }

    #[test]
    fn mysql_backtick_identifier_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT `limit 5` FROM t", Dialect::MySql),
            None
        );
    }

    #[test]
    fn tsql_bracket_identifier_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT [LIMIT 5] FROM t", Dialect::TSql),
            None
        );
    }

    #[test]
    fn postgres_double_quoted_identifier_is_none() {
        assert_eq!(
            explicit_row_limit("SELECT \"limit 5\" FROM t", Dialect::Postgres),
            None
        );
    }

    #[test]
    fn no_limit_at_all_is_none_for_every_dialect() {
        for dialect in [
            Dialect::Postgres,
            Dialect::MySql,
            Dialect::TSql,
            Dialect::Presto,
        ] {
            assert_eq!(explicit_row_limit("SELECT * FROM t", dialect), None);
        }
    }

    // -----------------------------------------------------------------------
    // Positive corpus — each MUST return `Some(<value>)`.
    // -----------------------------------------------------------------------

    #[test]
    fn postgres_trailing_limit() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT 30000", Dialect::Postgres),
            Some(30000)
        );
    }

    #[test]
    fn postgres_limit_offset() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT 250 OFFSET 1000", Dialect::Postgres),
            Some(250)
        );
    }

    #[test]
    fn postgres_lowercase_semicolon_trailing_newline() {
        assert_eq!(
            explicit_row_limit("select * from t limit 30000;\n", Dialect::Postgres),
            Some(30000)
        );
    }

    #[test]
    fn postgres_fetch_first_rows_only() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t FETCH FIRST 500 ROWS ONLY", Dialect::Postgres),
            Some(500)
        );
    }

    #[test]
    fn postgres_fetch_next_row_only() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t FETCH NEXT 500 ROW ONLY", Dialect::Postgres),
            Some(500)
        );
    }

    #[test]
    fn mysql_offset_count_form() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT 1000, 250", Dialect::MySql),
            Some(250)
        );
    }

    #[test]
    fn mysql_limit_offset_form() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM t LIMIT 250 OFFSET 1000", Dialect::MySql),
            Some(250)
        );
    }

    #[test]
    fn presto_trailing_limit() {
        assert_eq!(
            explicit_row_limit("SELECT * FROM events LIMIT 30000", Dialect::Presto),
            Some(30000)
        );
    }

    #[test]
    fn tsql_top_parenthesized() {
        assert_eq!(
            explicit_row_limit("SELECT TOP (25000) * FROM dbo.t", Dialect::TSql),
            Some(25000)
        );
    }

    #[test]
    fn tsql_top_bare() {
        assert_eq!(
            explicit_row_limit("SELECT TOP 25000 * FROM dbo.t", Dialect::TSql),
            Some(25000)
        );
    }

    #[test]
    fn tsql_distinct_top_parenthesized() {
        assert_eq!(
            explicit_row_limit("SELECT DISTINCT TOP (100) * FROM dbo.t", Dialect::TSql),
            Some(100)
        );
    }

    #[test]
    fn tsql_offset_fetch_next() {
        assert_eq!(
            explicit_row_limit(
                "SELECT * FROM dbo.t ORDER BY id OFFSET 0 ROWS FETCH NEXT 20000 ROWS ONLY",
                Dialect::TSql
            ),
            Some(20000)
        );
    }

    #[test]
    fn postgres_cte_then_limit_on_outer_select() {
        assert_eq!(
            explicit_row_limit("WITH c AS (SELECT 1) SELECT * FROM c LIMIT 42", Dialect::Postgres),
            Some(42)
        );
    }

    #[test]
    fn postgres_depth_zero_limit_after_paren_group() {
        assert_eq!(
            explicit_row_limit(
                "SELECT * FROM t WHERE x IN (1,2,3) LIMIT 7",
                Dialect::Postgres
            ),
            Some(7)
        );
    }
}
