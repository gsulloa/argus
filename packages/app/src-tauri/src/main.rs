// Prevent additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ── Sidecar detection (MUST come before any Tauri/logging init) ──────────
    //
    // When the Claude CLI spawns `argus __mcp-doc-writer --root <path>
    // --engine <subtree> [--table-match <json>]` we handle it here and exit,
    // never touching the Tauri runtime.  This check is O(1) and allocation-free
    // until we confirm the subcommand is present, so normal startup is unaffected.
    //
    // migration-sensitive: the binary is invoked as `<CARGO_BIN_NAME> <subcommand>`
    // by the Claude CLI integration, so the produced binary name (Cargo
    // `[package]`/`[lib]` name) and this subcommand are a coupled pair.
    // See config::app_identity::{CARGO_BIN_NAME, MCP_SIDECAR_SUBCOMMAND}.
    if std::env::args().nth(1).as_deref()
        == Some(argus_lib::config::app_identity::MCP_SIDECAR_SUBCOMMAND)
    {
        run_mcp_doc_writer_subcommand();
    }

    argus_lib::run();
}

/// Parse argv for `__mcp-doc-writer` and start the stdio MCP loop.
/// Exits immediately on missing/invalid arguments.
fn run_mcp_doc_writer_subcommand() -> ! {
    use argus_lib::modules::ai::mcp_doc_sidecar::{run_stdio_loop, SidecarConfig};
    use argus_lib::modules::context::engine::EngineKind;
    use argus_lib::modules::dynamo::params::TableMatch;

    // Collect args starting AFTER the subcommand name itself.
    // argv layout: [binary, "__mcp-doc-writer", "--root", <path>, "--engine", <sub>, ...]
    let raw_args: Vec<String> = std::env::args().skip(2).collect();

    let mut root: Option<String> = None;
    let mut engine_str: Option<String> = None;
    let mut table_match_json: Option<String> = None;

    let mut i = 0;
    while i < raw_args.len() {
        match raw_args[i].as_str() {
            "--root" => {
                i += 1;
                root = raw_args.get(i).cloned();
            }
            "--engine" => {
                i += 1;
                engine_str = raw_args.get(i).cloned();
            }
            "--table-match" => {
                i += 1;
                table_match_json = raw_args.get(i).cloned();
            }
            unknown => {
                eprintln!("argus __mcp-doc-writer: unknown argument {unknown:?}");
                std::process::exit(1);
            }
        }
        i += 1;
    }

    // Validate required --root.
    let root_str = match root {
        Some(r) => r,
        None => {
            eprintln!("argus __mcp-doc-writer: --root <path> is required");
            std::process::exit(1);
        }
    };
    let context_root = std::path::PathBuf::from(&root_str);
    if !context_root.exists() {
        eprintln!(
            "argus __mcp-doc-writer: context root does not exist: {root_str}"
        );
        std::process::exit(1);
    }

    // Validate required --engine.
    let engine_raw = match engine_str {
        Some(e) => e,
        None => {
            eprintln!("argus __mcp-doc-writer: --engine <subtree> is required");
            std::process::exit(1);
        }
    };
    let engine = match EngineKind::from_connection_kind(&engine_raw) {
        Some(e) => e,
        None => {
            // Also try matching on subtree directly (what we serialize in build_doc_mcp_config_json).
            match engine_raw.as_str() {
                "postgres" => EngineKind::Postgres,
                "mysql" => EngineKind::Mysql,
                "mssql" => EngineKind::Mssql,
                "dynamo" => EngineKind::Dynamo,
                "cloudwatch" => EngineKind::Cloudwatch,
                "athena" => EngineKind::Athena,
                other => {
                    eprintln!(
                        "argus __mcp-doc-writer: unknown engine {other:?}; expected one of: postgres mysql mssql dynamo cloudwatch athena"
                    );
                    std::process::exit(1);
                }
            }
        }
    };

    // Parse optional --table-match.
    let dynamo_rule: Option<TableMatch> = match table_match_json {
        Some(json_str) => match serde_json::from_str::<TableMatch>(&json_str) {
            Ok(tm) => Some(tm),
            Err(e) => {
                eprintln!("argus __mcp-doc-writer: --table-match is not valid JSON: {e}");
                std::process::exit(1);
            }
        },
        None => None,
    };

    let cfg = SidecarConfig {
        context_root,
        engine,
        dynamo_rule,
    };

    run_stdio_loop(cfg);
}
