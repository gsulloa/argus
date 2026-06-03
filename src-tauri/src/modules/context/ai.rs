//! AI payload helpers.
//!
//! `body_summary` extracts the first prose paragraph from a Markdown body,
//! skipping a single leading `# …` heading if present.
//!
//! `build_payload` converts a `ParsedContext` into an `AiPayload`, choosing
//! between `body_summary` (default) and full body inclusion.

use crate::modules::context::types::{AiObjectEntry, AiPayload, AiQueryEntry, ParsedContext};

// ---- body_summary ----

/// Maximum byte length of a body summary. Summaries longer than this are
/// truncated and appended with `"…"`. This prevents full-body accidental
/// inclusion in summary mode for documents with very long first paragraphs.
const SUMMARY_MAX_BYTES: usize = 512;

/// Extract the first prose paragraph of a Markdown body.
///
/// Rules:
/// 1. Strip leading empty lines.
/// 2. If the first non-empty line starts with `# ` (a level-1 heading), skip
///    it and any blank lines that follow.
/// 3. Collect lines until the next blank line; join with `\n` and trim trailing
///    whitespace.
/// 4. If the result exceeds `SUMMARY_MAX_BYTES`, truncate and append `"…"`.
/// 5. Return `None` if no prose lines remain.
pub fn body_summary(body: &str) -> Option<String> {
    let mut lines = body.lines().peekable();

    // 1. Skip leading empty lines.
    while lines.peek().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.next();
    }

    // 2. If the first non-empty line is a level-1 heading, skip it.
    if lines.peek().map(|l| l.starts_with("# ")).unwrap_or(false) {
        lines.next(); // consume the heading
                      // Skip blank lines after the heading.
        while lines.peek().map(|l| l.trim().is_empty()).unwrap_or(false) {
            lines.next();
        }
    }

    // 3. Collect the first paragraph (lines until the next blank line).
    let mut paragraph: Vec<&str> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        paragraph.push(line);
    }

    // 5. Return None if no prose.
    if paragraph.is_empty() {
        return None;
    }

    let result = paragraph.join("\n").trim_end().to_string();
    if result.is_empty() {
        return None;
    }

    // 4. Truncate if too long.
    if result.len() > SUMMARY_MAX_BYTES {
        // Find a valid UTF-8 boundary at or before the limit.
        let mut end = SUMMARY_MAX_BYTES;
        while !result.is_char_boundary(end) {
            end -= 1;
        }
        Some(format!("{}…", &result[..end]))
    } else {
        Some(result)
    }
}

// ---- build_payload ----

/// Produce an `AiPayload` from a `ParsedContext`.
///
/// If `include_full_bodies` is `false` (the default), each object entry
/// carries `body_summary` and `body = None`. If `true`, the full body text
/// is included and `body_summary` is `None`.
pub(crate) fn build_payload(parsed: &ParsedContext, include_full_bodies: bool) -> AiPayload {
    let objects = parsed
        .objects
        .iter()
        .map(|obj| {
            let name = match &obj.system.schema {
                Some(s) => format!("{}.{}", s, obj.system.name),
                None => obj.system.name.clone(),
            };
            AiObjectEntry {
                name,
                system: obj.system.clone(),
                human: obj.human.clone(),
                body_summary: if include_full_bodies {
                    None
                } else {
                    body_summary(&obj.body)
                },
                body: if include_full_bodies {
                    Some(obj.body.clone())
                } else {
                    None
                },
            }
        })
        .collect();

    let queries = parsed
        .queries
        .iter()
        .map(|q| AiQueryEntry {
            name: q.name.clone(),
            description: q.description.clone(),
            body: q.body.clone(),
        })
        .collect();

    AiPayload {
        manifest: Some(parsed.manifest.clone()),
        overview: parsed.overview.clone(),
        glossary: parsed.glossary.clone(),
        objects,
        queries,
    }
}

