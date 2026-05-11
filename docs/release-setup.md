# Argus release setup

Bootstrap procedure to wire up the Argus release pipeline. Do this **once**. Every step here is something Claude/CI cannot do for you because it lives in external dashboards, your keychain, or 1Password.

After this doc is fully run, every merge to `master` produces a signed, notarized build that auto-installs on the team's macs.

---

## What you'll set up

```
1. Apple Developer ID Application certificate    (sign the .app)
2. App-specific password for notarytool          (notarize the .app)
3. Cloudflare R2 bucket + API token              (host the artifacts)
4. Updater Ed25519 keypair                       (sign latest.json)
5. GitHub repository secrets                     (CI consumes 1–4)
6. GitHub Actions workflow permission toggle     (let the bot push commits)
```

Total wall-clock: ~2 hours, most of which is waiting on Apple.

---

## 1. Apple Developer ID Application certificate

Required to sign the `.app` so macOS Gatekeeper accepts it without "damaged" warnings.

**Prereq:** active Apple Developer Program membership ($99/yr).

### 1.1 Generate a Certificate Signing Request (CSR)

1. Open **Keychain Access** on your mac.
2. Menu: **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority…**
3. Fill: User Email = your Apple ID, Common Name = `Argus CSR`, leave CA Email empty.
4. Select **Saved to disk**, save somewhere temporary (e.g. `~/Downloads/CertificateSigningRequest.certSigningRequest`).

### 1.2 Create the Developer ID Application certificate

1. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates).
2. Click the **+** button.
3. Under **Software**, choose **Developer ID Application** → Continue.
4. Upload the `.certSigningRequest` from step 1.1 → Continue.
5. Download the resulting `.cer` file.
6. Double-click the `.cer` to import it into your **login** keychain. Verify it appears under Keychain Access → login → My Certificates as something like `Developer ID Application: <Your Name> (<TEAM_ID>)`.

### 1.3 Export to .p12 + base64

The CI runner will load the cert from a base64-encoded `.p12`.

1. In Keychain Access, find the cert from step 1.2. **Expand it** so you see the private key beneath it. Select **both** (cert + private key).
2. Right-click → **Export 2 items…** → format **Personal Information Exchange (.p12)** → save as `argus-developer-id.p12` somewhere private.
3. Set a strong export password. **Save it in 1Password** as `Argus — APPLE_CERTIFICATE_PASSWORD`.
4. Convert to base64 + put on clipboard:

   ```sh
   base64 -i argus-developer-id.p12 | pbcopy
   ```

   Save in 1Password as `Argus — APPLE_CERTIFICATE`.

### 1.4 Note your Team ID

