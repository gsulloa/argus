## ADDED Requirements

### Requirement: The changelog is bundled with the build

The application SHALL bundle the root `CHANGELOG.md` at build time so the changelog shown by a running build matches exactly what shipped in that build. A prebuild step MUST copy the root `CHANGELOG.md` into a generated location under the app package that the frontend imports as raw text; the generated copy MUST be gitignored and MUST be produced by both the `dev` and `build` npm scripts. The application MUST NOT fetch the changelog from a remote source or read it from disk at runtime.

#### Scenario: Bundled changelog matches the build

- **WHEN** the app is built and launched
- **THEN** the changelog it displays is the content of the root `CHANGELOG.md` as of that build, with no network request

#### Scenario: Generated copy is not committed

- **WHEN** the repository is inspected after a build
- **THEN** the generated changelog copy is ignored by git and not tracked

### Requirement: The changelog is reachable from the command palette

The command palette SHALL expose an entry that opens the changelog viewer. The entry MUST be grouped under "Help", labelled to reflect showing the changelog / "what's new", and MUST be discoverable via keywords including `changelog`, `release`, `notes`, `what's new`, and `version`.

#### Scenario: User opens the changelog from the palette

- **WHEN** the user invokes the "Help: Show changelog" command from the palette
- **THEN** the changelog viewer opens

### Requirement: The viewer renders the changelog per the design system

The changelog viewer SHALL parse the bundled changelog into structured versions and render them in reverse-chronological order, each version showing its date and its changes grouped under Added/Changed/Fixed/Removed. Rendering MUST conform to `DESIGN.md` (Geist type scale, violet-only accent, hairline borders, defined radii and motion tokens) and MUST NOT introduce decorative gradients or non-conforming styling. Inline links in entries MUST render as links. The parser MUST NOT throw on unexpected content: unknown group headings render under their literal name and non-list lines render as text.

#### Scenario: Versions render newest-first with grouped changes

- **WHEN** the viewer is open
- **THEN** version sections appear newest-first, each with its date and its changes grouped under the appropriate headings

#### Scenario: Malformed entry does not crash the viewer

- **WHEN** the changelog contains a heading or line the parser does not recognize
- **THEN** the viewer still renders, showing the unrecognized content as plain text rather than failing

### Requirement: The current version is highlighted

The viewer SHALL indicate the currently running application version, obtained from the Tauri app version API, and MUST visually highlight the changelog section matching that version using the accent treatment reserved for active surfaces.

#### Scenario: Running version section is highlighted

- **WHEN** the viewer is open and the running version has a matching changelog section
- **THEN** that section is visually highlighted as the current version

### Requirement: A "What's new" prompt appears after an update

The application SHALL persist the last changelog version seen by the user. On launch, after the running version resolves: if no last-seen version is stored, the app MUST silently seed it to the current version without opening the viewer; if the stored last-seen version is older than the current version, the app MUST automatically open the viewer highlighting the versions newer than the last-seen version, then update the stored last-seen version to the current version. Opening the viewer manually from the palette MUST NOT change the stored last-seen version. Auto-open MUST be suppressed when the app version is unavailable (non-Tauri runtime).

#### Scenario: Existing users are not nagged on first rollout

- **WHEN** the app launches for the first time after this feature ships and no last-seen version is stored
- **THEN** the last-seen version is silently set to the current version and the viewer does not auto-open

#### Scenario: Viewer auto-opens after an update

- **WHEN** the app launches with a stored last-seen version older than the current version
- **THEN** the viewer auto-opens highlighting the changes since the last-seen version, and the last-seen version is updated to the current version

#### Scenario: Manual open does not affect the prompt state

- **WHEN** the user opens the changelog from the palette
- **THEN** the stored last-seen version is unchanged