/// Return an empty `AiPayload` (no linked folder or registry miss).
pub(crate) fn build_empty_payload() -> AiPayload {
    AiPayload {
        manifest: None,
        overview: None,
        glossary: None,
        objects: vec![],
        queries: vec![],
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::modules::context::types::{
        ContextManifest, LoadWarning, ObjectDoc, ObjectHuman, ObjectSystem, QueryDoc,
    };
    use std::path::PathBuf;

    // ---- body_summary tests ----

    #[test]
    fn summary_skips_h1_heading() {
        let body = "# users\n\nThe user table.\n";
        assert_eq!(body_summary(body), Some("The user table.".to_string()));
    }

    #[test]
    fn summary_without_heading() {
        let body = "Some text.\n\nMore.";
        assert_eq!(body_summary(body), Some("Some text.".to_string()));
    }

    #[test]
    fn summary_empty_body() {
        assert_eq!(body_summary(""), None);
    }

    #[test]
    fn summary_only_heading() {
        assert_eq!(body_summary("# users\n"), None);
    }

    #[test]
    fn summary_heading_with_trailing_whitespace() {
        let body = "# orders\n\nRecords all orders.  \n\nExtra para.";
        assert_eq!(body_summary(body), Some("Records all orders.".to_string()));
    }

    // ---- build_payload tests ----

    fn fake_manifest() -> ContextManifest {
        ContextManifest {
            schema_version: 1,
            name: "Test".to_string(),
            extras: HashMap::new(),
        }
    }

    fn fake_system(name: &str) -> ObjectSystem {
        ObjectSystem {
            kind: "table".to_string(),
            schema: Some("public".to_string()),
            name: name.to_string(),
            primary_key: None,
            columns: None,
            last_synced: None,
            deleted_in_db: None,
            extras: HashMap::new(),
        }
    }

    fn fake_object(name: &str, body: &str) -> ObjectDoc {
        ObjectDoc {
            system: fake_system(name),
            human: ObjectHuman::default(),
            body: body.to_string(),
            source_path: PathBuf::new(),
        }
    }

    fn fake_query(name: &str) -> QueryDoc {
        QueryDoc {
            name: name.to_string(),
            description: Some("A query".to_string()),
            params: vec![],
            tags: vec![],
            body: "SELECT 1;".to_string(),
            source_path: PathBuf::new(),
        }
    }

    fn fake_parsed(objects: Vec<ObjectDoc>) -> ParsedContext {
        ParsedContext {
            manifest: fake_manifest(),
            overview: None,
            glossary: None,
            readme: None,
            objects,
            queries: vec![fake_query("list_users")],
            warnings: vec![],
        }
    }

    #[test]
    fn payload_uses_summary_by_default() {
        let parsed = fake_parsed(vec![
            fake_object("users", "# users\n\nThe user table.\n"),
            fake_object("orders", "# orders\n\nAll orders.\n"),
        ]);
        let payload = build_payload(&parsed, false);
        assert_eq!(payload.objects.len(), 2);
        for obj in &payload.objects {
            assert!(
                obj.body_summary.is_some(),
                "body_summary should be Some when include_full_bodies=false"
            );
            assert!(
                obj.body.is_none(),
                "body should be None when include_full_bodies=false"
            );
        }
        assert_eq!(payload.queries.len(), 1);
    }

    #[test]
    fn payload_full_bodies_opt_in() {
        let parsed = fake_parsed(vec![fake_object("users", "# users\n\nThe user table.\n")]);
        let payload = build_payload(&parsed, true);
        assert_eq!(payload.objects.len(), 1);
        assert!(
            payload.objects[0].body.is_some(),
            "body should be Some when include_full_bodies=true"
        );
        assert!(
            payload.objects[0].body_summary.is_none(),
            "body_summary should be None when include_full_bodies=true"
        );
    }

    #[test]
    fn payload_unlinked_returns_empty() {
        let payload = build_empty_payload();
        assert!(payload.manifest.is_none());
        assert!(payload.objects.is_empty());
        assert!(payload.queries.is_empty());
        assert!(payload.overview.is_none());
        assert!(payload.glossary.is_none());
    }

    #[test]
    fn large_folder_size_remains_reasonable() {
        // 200 objects × 50 KB body = 10 MB total, but summary mode should be << 200 KB.
        let big_body = "# table\n\n".to_string() + &"x".repeat(50 * 1024);
        let objects: Vec<ObjectDoc> = (0..200)
            .map(|i| fake_object(&format!("tbl_{i}"), &big_body))
            .collect();
        let parsed = fake_parsed(objects);
        let payload = build_payload(&parsed, false);
        let json = serde_json::to_vec(&payload).expect("serialise payload");
        let size_kb = json.len() / 1024;
        assert!(
            json.len() < 200 * 1024,
            "summary payload should be < 200 KB, got {size_kb} KB"
        );
    }
}
