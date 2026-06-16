import { useEffect, useMemo, useRef, useState } from "react";

/* ── Release manifest ──────────────────────────────────────────────────── */

const MANIFEST_URL = "https://releases.argusdb.app/download.json";

type Installer = { url: string; filename: string; size: number };
type Manifest = {
  version: string;
  pub_date: string;
  installers: Record<string, Installer>;
};

// Embedded fallback so the CTA is never empty even if the manifest fetch fails.
const FALLBACK: Manifest = {
  version: "0.1.39",
  pub_date: "2026-06-16T16:10:26Z",
  installers: {
    "darwin-aarch64": {
      url: "https://releases.argusdb.app/Argus_0.1.39_aarch64.dmg",
      filename: "Argus_0.1.39_aarch64.dmg",
      size: 9656463,
    },
    "darwin-x86_64": {
      url: "https://releases.argusdb.app/Argus_0.1.39_x64.dmg",
      filename: "Argus_0.1.39_x64.dmg",
      size: 10578504,
    },
  },
};

function fmtSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Best-effort: is this an Apple-Silicon Mac? Falls back to true (the common case). */
function prefersAppleSilicon(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl") as WebGLRenderingContext | null) ||
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        const r = String(
          gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ""
        ).toLowerCase();
        if (r.includes("intel")) return false;
        if (r.includes("apple")) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return true; // most new Macs are Apple Silicon
}

/* ── Icons (hairline, currentColor — per DESIGN.md) ────────────────────── */

const Eye = ({ size = 26 }: { size?: number }) => (
  <img className="mark" src="/logo.svg" width={size} height={size} alt="Argus" />
);

const AppleLogo = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
    <path d="M17.05 12.04c-.03-2.8 2.29-4.15 2.39-4.21-1.3-1.9-3.33-2.16-4.05-2.19-1.72-.17-3.36 1.01-4.23 1.01-.87 0-2.22-.99-3.65-.96-1.88.03-3.61 1.09-4.58 2.77-1.95 3.39-.5 8.41 1.4 11.16.93 1.35 2.04 2.86 3.49 2.81 1.4-.06 1.93-.9 3.62-.9 1.69 0 2.17.9 3.65.87 1.51-.03 2.46-1.37 3.38-2.73 1.07-1.57 1.51-3.09 1.53-3.17-.03-.01-2.94-1.13-2.97-4.47zM14.6 4.04c.77-.93 1.29-2.23 1.15-3.52-1.11.05-2.46.74-3.25 1.67-.71.83-1.33 2.15-1.16 3.42 1.24.1 2.5-.63 3.26-1.57z" />
  </svg>
);

const Download = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

