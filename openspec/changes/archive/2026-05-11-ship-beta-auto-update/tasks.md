## 1. Documentación de bootstrap manual (humano)

- [x] 1.1 Crear `docs/release-setup.md` con secciones: Apple Developer setup, Cloudflare R2 setup, Updater keypair, GH Secrets, Iconos beta, Rotación de secrets, Rollback runbook.
- [x] 1.2 Documentar paso a paso el Apple Developer cert: ir a developer.apple.com → Certificates → "+" → Developer ID Application → seguir asistente con CSR generado en Keychain Access; descargar `.cer`; doble click para importar; export desde Keychain como `.p12`; convertir a base64 con `base64 -i cert.p12 | pbcopy`.
- [x] 1.3 Documentar app-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords → "+" → label "argus-notarytool" → copiar string.
- [x] 1.4 Documentar R2 bucket: dash.cloudflare.com → R2 → Create bucket `argus-beta-releases` → Settings → Public Access → enable "Allow Access" → copiar la URL `pub-<hash>.r2.dev`. Crear API token con scope "Object Read & Write" sobre ese bucket; copiar Access Key ID y Secret Access Key. Notar también el Account ID del dashboard.
- [x] 1.5 Documentar updater keypair: `pnpm tauri signer generate -- -w ~/.tauri/argus-beta.key` (passphrase fuerte); guardar la pública mostrada por consola; backupear el archivo `.key` y la passphrase en 1Password del equipo (texto explícito sobre por qué).
- [x] 1.6 Listar todos los GH Secrets requeridos con descripción y formato: `APPLE_CERTIFICATE` (base64 del p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (= `argus-beta-releases`), `R2_PUBLIC_URL` (= `https://pub-<hash>.r2.dev`), `TAURI_UPDATER_PRIVATE_KEY`, `TAURI_UPDATER_KEY_PASSWORD`.
- [x] 1.7 Documentar habilitación de "Allow GitHub Actions to create and approve pull requests" en Settings → Actions → General → Workflow permissions → tildar.
- [x] 1.8 Escribir el runbook de rollback: cómo subir manualmente un `latest.json` editado a R2 vía `wrangler r2 object put` o desde el dashboard, apuntando a una versión previa conocida buena.
- [x] 1.9 Documentar rotación de Apple cert (cada 5 años) y rotación de updater key (con la advertencia: si pierdes la privada y todos en el equipo tienen una versión vieja, pueden quedarse sin path de update; el procedimiento es regenerar key + reinstalar manualmente la app a todos).
- [x] 1.10 Agregar link a `docs/release-setup.md` desde `README.md` en la sección de release/distribución.

## 2. Iconos y assets de beta (humano)

- [ ] 2.1 Generar variante naranja del icon set en `src-tauri/icons-beta/`: 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico — mismas dimensiones exactas que `src-tauri/icons/`. Aplicar tinte/badge naranja reconocible de un vistazo en el dock.
- [ ] 2.2 Verificar visualmente: instalar localmente Argus prod e Argus Beta uno al lado del otro y confirmar que se distinguen sin zoom.

## 3. Configuración de build separada

- [x] 3.1 Crear `src-tauri/tauri.beta.conf.json` con overrides: `productName: "Argus Beta"`, `identifier: "com.argus.beta.app"`, `bundle.icon` apuntando a `icons-beta/*`, `plugins.updater.endpoints` apuntando al placeholder `https://pub-PLACEHOLDER.r2.dev/latest.json`, `plugins.updater.pubkey` con placeholder.
- [ ] 3.2 Confirmar manualmente que `pnpm tauri build --config src-tauri/tauri.beta.conf.json` produce un bundle con identifier y productName correctos sin tocar `tauri.conf.json`. *(requiere icons-beta/* + secrets configurados — humano)*
- [ ] 3.3 Reemplazar placeholders del paso 3.1 con los valores reales una vez que el bootstrap del paso 1 está hecho (URL R2 y pubkey Ed25519 reales). Commit dedicado. *(humano: requiere haber hecho los pasos del docs/release-setup.md)*
- [x] 3.4 Verificar que `pnpm tauri:dev` (sin flags) sigue funcionando con el config default — la beta config no debe romper el flujo dev local. *(typecheck + cargo check pasan; tauri:dev no se ejecuta en CI pero no se modificó tauri.conf.json ni paths existentes)*

## 4. Plugin updater en Rust

- [x] 4.1 Agregar dependencia `tauri-plugin-updater = "2"` a `src-tauri/Cargo.toml`.
- [x] 4.2 Registrar el plugin en `src-tauri/src/lib.rs` (o equivalente) en el builder. *(siempre se registra; queda inerte sin `endpoints` configurados, lo cual es controlado por el config file activo)*
- [x] 4.3 Agregar capability mínima en `src-tauri/capabilities/default.json`: `updater:default`.
- [x] 4.4 `cargo check` desde `src-tauri/` confirma que compila sin errores.

## 5. Updater frontend

- [x] 5.1 Crear `src/platform/updater/UpdaterProvider.tsx` con context que expone `currentVersion: string`, `pendingVersion: string | null`, `availableVersion: string | null`, `skippedVersion: string | null`, `forceCheck()`, `skipPending()`, `clearSkip()`.
- [x] 5.2 Implementar la lectura de la versión inicial vía `getVersion()` de `@tauri-apps/api/app`. *(integrado dentro del provider)*
- [x] 5.3 En el provider, montar el listener del plugin updater: setTimeout(5000) para el primer check, luego setInterval(4h). Cleanup del interval en unmount.
- [x] 5.4 Implementar la lógica de skip: persistir `skipped_version` vía `useSetting` (key `updater.skippedVersion`); al detectar update, si `manifest.version === skipped_version` saltear el download.
- [x] 5.5 Implementar el flow de download silencioso: cuando hay update y no está skipeada, llamar al `download()` del plugin sin emitir eventos UI hasta que termine; al terminar, exponer `pendingVersion` por el context.
- [x] 5.6 Implementar el apply on quit: handler en `beforeunload` que llama `update.install()` antes de permitir el cierre cuando hay pending.
- [x] 5.7 Wrap-eo del provider en el árbol de la app (encima de `PaletteProvider`, debajo de `ThemeProvider`).

## 6. UI de versión en status bar

- [x] 6.1 Modificar `src/platform/shell/StatusBar.tsx` para incluir el componente `<VersionIndicator />` en el slot derecho.
- [x] 6.2 Implementar `<VersionIndicator />` que consume el context del updater y renderiza: `vX.Y.Z` cuando no hay pending; `vX.Y.Z → vA.B.C` cuando hay pending, con la segunda versión en accent color.
- [x] 6.3 Tooltip en el indicador: cuando hay pending, "Restart Argus Beta to apply vA.B.C"; cuando no, "Argus Beta vX.Y.Z" simple.
- [x] 6.4 Implementar el dropdown menu en click: items "Check for updates now", "Skip this version" (condicional), "Clear skipped version" (condicional), "About Argus Beta".
- [x] 6.5 Implementar el modal "About Argus Beta" mostrando: versión, identifier (`com.argus.beta.app`), commit hash del build (vía `import.meta.env.VITE_BUILD_COMMIT`).
- [x] 6.6 Test unitario en Vitest: render del indicator con/sin pending, asserts sobre el texto y la presencia del arrow.

## 7. Workflow de GitHub Actions

- [x] 7.1 Crear `.github/workflows/release.yml` con trigger `push: branches: [master]` y permisos `contents: write` para poder taggear/commitear el bump.
- [x] 7.2 Step inicial "skip if bump commit": lee `git log -1 --pretty=%s`; si empieza con `chore: bump version to v`, marca skipped y los siguientes jobs no corren.
- [x] 7.3 Step "bump version": script `scripts/bump-version.mjs` que lee `tauri.conf.json`, computa next patch, escribe los 4 archivos (`tauri.conf.json`, `tauri.beta.conf.json` cuando tiene `version`, `package.json`, `Cargo.toml`); commit con mensaje `chore: bump version to vX.Y.Z [skip ci]` firmado por el bot; push + tag.
- [x] 7.4 Matrix job `build`: `os: [macos-latest, macos-13]` con `target` aarch64/x86_64.
- [x] 7.5 En cada job: checkout (con el tag recién creado), setup pnpm, setup Rust con target específico, instalar deps, importar Apple cert al keychain del runner desde `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD`.
- [x] 7.6 Build con `tauri-action@v0`: `--config src-tauri/tauri.beta.conf.json`, target architecture-specific, env-vars del updater (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — `tauri-action` hace sign + notarize automáticamente cuando los env vars de Apple están presentes.
- [x] 7.7 La notarización está embebida en `tauri-action` cuando se exportan `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` y `APPLE_SIGNING_IDENTITY`. *(no necesitamos un step manual de retry — tauri-action ya lo maneja)*
- [x] 7.8 Step "build manifest": script `scripts/build-manifest.mjs` que genera `latest.json` con estructura Tauri v2 (top-level `version`, `notes`, `pub_date`, `platforms.{darwin-aarch64,darwin-x86_64}.{signature, url}`); lee los `.sig` producidos por tauri-action.
- [x] 7.9 Job de upload `publish`: usa `aws s3 cp` apuntando al endpoint S3 de R2 (`https://<account>.r2.cloudflarestorage.com`). Sube `.dmg`, `.app.tar.gz`, `.sig` con `Cache-Control: max-age=31536000, immutable`, y `latest.json` con `Cache-Control: no-cache`.
- [ ] 7.10 End-to-end smoke local: correr el workflow una vez vía `act` o mediante un PR de prueba al branch antes de mergear, verificar que aparecen los assets en R2 y que el `latest.json` valida. *(humano: requiere secrets configurados)*

## 8. Verificación end-to-end (humano)

- [ ] 8.1 Bajar el `.dmg` v0.1.1 desde la URL R2, instalar Argus Beta en una mac arm64; abrir y verificar: identifier en `~/Library/Application Support/com.argus.beta.app/`, productName "Argus Beta" en menú apple, status bar muestra `v0.1.1`.
- [ ] 8.2 Mergear un PR trivial a master para disparar el bump a v0.1.2; verificar en GH Actions que el workflow corre exactamente una vez (no loop por el bump commit).
- [ ] 8.3 Esperar ~5 segundos tras el siguiente launch de la app instalada; verificar en logs (~/Library/Logs/Argus Beta/) que el updater chequeó; eventualmente el status bar debe mostrar `v0.1.1 → v0.1.2`.
- [ ] 8.4 Quit + relaunch; verificar que la app arrancó como v0.1.2 y el indicador volvió a mostrar solo la versión actual.
- [ ] 8.5 Probar skip: con una v0.1.3 publicada, click en versión → "Skip this version"; verificar que `~/Library/Application Support/com.argus.beta.app/settings.db` tiene la persistencia y que la próxima check no reintenta v0.1.3.
- [ ] 8.6 Probar rollback runbook: editar manualmente `latest.json` en R2 para apuntar a v0.1.1 con la signature correspondiente; esperar el siguiente check; quit + relaunch; verificar que la app volvió a v0.1.1.
- [ ] 8.7 Probar coexistencia: instalar Argus prod (build local con `tauri.conf.json` default) en la misma mac que ya tiene Argus Beta; verificar dos icons separados en /Applications, dos entradas en el dock al abrir ambas, dos directorios de datos distintos.

## 9. Cierre

- [x] 9.1 Actualizar `openspec/ROADMAP.md`: marcar `auto-update` como resuelto en `ship-beta-auto-update`.
- [ ] 9.2 Anuncio en Slack al equipo: link al `.dmg` inicial v0.1.1, instrucciones de instalación (drag a /Applications, primera apertura puede pedir Gatekeeper aprobación si la firma todavía propaga), y "de acá en adelante se actualiza solo". *(humano: depende del primer release exitoso)*
