## Why

El equipo (5 personas, todas en mac) va a empezar a probar Argus a diario y necesitamos que cada merge en `master` les llegue automáticamente, sin pasos manuales. Hoy no hay CI, ni firma de código, ni mecanismo de actualización: cada release implicaría buildear local, evadir Gatekeeper, y avisar por Slack — insostenible para cadencia diaria.

## What Changes

- Pipeline de release en GitHub Actions que en cada push a `master` compila para `mac arm64` y `mac x86_64`, firma con Developer ID, notariza con `notarytool`, y publica a Cloudflare R2 (bucket público vía `r2.dev`, sin custom domain).
- Build separado para beta con identifier `com.argus.beta.app`, productName `"Argus Beta"`, e icon tintado naranja, de forma que beta y la futura release pública puedan coexistir en la misma máquina.
- Configuración Tauri partida en dos: `tauri.conf.json` (prod, queda como hoy) y `tauri.beta.conf.json` (overrides para beta — identifier, productName, icon, updater endpoint).
- Auto-actualización vía `tauri-plugin-updater`: la app revisa `latest.json` en R2 al startup y a intervalo regular, descarga en background, aplica de forma silenciosa al cerrar/relanzar la app.
- Manifest `latest.json` firmado con par Ed25519 dedicado; clave pública embebida en la app, privada solo en GitHub Secrets.
- Versión actual de la app SIEMPRE visible en el status bar, dado que las updates son silenciosas y el equipo necesita saber qué versión está corriendo cuando reportan bugs verbalmente.
- Versionado automático: cada merge a master bumpea la versión patch (`0.1.0` → `0.1.1` → ...) y crea un tag.
- Bootstrap manual documentado paso a paso en `docs/release-setup.md` (cosas que el humano tiene que hacer una vez en consolas externas: Apple Developer cert, app-specific password, R2 bucket + token, Ed25519 keypair, GH Secrets).

## Capabilities

### New Capabilities

- `release-pipeline`: cómo se compila, firma, notariza y publica un build de Argus Beta. Cubre el workflow de GitHub Actions, los secretos esperados, el contrato del manifest `latest.json`, y la disciplina de versionado.
- `app-updater`: cómo la app instalada decide cuándo actualizarse, qué URL chequea, cómo verifica la firma, y cómo aplica la update sin molestar al usuario.

### Modified Capabilities

- `app-shell`: el status bar gana un indicador permanente de versión que muestra el número de versión actual (de `tauri.conf.json`/`Cargo.toml`) y, cuando hay una update aplicada pero pendiente de relanzar, un indicador secundario.

## Impact

- **Código**:
  - Nuevo `tauri.beta.conf.json` y duplicación intencional del icon set (variante naranja en `src-tauri/icons-beta/`).
  - Nueva dependencia Rust: `tauri-plugin-updater`.
  - Nuevo módulo frontend `src/platform/updater/` con el hook `useAppVersion()` y el cableado del plugin.
  - Modificación menor de `src/platform/shell/StatusBar.tsx` para incluir el indicador de versión.
- **Infra externa** (no en repo, configurado por humano):
  - Cuenta Cloudflare con bucket R2 `argus-beta-releases` y token API.
  - Apple Developer Program: cert `Developer ID Application`, app-specific password para `notarytool`.
  - GitHub repo: secrets `APPLE_*`, `R2_*`, `TAURI_UPDATER_PRIVATE_KEY`, `TAURI_UPDATER_KEY_PASSWORD`.
- **Documentación**:
  - Nuevo `docs/release-setup.md` con instrucciones paso a paso de la parte manual.
  - Update a `README.md` apuntando a ese doc.
- **Workflow del equipo**: dejar de buildear local; cada merge a master implica un bump automático y se distribuye solo. Si un build se rompe, el equipo se queda en la versión anterior hasta que el siguiente merge arregle CI.
- **Sin impacto** en ningún módulo Postgres, ni en specs existentes salvo `app-shell` (status bar).