const Arrow = ({ size = 15 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14m-6-6 6 6-6 6" />
  </svg>
);

const Chip = ({ size = 12 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
  </svg>
);

/* ── Content data ──────────────────────────────────────────────────────── */

const SOURCES = [
  { name: "PostgreSQL", desc: "Full feature set — schema browser, virtualized grid, inline edits, SQL editor, structure viewer." },
  { name: "MySQL / MariaDB", desc: "MySQL ≥ 5.7, MariaDB ≥ 10.5. Multi-statement runs, inline editing, structure viewer." },
  { name: "SQL Server", desc: "2017+, Azure SQL & Managed Instance. GO batch support in the editor." },
  { name: "DynamoDB", desc: "Table browsing, item scanning, and per-connection physical-name normalization." },
  { name: "CloudWatch Logs", desc: "Log group and stream browsing with querying across your accounts." },
  { name: "Athena", desc: "Serverless SQL over S3 — Glue-backed schema, bytes-scanned cost, CSV / JSONL / XLSX export." },
];

/* ── Reveal-on-scroll hook ─────────────────────────────────────────────── */

function useReveal() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/* ── App ───────────────────────────────────────────────────────────────── */

export default function App() {
  const [manifest, setManifest] = useState<Manifest>(FALLBACK);
  const isArm = useRef<boolean>(true);
  useReveal();

  useEffect(() => {
    isArm.current = prefersAppleSilicon();
    let cancelled = false;
    fetch(MANIFEST_URL, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((m: Manifest) => {
        if (!cancelled && m?.installers) setManifest(m);
      })
      .catch(() => {/* keep fallback */});
    return () => {
      cancelled = true;
    };
  }, []);

  const arm = manifest.installers["darwin-aarch64"];
  const intel = manifest.installers["darwin-x86_64"];
  const primary = useMemo(
    () => (isArm.current ? arm : intel) ?? arm ?? intel,
    [arm, intel]
  );
  const primaryArch = primary === intel ? "Intel" : "Apple Silicon";

  return (
    <>
      <div className="atmosphere" />
      <div className="grain" />

      <div className="shell">
        {/* ── Nav ── */}
        <nav className="nav">
          <div className="container nav-inner">
            <a className="brand" href="#top">
              <Eye />
              Argus
            </a>
            <div className="nav-links">
              <a href="#sources">Sources</a>
              <a href="#console">The console</a>
              <a href="#features">Features</a>
              <span className="version-pill">
                <span className="dot" />v{manifest.version}
              </span>
              <a className="nav-cta" href="#download">
                Download
              </a>
            </div>
          </div>
        </nav>

        {/* ── Hero ── */}
        <header className="hero" id="top">
          <div className="scan" />
          <div className="container hero-grid">
            <div className="hero-copy">
              <span className="hero-tag">
                <span className="chip">Argus</span>
                The hundred-eyed watchman, for your data
              </span>
              <h1>
                A hundred eyes on
                <br />
                every <span className="glow">database</span>.
              </h1>
              <p className="lede">
                Argus is a precision desktop client for inspecting and editing
                data across <strong>Postgres, MySQL, SQL&nbsp;Server, DynamoDB,
                CloudWatch</strong> and <strong>Athena</strong> — one watchful,
                command-palette-driven console for all of it.
              </p>

              <div className="cta-row">
                <a className="btn-download" href={primary?.url}>
                  <AppleLogo />
                  <span className="bd-text">
                    Download for macOS
                    <span className="bd-meta">
                      {primaryArch} · {primary ? fmtSize(primary.size) : "—"}
                    </span>
                  </span>
                </a>
                <a className="btn-ghost" href="#download">
                  All downloads <Arrow />
                </a>
              </div>

              <div className="cta-note">
                <span>macOS 11+</span>
                <span className="sep" />
                <span>Free</span>
                <span className="sep" />
                <span>v{manifest.version}</span>
                <span className="sep" />
                <span>Built {fmtDate(manifest.pub_date)}</span>
              </div>
            </div>

            {/* App mockup */}
            <div className="mockup-wrap">
              <AppMockup />
            </div>
          </div>
        </header>

        {/* ── Sources ── */}
        <section className="section" id="sources">
          <div className="container">
            <div className="section-head reveal">
              <span className="eyebrow">
                <span className="accent">06</span> &nbsp;Sources, one console
              </span>
              <h2>Six engines. No context-switching.</h2>
              <p>
                Postgres to Athena, every source lives behind the same
                three-pane shell, the same keyboard shortcuts, the same grid.
                Learn it once.
              </p>
            </div>
            <div className="sources reveal">
              {SOURCES.map((s, i) => (
                <div className="source" key={s.name}>
                  <span className="source-idx">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="source-name">{s.name}</div>
                  <div className="source-desc">{s.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── The console (mockup callout) ── */}
        <section className="section" id="console">
          <div className="container">
            <div className="section-head reveal">
              <span className="eyebrow">
                <span className="accent">▱</span> &nbsp;The console
              </span>
              <h2>A precision instrument that pays attention.</h2>
              <p>
                Sidebar, virtualized data grid, inspector. Tabular numerals,
                hairline dividers, and a single violet accent that only shows up
                where it matters — the active row, the live connection, the
                primary key.
              </p>
            </div>
            <div className="mockup-wrap reveal" style={{ maxWidth: 920, margin: "0 auto" }}>
              <AppMockup wide />
            </div>
          </div>
        </section>

        {/* ── Features bento ── */}
        <section className="section" id="features">
          <div className="container">
            <div className="section-head reveal">
              <span className="eyebrow">
                <span className="accent">✦</span> &nbsp;What's inside
              </span>
              <h2>Built for people who live in databases.</h2>
            </div>

            <div className="bento reveal">
              <div className="feat span-3">
                <span className="ftag">Data grid</span>
                <h3>Virtualized grid, inline editing</h3>
                <p>
                  Scroll millions of rows without a stutter. Edit a cell in
                  place, see the diff, commit when you're ready. Column widths
                  are type-derived and persist per relation.
                </p>
              </div>

              <div className="feat span-3">
                <span className="ftag">SQL editor</span>
                <h3>Multi-statement, batch-aware</h3>
                <p>
                  Run scripts with <code>GO</code> batches on SQL Server,
                  multi-statement runs everywhere else, and live bytes-scanned
                  cost on Athena.
                </p>
                <div className="feat-sql">
                  <div><span className="cm">-- recent high-value orders</span></div>
                  <div>
                    <span className="kw">SELECT</span> id, amount, status
                  </div>
                  <div>
                    <span className="kw">FROM</span> orders
                  </div>
                  <div>
                    <span className="kw">WHERE</span> amount {">"} <span className="fn">2000</span> <span className="kw">ORDER BY</span> created <span className="kw">DESC</span>;
                  </div>
                </div>
              </div>

              <div className="feat span-2">
                <span className="ftag">Command palette</span>
                <h3>Everything is a keystroke</h3>
                <div className="feat-palette">
                  <div className="pp-input">
                    <span className="caret">⌘K</span> connect prod…
                  </div>
                  <div className="pp-row on">
                    Connect: prod-postgres <span className="kbd">↵</span>
                  </div>
                  <div className="pp-row">
                    Run query <span className="kbd">⌘↵</span>
                  </div>
                  <div className="pp-row">
                    Focus chat panel <span className="kbd">⌘J</span>
                  </div>
                </div>
              </div>

              <div className="feat span-2">
                <span className="ftag">Context folders</span>
                <h3>The folder is the project</h3>
                <p>
                  Link a connection to a folder of structured docs and prefab
                  queries. One root, every engine — schema sync keeps it honest.
                </p>
              </div>

              <div className="feat span-2">
                <span className="ftag">AI providers</span>
                <h3>Grounded SQL generation</h3>
                <p>
                  Claude Code, Codex CLI, or the Anthropic & OpenAI APIs — the
                  context folder rides along so generated SQL knows your schema.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Download ── */}
        <section className="section dl-section" id="download">
          <div className="container">
            <div className="section-head reveal" style={{ marginInline: "auto", textAlign: "center", maxWidth: 560 }}>
              <span className="eyebrow">
                <span className="accent">↓</span> &nbsp;Download
              </span>
              <h2>Get Argus for macOS.</h2>
              <p>
                Universal builds for Apple Silicon and Intel. Free, signed,
                version {manifest.version}.
              </p>
            </div>

            <div className="dl-cards reveal">
              <DownloadCard
                title="Apple Silicon"
                sub="M1, M2, M3 and later"
                installer={arm}
                recommended={isArm.current}
              />
              <DownloadCard
                title="Intel"
                sub="x86-64 Macs"
                installer={intel}
                recommended={!isArm.current}
              />
            </div>

            <div className="dl-foot">
              <span>v{manifest.version}</span>
              <span>·</span>
              <span>Released {fmtDate(manifest.pub_date)}</span>
              <span>·</span>
              <span>requires macOS 11 Big Sur or later</span>
            </div>
          </div>
        </section>

        {/* ── Footer ── */}
        <footer className="footer">
          <div className="container footer-inner">
            <a className="brand" href="#top">
              <Eye size={22} />
              Argus
            </a>
            <div className="footer-meta">
              <a href="#sources">Sources</a>
              <a href="#console">Console</a>
              <a href="#features">Features</a>
              <a href="#download">Download</a>
              <span>v{manifest.version}</span>
              <span>© 2026</span>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}

/* ── Download card ─────────────────────────────────────────────────────── */

function DownloadCard({
  title,
  sub,
  installer,
  recommended,
}: {
  title: string;
  sub: string;
  installer?: Installer;
  recommended?: boolean;
}) {
  return (
    <div className={`dl-card${recommended ? " recommended" : ""}`}>
      {recommended && <span className="dl-badge">Recommended for you</span>}
      <div className="arch">
        <Chip size={18} />
        {title}
      </div>
      <div className="sub">{sub}</div>
      <div className="meta">
        <span className="fn">{installer?.filename ?? "—"}</span>
        <span>{installer ? `${fmtSize(installer.size)} · .dmg` : "—"}</span>
      </div>
      <a className="dl-btn" href={installer?.url} aria-disabled={!installer}>
        <Download size={16} />
        Download
      </a>
    </div>
  );
}

/* ── Three-pane app mockup ─────────────────────────────────────────────── */

const ROWS = [
  { id: "8f2a", name: "Aurora Voss", amt: "2,480.00", pill: "paid" },
  { id: "1c7d", name: "Marcus Lindqvist", amt: "318.50", pill: "pending" },
  { id: "44b0", name: "Priya Raman", amt: "5,902.10", pill: "paid", active: true },
  { id: "9e31", name: "Tomás Herrera", amt: "74.00", pill: "refund" },
  { id: "0a5f", name: "Naoko Ishida", amt: "1,205.75", pill: "paid" },
  { id: "d217", name: "Eli Brandt", amt: "640.20", pill: "pending" },
  { id: "6b88", name: "Zara Okafor", amt: "9,310.00", pill: "paid" },
  { id: "3f49", name: "Lukas Meyer", amt: "212.40", pill: "paid" },
];

function AppMockup({ wide = false }: { wide?: boolean }) {
  return (
    <div className="mockup" role="img" aria-label="Argus three-pane interface">
      <div className="mk-titlebar">
        <div className="mk-traffic">
          <span /><span /><span />
        </div>
        <span className="mk-conn">
          <span className="dot" />
          prod-postgres · public
        </span>
      </div>

      <div className="mk-body">
        {/* Sidebar */}
        <aside className="mk-sidebar">
          <div className="mk-side-label">Connections</div>
          <div className="mk-side-item">
            <Dot /> analytics
          </div>
          <div className="mk-side-item">
            <Dot /> staging
          </div>
          <div className="mk-side-label">Tables</div>
          <div className="mk-side-item">
            <Tbl /> customers
          </div>
          <div className="mk-side-item active">
            <Tbl /> orders
          </div>
          <div className="mk-side-item">
            <Tbl /> invoices
          </div>
          <div className="mk-side-item">
            <Tbl /> events
          </div>
          <div className="mk-side-item">
            <Tbl /> sessions
          </div>
        </aside>

        {/* Main grid */}
        <main className="mk-main">
          <div className="mk-tabs">
            <div className="mk-tab active">orders</div>
            <div className="mk-tab">SQL editor</div>
          </div>
          <div className="mk-grid">
            <div className="mk-row head">
              <span>#</span>
              <span>customer</span>
              <span style={{ textAlign: "right" }}>amount</span>
              <span style={{ justifySelf: "end" }}>status</span>
            </div>
            {ROWS.map((r) => (
              <div className={`mk-row${r.active ? " active" : ""}`} key={r.id}>
                <span className="mk-cell-id">{r.id}</span>
                <span className="mk-cell-name">{r.name}</span>
                <span className="mk-cell-amt">{r.amt}</span>
                <span
                  className={`mk-pill ${
                    r.pill === "paid"
                      ? "paid"
                      : r.pill === "pending"
                      ? "pending"
                      : "refund"
                  }`}
                >
                  {r.pill}
                </span>
              </div>
            ))}
          </div>
        </main>

        {/* Inspector */}
        <aside className="mk-inspector">
          <div className="mk-insp-title">Row · orders</div>
          <div className="mk-field">
            <div className="k">
              id <span className="pk">PK</span>
            </div>
            <div className="v mono">44b0-9c1e-7af2</div>
          </div>
          <div className="mk-field">
            <div className="k">customer</div>
            <div className="v">Priya Raman</div>
          </div>
          <div className="mk-field">
            <div className="k">amount</div>
            <div className="v mono">5,902.10</div>
          </div>
          <div className="mk-field">
            <div className="k">status</div>
            <div className="v">paid</div>
          </div>
          <div className="mk-field">
            <div className="k">created_at</div>
            <div className="v mono">2026-06-14 09:21</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

const Dot = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <circle cx="12" cy="12" r="7" />
  </svg>
);

const Tbl = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M3 9h18M9 9v11" />
  </svg>
);