From [developer.apple.com/account](https://developer.apple.com/account) (top-right). 10-character string like `ABC123DE45`. Save in 1Password as `Argus — APPLE_TEAM_ID`.

---

## 2. App-specific password for notarytool

`notarytool` (the modern Apple notarization CLI) needs an Apple ID + an **app-specific password**, not your real Apple ID password.

1. Go to [appleid.apple.com](https://appleid.apple.com) → sign in.
2. **Sign-In and Security → App-Specific Passwords → Generate password…**
3. Label: `argus-notarytool`.
4. Copy the resulting string (`xxxx-xxxx-xxxx-xxxx`).
5. Save in 1Password as `Argus — APPLE_PASSWORD`. Also record your Apple ID email as `Argus — APPLE_ID`.

> If you lose this password, regenerate. Apple does not show it again.

---

## 3. Cloudflare R2 bucket + API token

R2 hosts the `.dmg`, `.app.tar.gz`, `.sig` files, and the `latest.json` manifest the updater fetches.

### 3.1 Create the bucket

1. Sign up / log in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Left nav: **R2 Object Storage**. If first time, follow the setup; R2 has a generous free tier.
3. **Create bucket** → name `argus-releases` → location: Automatic → Create.

### 3.2 Enable public access

The bucket exposes a `pub-<hash>.r2.dev` URL.

1. In the new bucket, go to **Settings**.
2. Under **Public access** → **R2.dev subdomain** → click **Allow Access**. Confirm the dev-mode caveat.
3. Cloudflare will assign a URL like `https://pub-9f3a1b7e.r2.dev`. **Copy this.** Save in 1Password as `Argus — R2_PUBLIC_URL`.

> The `r2.dev` URL is rate-limited (Cloudflare warns it's "for development"). For ~5 team members it's plenty. When we go to public release we'll add a custom domain — that's a one-line change in `tauri.conf.json` plus republishing.

### 3.3 Create an API token scoped to the bucket

1. Go to **R2 → Manage R2 API Tokens** (top-right of the R2 dashboard).
2. **Create API token**.
3. Token name: `argus-ci`.
4. Permissions: **Object Read & Write**.
5. Specify bucket: `argus-releases` (NOT all buckets).
6. TTL: Forever (or set a calendar reminder for rotation).
7. Create. Cloudflare shows **Access Key ID** and **Secret Access Key**.

Save in 1Password:

- `Argus — R2_ACCESS_KEY_ID`
- `Argus — R2_SECRET_ACCESS_KEY`

### 3.4 Note your account ID

From the R2 dashboard, top-right (or **Account Home → Account ID**). Looks like `1a2b3c4d5e6f7g8h9i0j`. Save as `Argus — R2_ACCOUNT_ID`.

---

## 4. Updater Ed25519 keypair

`tauri-plugin-updater` requires a separate keypair from the Apple cert. The public key is embedded in every build; the private key signs the `latest.json` manifest in CI. **If you lose the private key, you lose the ability to ship updates** to apps in circulation.

### 4.1 Generate

```sh
mkdir -p ~/.tauri
pnpm tauri signer generate -- -w ~/.tauri/argus.key
```

You'll be prompted for a passphrase. **Use a strong one.** Don't skip.

The command prints two things:
- The **public key** (base64 string, ~88 chars). Looks like `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6...`.
- The **private key** is written to `~/.tauri/argus.key`.

### 4.2 Save in 1Password (CRITICAL)

Save four entries:
- `Argus — TAURI_UPDATER_PUBLIC_KEY` (paste the public key string).
- `Argus — TAURI_UPDATER_PRIVATE_KEY` (paste the **contents** of `~/.tauri/argus.key`, i.e. `cat ~/.tauri/argus.key`).
- `Argus — TAURI_UPDATER_KEY_PASSWORD` (the passphrase).
- Attach the actual `.key` file as a secure attachment too, as a belt-and-suspenders backup.

> If both this file and 1Password are lost, every team member must manually reinstall a fresh `.dmg` next time we ship. No way around it.

### 4.3 Put the public key in tauri.conf.json

Open `src-tauri/tauri.conf.json` and replace the `pubkey` placeholder with the public key value from step 4.1. The full URL `https://pub-<hash>.r2.dev/latest.json` (with R2_PUBLIC_URL from step 3.2) goes into the `endpoints` array.

Commit this. The public key is **not** secret — it must ship in every build.

---

## 5. GitHub repository secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add each of these. Names matter — the workflow reads them by exact name.

| Secret name | Value | Source |
|-------------|-------|--------|
| `APPLE_CERTIFICATE` | base64 of the `.p12` | step 1.3 |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting `.p12` | step 1.3 |
| `APPLE_ID` | your Apple ID email | step 2 |
| `APPLE_PASSWORD` | app-specific password | step 2 |
| `APPLE_TEAM_ID` | 10-char team ID | step 1.4 |
| `R2_ACCOUNT_ID` | Cloudflare account ID | step 3.4 |
| `R2_ACCESS_KEY_ID` | R2 token access key | step 3.3 |
| `R2_SECRET_ACCESS_KEY` | R2 token secret | step 3.3 |
| `R2_BUCKET` | `argus-releases` | step 3.1 |
| `R2_PUBLIC_URL` | `https://pub-<hash>.r2.dev` | step 3.2 |
| `TAURI_UPDATER_PRIVATE_KEY` | contents of `~/.tauri/argus.key` | step 4.2 |
| `TAURI_UPDATER_KEY_PASSWORD` | passphrase | step 4.2 |

Double-check spellings before saving. The workflow fails fast if any is missing.

---

## 6. Allow GitHub Actions to commit + tag

The workflow's first job bumps the version, commits, and tags. By default GH Actions can't push back to the repo.

1. Repo **Settings → Actions → General**.
2. Scroll to **Workflow permissions**.
3. Select **Read and write permissions**.
4. Tick **Allow GitHub Actions to create and approve pull requests**.
5. Save.

---

## 7. First release

Once 1–6 are done:

1. Merge a trivial PR to `master` (or push the bootstrap commit).
2. Watch GH Actions: the workflow should bump `0.1.0` → `0.1.1`, build for both architectures, sign, notarize, sign the manifest, upload to R2.
3. Open `https://pub-<hash>.r2.dev/latest.json` in a browser — should show JSON with two platform entries and signatures.
4. Download `https://pub-<hash>.r2.dev/Argus_0.1.1_aarch64.dmg` (or `_x64.dmg` on Intel macs), install it, launch.
5. The status bar should show `v0.1.1`. Within 5 seconds of launch the updater performs its first check (find nothing newer, since you just shipped it).
6. Drop the `.dmg` link in Slack. From the next merge onward, everyone with the app open auto-updates silently.

---

## Rotation

### Apple Developer ID certificate

The cert is valid for **5 years**. Set a calendar reminder ~6 months out from expiry.

When it expires:
1. Repeat steps 1.1–1.4 with the new cert.
2. Update `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` in repo secrets.
3. Next release ships signed by the new cert. macOS does not invalidate already-installed apps when the cert changes — they keep working.

### App-specific password

If revoked or rotated:
1. Regenerate at appleid.apple.com.
2. Update `APPLE_PASSWORD` in repo secrets.

### R2 API token

Best practice: rotate annually. To rotate:
1. Create a new token (step 3.3) with the same permissions.
2. Update `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` in repo secrets.
3. Verify a release run succeeds.
4. Revoke the old token from the R2 dashboard.

### Updater Ed25519 keypair

**Avoid rotating unless you have to.** Rotation means: every team member who is on a version older than the rotation must manually reinstall a fresh `.dmg`, because their app's embedded public key won't match the new manifest signatures.

If you must (e.g., the private key was leaked):
1. Generate a new keypair (step 4.1).
2. Update `TAURI_UPDATER_PRIVATE_KEY`, `TAURI_UPDATER_KEY_PASSWORD` in repo secrets.
3. Update `pubkey` in `tauri.conf.json` and merge.
4. The next release will be signed by the new key. Apps with the OLD pubkey will reject it.
5. Distribute the new `.dmg` to every team member by Slack/Drive. They must reinstall manually.
6. After they reinstall, future updates resume normally.

---

## Rollback runbook

If a build breaks the team and you need to revert them all to a previous good version, you can publish a hand-edited `latest.json` to R2.

### Quick path (Cloudflare dashboard)

1. Go to **R2 → argus-releases → Objects**.
2. Open `latest.json` in a text editor (download, edit, re-upload).
3. Edit the `version` field to match the last good version (e.g. `0.1.5`).
4. Edit the `platforms.darwin-aarch64.url` and `darwin-x86_64.url` to point at the still-uploaded artifacts of that version (e.g. `Argus_0.1.5_aarch64.app.tar.gz`).
5. Edit the `signature` fields to match those previous archives. **The signatures are stored in the `.sig` files alongside the archives.** Download `Argus_0.1.5_aarch64.app.tar.gz.sig` and copy its contents into the `signature` field. Same for x86_64.
6. Save. Set `Cache-Control: no-cache` on `latest.json` if not already set.

### Verifying the rollback

The team's apps will detect the "new" (actually older) version on their next 4-hour check, download it, and apply on next quit. They downgrade silently.

If you need them on the old version *immediately*, ask them in Slack to:
1. Quit Argus.
2. Open `~/Library/Application Support/com.argus.app/` and clear nothing — data persists across versions.
3. Reopen — within 5 seconds the updater triggers; or click `v0.1.x` in the status bar → **Check for updates now**.

### Forward path

Once rollback is in place, push a fix commit → next release publishes a fresh higher version → team auto-updates to it. Don't manually edit `latest.json` for normal releases — only for emergencies.

---

## Troubleshooting

**Workflow fails at the notarize step with "altool: 401 Unauthorized"** — `APPLE_PASSWORD` is wrong or expired. Regenerate the app-specific password, update the secret.

**Workflow fails at "import certificate" with "security: SecKeychainItemImport: One or more parameters passed to a function were not valid."** — `APPLE_CERTIFICATE` base64 is corrupted (often from line-wrapping). Re-run `base64 -i cert.p12 | pbcopy` (no flags that wrap) and update the secret.

**App opens but never auto-updates** — open the log: `~/Library/Logs/Argus/argus.log`. Common causes: endpoint URL wrong (typo in `R2_PUBLIC_URL`), pubkey mismatch (the build embedded a different pubkey than what signs the manifest now — check that the value in `tauri.conf.json` matches the current `TAURI_UPDATER_PRIVATE_KEY`), R2 returning 404 for `latest.json` (the upload step may have failed silently — check the workflow run).

**`r2.dev` URL throws 1015 / rate limit** — usually transient. If sustained, you've hit Cloudflare's free-tier dev URL caps. Sign up for a custom domain on Cloudflare (free), bind to the R2 bucket, replace the URL in `tauri.conf.json`. The team's apps will continue using the old URL until they auto-update to a build that has the new URL — to force migration, manually distribute one fresh `.dmg`.
