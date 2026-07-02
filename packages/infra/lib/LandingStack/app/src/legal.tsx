import type { ReactNode } from "react";

/* ── LegalPage layout ──────────────────────────────────────────────────── */

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <>
      {/* Nav — brand only, no section anchors on legal pages */}
      <nav className="nav">
        <div className="container nav-inner">
          <a className="brand" href="/">
            <img className="mark" src="/logo.svg" width={26} height={26} alt="Argus" />
            Argus
          </a>
        </div>
      </nav>

      {/* Body */}
      <div className="legal">
        <div className="container">
          <div className="legal-doc">
            <div className="legal-back">
              <a href="/">← Back to home</a>
            </div>
            <h1>{title}</h1>
            <div className="legal-meta">Last updated {updated}</div>
            <div className="legal-draft">Draft — this document is pending legal review.</div>
            {children}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="footer">
        <div className="container footer-inner">
          <a className="brand" href="/">
            <img className="mark" src="/logo.svg" width={22} height={22} alt="Argus" />
            Argus
          </a>
          <div className="footer-meta">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <span>© 2026</span>
          </div>
        </div>
      </footer>
    </>
  );
}

/* ── Privacy Policy ────────────────────────────────────────────────────── */

export function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="July 2026">
      <h2>Overview</h2>
      <p>
        This Privacy Policy covers two things: the Argus website at{" "}
        <strong>argusdb.app</strong> and the <strong>Argus desktop application</strong>.
        We want you to know plainly what information is collected, where it goes, and
        what we do not do. The website uses <strong>no cookies</strong> and no
        client-side analytics or tracking scripts. No consent banner appears because
        there is nothing to consent to on the client side.
      </p>

      <h2>Information collected by the website</h2>
      <p>
        When you visit argusdb.app, our CDN — <strong>Amazon CloudFront</strong> — records
        standard server-side access logs. These logs include:
      </p>
      <ul>
        <li>Your IP address</li>
        <li>User-agent string (browser type and operating system)</li>
        <li>The resources you requested and the HTTP status code returned</li>
        <li>Timestamps of each request</li>
      </ul>
      <p>
        <strong>Purpose:</strong> operating and securing the website, and gaining an
        aggregate understanding of traffic patterns.
      </p>
      <p>
        <strong>Legal basis (GDPR):</strong> legitimate interest in operating and
        securing the website. No cookies are set; no client-side tracking or profiling
        occurs, so no cookie-consent banner is required.
      </p>

      <h2>Data handled by the desktop application</h2>
      <p>
        The desktop app processes data in several distinct ways. It is important to
        understand what stays on your device versus what leaves it.
      </p>

      <h3>Stored locally on your device only</h3>
      <p>
        Database connection credentials (hostnames, ports, usernames, passwords) are
        stored exclusively in your operating system's <strong>keychain</strong> (Keychain
        Access on macOS, Credential Manager on Windows). Context folders — the project
        documentation and prefab queries you link to a connection — live on your local
        filesystem. <strong>Argus does not transmit any of this to us or to any server
        we operate.</strong>
      </p>

      <h3>Sent to third parties only when you use the AI features</h3>
      <p>
        If you use the in-app AI chat or SQL-generation features (the ✨ panel), the
        content of your prompts and the relevant context — which may include schema
        information and query text — is transmitted directly to the AI provider you
        have configured. Argus supports two API-based providers:
      </p>
      <ul>
        <li>
          <strong>Anthropic (Claude)</strong> — your data is processed under Anthropic's
          terms of service and privacy policy.
        </li>
        <li>
          <strong>OpenAI</strong> — your data is processed under OpenAI's terms of service
          and privacy policy.
        </li>
      </ul>
      <p>
        Argus itself does not receive or store this content on any server we control. We
        encourage you to review Anthropic's and OpenAI's respective privacy policies before
        using those features. You can also configure Argus to use local CLI providers
        (Claude Code or OpenAI Codex CLI), in which case your prompts are processed
        entirely on your own machine.
      </p>

      <h3>Database contents</h3>
      <p>
        Data you view, query, or edit through Argus flows directly between your machine
        and the database servers you connect to. It does not pass through any
        Argus-operated server.
      </p>

      <h2>What we do NOT collect</h2>
      <p>
        No account is required to download or use Argus. We do not collect your name,
        email address, or any telemetry or crash reports from the desktop application
        itself.
      </p>

      <h2>Data retention</h2>
      <p>
        Website access logs generated by CloudFront are retained for a limited period
        for security and operational purposes and then expire. We do not retain these
        logs indefinitely or use them to build profiles of individual visitors.
      </p>

      <h2>Your rights</h2>
      <p>
        Under the GDPR (for visitors in the EEA/UK) and the CCPA (for California
        residents), you have the right to request access to or deletion of personal data
        associated with you. In practice, the only personal data we hold is website
        access logs that may include your IP address. To exercise these rights, contact
        us using the address below and we will respond within the applicable timeframe.
      </p>

      <h2>Contact</h2>
      <p>
        For privacy inquiries, contact us at{" "}
        <a href="mailto:privacy@argusdb.app">privacy@argusdb.app</a>.
      </p>
    </LegalPage>
  );
}

/* ── Terms of Service ──────────────────────────────────────────────────── */

export function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" updated="July 2026">
      <h2>Acceptance</h2>
      <p>
        By downloading, installing, or using Argus, you agree to be bound by these
        Terms of Service. If you do not agree to these terms, do not use the software.
      </p>

      <h2>License</h2>
      <p>
        Argus is provided free of charge for personal and commercial use. You may
        install and use it on your devices in accordance with these terms. To the extent
        Argus is distributed under an open-source license, that license governs your
        rights to the source code and supersedes these terms where the two conflict.
      </p>

      <h2>No warranty</h2>
      <p>
        Argus is provided <strong>"AS IS"</strong> without warranties of any kind,
        express or implied, including but not limited to warranties of merchantability,
        fitness for a particular purpose, and non-infringement.{" "}
        <strong>
          You are solely responsible for maintaining appropriate backups of your data
          and for any modifications you make to your data through the application.
        </strong>{" "}
        Use Argus at your own risk.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        <strong>
          To the maximum extent permitted by applicable law, the authors and
          contributors of Argus shall not be liable for any direct, indirect,
          incidental, special, consequential, or exemplary damages arising from or
          in connection with your use of or inability to use the software, including
          but not limited to data loss, loss of profits, or business interruption,
          even if advised of the possibility of such damages.
        </strong>
      </p>

      <h2>Third-party services</h2>
      <p>
        Argus allows you to connect to external database servers and to send requests
        to third-party AI providers (Anthropic and OpenAI). Your use of those services
        is subject to those third parties' own terms of service and privacy policies.
        You are responsible for your credentials and for ensuring you are authorized
        to access any data source you connect to through Argus.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms from time to time. Updates will be reflected on this
        page with a revised "Last updated" date. Your continued use of Argus after
        changes are posted constitutes your acceptance of the revised terms.
      </p>

      <h2>Contact</h2>
      <p>
        For questions about these terms, contact us at{" "}
        <a href="mailto:privacy@argusdb.app">privacy@argusdb.app</a>.
      </p>
    </LegalPage>
  );
}
