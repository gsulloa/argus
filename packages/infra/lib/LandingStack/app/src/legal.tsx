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
      <p>
        Argus is operated by Gabriel Ulloa ("we", "us"). For legal and privacy
        notices, we can be reached at{" "}
        <a href="mailto:privacy@argusdb.app">privacy@argusdb.app</a>.
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
        (Claude Code or OpenAI Codex CLI). These providers run as a local process on your
        machine and read your context folder from disk, but they still transmit your prompts
        and context to Anthropic's or OpenAI's servers to generate responses, subject to
        those providers' terms — unless the CLI is itself configured to use a purely local
        model.
      </p>

      <h3>Database contents</h3>
      <p>
        Data you view, query, or edit through Argus flows directly between your machine
        and the database servers you connect to. It does not pass through any
        Argus-operated server.
      </p>

      <h2>Feedback you choose to send us</h2>
      <p>
        Argus includes an optional in-app feedback dialog. This dialog is entirely
        voluntary — it must be actively opened and submitted by you. When you choose to
        submit feedback, the following data is sent to a server we operate at{" "}
        <strong>feedback.argusdb.app</strong> and stored in Amazon DynamoDB and a
        private Amazon S3 bucket:
      </p>
      <ul>
        <li>The feedback message you write;</li>
        <li>
          An optional email address, <em>only if you provide one</em>, used solely to
          follow up on your feedback;
        </li>
        <li>Any image attachments you choose to include;</li>
        <li>
          Basic technical metadata to help us diagnose issues: the app version,
          operating system and version, CPU architecture, locale, and which database
          engine type is currently active.
        </li>
      </ul>
      <p>
        <strong>Purpose:</strong> responding to your feedback, fixing bugs, and
        improving the product.
      </p>
      <p>
        This is the <strong>only</strong> data the desktop app ever sends to a server
        we operate, and it is sent only when you actively submit feedback. Feedback
        data is retained only as long as needed to act on it and is never used to build
        advertising or marketing profiles.
      </p>

      <h2>What we do NOT collect</h2>
      <p>
        No account is required to download or use Argus. The desktop app sends no
        automatic telemetry, analytics, or crash reports. We do not collect your name
        or email address except when you voluntarily include them in feedback you send
        us, as described above.
      </p>

      <h2>Data retention</h2>
      <p>
        Website access logs generated by CloudFront are retained for a limited period
        for security and operational purposes and then expire. We do not retain these
        logs indefinitely or use them to build profiles of individual visitors. Feedback
        data is retained only as long as needed to act on it.
      </p>

      <h2>International data transfers</h2>
      <p>
        When you use the AI API features, submit feedback, or simply visit the website,
        personal data may be processed on servers located in the United States or other
        countries. This includes infrastructure operated by Anthropic, OpenAI, and
        Amazon Web Services (which hosts our CloudFront CDN and feedback storage). For
        visitors in the EEA or UK, this may involve a transfer of personal data outside
        your jurisdiction. Such transfers rely on the respective service providers' own
        safeguards and, where applicable, standard contractual clauses adopted by the
        European Commission or equivalent mechanisms.
      </p>

      <h2>Your rights</h2>
      <p>
        Under the GDPR (for visitors in the EEA/UK) and the CCPA (for California
        residents), you have the right to request access to or deletion of personal data
        associated with you. In practice, the personal data we hold is limited to
        website access logs that may include your IP address, and any feedback data you
        have voluntarily submitted. To exercise these rights, contact us using the
        address below and we will respond within the applicable timeframe.
      </p>
      <p>
        We do not sell or share your personal information, and we have not done so in
        the preceding twelve months.
      </p>

      <h2>Children's privacy</h2>
      <p>
        Argus is not directed to children. The Software is intended for users aged 16
        and over, or the age of digital consent applicable in their jurisdiction,
        whichever is higher. We do not knowingly collect personal data from children. If
        you believe a child has submitted personal data to us, please contact us at{" "}
        <a href="mailto:privacy@argusdb.app">privacy@argusdb.app</a> and we will
        promptly delete it.
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

      <h2>Definitions</h2>
      <p>As used in these Terms:</p>
      <ul>
        <li>
          <strong>"Argus"</strong> or the <strong>"Software"</strong> means the Argus
          desktop application and the accompanying website at argusdb.app.
        </li>
        <li>
          <strong>"You"</strong> or <strong>"User"</strong> means any individual or
          entity that downloads, installs, or uses the Software.
        </li>
        <li>
          <strong>"AI Providers"</strong> means the third-party AI services that Argus
          can optionally integrate with, including Anthropic (Claude API and the Claude
          Code CLI) and OpenAI (OpenAI API and the OpenAI Codex CLI).
        </li>
      </ul>

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
      <p>
        <strong>
          Because Argus is provided free of charge, and to the maximum extent permitted
          by applicable law, the total aggregate liability of the authors and
          contributors of Argus for all claims of any kind arising from or related to
          the Software — whether in contract, tort, statute, or otherwise — shall not
          exceed one hundred United States dollars (USD $100).
        </strong>
      </p>

      <h2>Acceptable use</h2>
      <p>
        You are responsible for ensuring that you are legally authorized to access any
        database, data source, or account that you connect to through Argus. You must
        not use Argus to:
      </p>
      <ul>
        <li>Access any data or system without proper authorization;</li>
        <li>Violate any applicable local, national, or international law or regulation;</li>
        <li>Infringe the intellectual property, privacy, or other rights of any third party.</li>
      </ul>

      <h2>AI-generated output</h2>
      <p>
        Argus can generate SQL queries and other output via AI Providers. AI-generated
        output may be inaccurate, incomplete, or, if executed, may modify or delete
        data irreversibly.{" "}
        <strong>
          You are solely responsible for reviewing and verifying any AI-generated query
          or output before running it against any data source.
        </strong>{" "}
        We are not liable for any consequences arising from the execution of
        AI-generated output. This provision complements the "No warranty" and
        "Limitation of liability" sections above; you remain solely responsible for
        maintaining appropriate backups of your data.
      </p>

      <h2>Third-party services</h2>
      <p>
        Argus allows you to connect to external database servers and to send requests
        to third-party AI Providers (Anthropic and OpenAI). Your use of those services
        is subject to those third parties' own terms of service and privacy policies.
        You are responsible for your credentials and for ensuring you are authorized
        to access any data source you connect to through Argus.
      </p>

      <h2>Indemnification</h2>
      <p>
        You agree to indemnify and hold harmless the authors and contributors of Argus
        from and against any claims, damages, losses, liabilities, costs, and expenses
        (including reasonable legal fees) arising out of or relating to: (a) your misuse
        of the Software; (b) your violation of these Terms; or (c) your unauthorized
        access to any data source, system, or account through the Software.
      </p>

      <h2>Governing law and dispute resolution</h2>
      <p>
        These Terms are governed by and construed in accordance with the laws of
        Chile, without regard to its conflict-of-law principles. Any dispute
        arising out of or in connection with these Terms or your use of the Software
        shall be subject to the exclusive jurisdiction of the courts of Santiago, Chile.
      </p>

      <h2>Force majeure</h2>
      <p>
        Neither party shall be liable for any failure or delay in performance caused by
        circumstances beyond its reasonable control, including but not limited to natural
        disasters, acts of government, power or internet outages, or failures of
        third-party services. The affected party shall notify the other as soon as
        reasonably practicable and shall use reasonable efforts to resume performance.
      </p>

      <h2>Severability and entire agreement</h2>
      <p>
        If any provision of these Terms is held invalid, illegal, or unenforceable by a
        court of competent jurisdiction, the remaining provisions shall continue in full
        force and effect. These Terms, together with the{" "}
        <a href="/privacy">Privacy Policy</a>, constitute the entire agreement between
        you and us regarding the Software and supersede all prior communications or
        agreements relating to its subject matter.
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
