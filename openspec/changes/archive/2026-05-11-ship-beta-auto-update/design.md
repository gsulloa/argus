## Context

Argus es una app Tauri 2 que hoy se compila localmente con `pnpm tauri:build` y no tiene mecanismo de distribución ni de actualización. Vamos a entrar a un beta cerrado con ~5 personas del equipo (todas en mac, mezcla de Apple Silicon y x86_64) que probarán la app a diario; el feedback se da verbalmente.

El stack confirmado:
- **Build**: GitHub Actions con `tauri-action`, matrix `macos-latest` (arm64) + `macos-13` (x86_64).
- **Firma**: Apple Developer ID Application + notarytool (cuenta del Apple Developer Program ya disponible).
- **Hosting**: Cloudflare R2 con bucket público vía `https://pub-<hash>.r2.dev` (no hay custom domain por ahora; el rate-limit de R2 dev URL es holgado para 5 personas y se puede sumar dominio después sin migrar binarios).
- **Updater**: `tauri-plugin-updater` v2, manifest `latest.json` firmado con keypair Ed25519 dedicado.
- **Identifier separado**: la app de beta usa `com.argus.beta.app` y productName `"Argus Beta"` para coexistir con la futura release pública (`com.argus.app` / `"Argus"`) en la misma máquina sin pisarse.

Fuera de alcance explícito en esta change: Windows (nadie del equipo lo usa), Linux, telemetría, crash reports, canales múltiples (solo existe el canal `beta`), staged rollouts, A/B.

## Goals / Non-Goals

**Goals:**
- Cada merge a `master` produce un build firmado y notarizado que llega automáticamente a las 5 macs del equipo en minutos.
- La app instalada se actualiza de forma silenciosa (descarga en background, aplica al cerrar/relanzar) sin interrumpir el trabajo del usuario.
- La versión actualmente corriendo es visible permanentemente en el status bar para que cuando el equipo reporte "está roto X" el dev sepa instantáneamente qué versión usaron.
- El humano puede hacer el setup inicial (Apple cert, R2 bucket, secrets) siguiendo `docs/release-setup.md` paso a paso, sin haberlo hecho antes.
- La beta y la futura release pública son apps macOS distintas: pueden convivir, tienen icons distintos, identifiers distintos, updaters apuntando a manifests distintos.

**Non-Goals:**
- Updater "con prompt" — el equipo eligió silencioso.
- Update servers gestionados (CrabNebula, Tauri Cloud). Vamos directo a R2 para mantener cero lock-in.
- Rollback automático ante crashes en startup. Si un build rompe, se arregla pusheando el siguiente.
- Skip-this-version *for-ever*. Nadie del equipo va a saltearse versiones por mucho tiempo en un beta diario.
- Universal binary (un único `.dmg` con arm64+x86_64). Mantenemos dos `.dmg` separados — más simple en CI y al debuggear.
- Migración de datos local entre versiones. Ya tenemos migraciones SQLite; el updater no toca nada del DB.

## Decisions

### Decision 1: Dos config files, no templating

Mantener `tauri.conf.json` como está (será la futura prod) y agregar `tauri.beta.conf.json` que extiende vía la convención de Tauri 2 `tauri build --config tauri.beta.conf.json`.

`tauri.beta.conf.json` solo contiene los overrides:
```json
{
  "productName": "Argus Beta",
  "identifier": "com.argus.beta.app",
  "bundle": {
    "icon": [
      "icons-beta/32x32.png",
      "icons-beta/128x128.png",
      "icons-beta/128x128@2x.png",
      "icons-beta/icon.icns",
      "icons-beta/icon.ico"
    ]
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://pub-<HASH>.r2.dev/latest.json"],
      "pubkey": "<EMBEDDED_AT_BUILD_TIME>"
    }
  }
}
```

Alternativas consideradas:
- **`sed`/templating en CI** que reescribe `tauri.conf.json` antes del build: quema el archivo en el repo, ensucia diffs, hace `pnpm tauri:dev` divergir del CI. Rechazado.
- **Config único con flag `--features beta`** en Cargo: Tauri config no soporta condicionales. Rechazado.
- **Variable de entorno `TAURI_BUNDLE_IDENTIFIER`**: Tauri 2 no la respeta para `identifier`. Rechazado.

### Decision 2: Hosting en R2, URL `r2.dev` pública sin custom domain

El bucket `argus-beta-releases` queda en modo "Public bucket" de R2, lo que expone una URL del estilo `https://pub-<hash>.r2.dev/<key>`. Subimos:
- `latest.json` (manifest del updater, firmado Ed25519)
- `Argus_Beta_<version>_aarch64.app.tar.gz` (bundle macOS arm64 que el updater consume)
- `Argus_Beta_<version>_x64.app.tar.gz` (bundle macOS x86_64)
- `Argus_Beta_<version>_aarch64.dmg` (instalador para nuevos miembros del equipo)
- `Argus_Beta_<version>_x64.dmg`
- Sus respectivos `.sig` (firmas Ed25519 separadas, formato Tauri).

La integridad la garantiza la firma Ed25519 del manifest; la URL siendo "pública pero unguessable" es solo defensa en profundidad. Cualquier modificación al binario sin la clave privada hace que el updater rechace la update. La app no contiene datos sensibles propios — las creds de DB las pone cada usuario en su keychain.

Alternativas consideradas:
- **GH Releases privadas + token embebido en la app**: el token vive en el binario, cualquiera con acceso a la app lo extrae. Antipatrón. Rechazado.
- **GH Releases privadas + Worker/Lambda proxy**: agrega una pieza móvil más para resolver un problema que la firma del manifest ya resuelve. Postergado.
- **R2 con custom domain**: el equipo no tiene uno listo aún. Se puede sumar después cambiando el `endpoint` en `tauri.beta.conf.json` y publicando en ambos por una versión, sin migrar las apps instaladas (la URL nueva la lee la app después del primer auto-update que incluya el cambio).

### Decision 3: Versioning automático en cada merge a `master`

Workflow `release.yml` corre en `push: master`. El primer step:
1. Lee la versión de `tauri.conf.json` (e.g. `0.1.0`).
2. Calcula la siguiente patch (`0.1.1`).
3. Bumpea `tauri.conf.json`, `tauri.beta.conf.json`, `package.json`, `src-tauri/Cargo.toml` (todos al unísono).
4. Crea un commit `chore: bump version to v0.1.1 [skip ci]` en master, atribuido al bot.
5. Crea un tag `v0.1.1` y lo pushea.
6. El resto del workflow buildea contra ese tag.

`[skip ci]` previene loop infinito. La regla "todo merge bumpea patch" es deliberadamente naïve — no semver real, no minor/major. Una vez en producción podemos sofisticar; hoy queremos predictibilidad.

Alternativas consideradas:
- **Tags manuales** (`git tag v0.1.1 && git push --tags`): se olvida, frena cadencia. Rechazado.
- **Conventional commits + semantic-release**: overkill para un beta de 5 personas. Postergado.
- **Branch dedicada `beta`**: introduce divergencia y el equipo solo va a usar beta por ahora. Rechazado.

### Decision 4: Auto-update silencioso con skip-this-version

El plugin chequea `latest.json` al startup y cada 4 horas mientras la app esté abierta. Cuando hay versión nueva, **descarga en background** sin avisar. Cuando la descarga termina, marca un flag interno `update_pending = true` y un texto en el status bar (`v0.1.5 → v0.1.7 al relanzar`). La update se aplica al próximo `app quit` (sea por ⌘Q o cierre de ventana).

El equipo puede saltearse una versión específica desde un menú "About Argus Beta" → "Skip this version". Se persiste un flag local `skipped_version: "0.1.7"`; el updater ignora exactamente esa versión y vuelve a chequear normalmente cuando aparezca `0.1.8`.

```
Startup ─▶ check latest.json ─▶ ¿hay versión nueva?
                                  │
                                  ├─ no  ─▶ siguiente check en 4h
                                  └─ sí ─▶ ¿está skipeada?
                                           │
                                           ├─ sí ─▶ ignorar, siguiente check
                                           └─ no ─▶ download bg ─▶ flag pending ─▶
                                                    status bar muestra "→ vNEW"
                                                    │
                                                    └─ on quit ─▶ apply ─▶ next launch corre vNEW
```

Alternativas consideradas:
- **Prompt clásico ("hay v0.1.7, instalar?")**: el equipo lo descartó porque querría aplicar siempre. Rechazado.
- **Apply inmediato en background mid-session**: rompe estado in-memory (conexiones abiertas, queries en curso). Rechazado.
- **Skip-forever**: para 5 personas y cadencia diaria es feature-creep. Rechazado.

### Decision 5: Versión visible permanente en el status bar

El status bar (`src/platform/shell/StatusBar.tsx`) gana un slot a la derecha del todo: `v0.1.5` en gris discreto. Cuando hay una update descargada y pendiente, cambia a `v0.1.5 → v0.1.7` con el segundo número en el color de acento, tooltip "Restart to apply".

La versión se obtiene vía `getVersion()` de `@tauri-apps/api/app`, que lee `tauri.conf.json` en build time — siempre coincide con el binario corriendo, no con lo que diga el package.json u otro file.

Alternativas consideradas:
- **Solo en "About"**: muy escondido para feedback verbal. Rechazado.
- **Toast cuando aplica**: pasa rápido, no sirve si te preguntan dos horas después. Rechazado.

### Decision 6: Setup manual documentado en `docs/release-setup.md`

El humano tiene que hacer (una vez) cosas que Claude/CI no pueden hacer:

1. **Apple Developer**: en developer.apple.com, generar `Developer ID Application` cert; descargar `.p12`; exportar a base64 → `APPLE_CERTIFICATE` (GH secret); password del p12 → `APPLE_CERTIFICATE_PASSWORD`; crear app-specific password → `APPLE_PASSWORD`; team ID → `APPLE_TEAM_ID`; apple ID email → `APPLE_ID`.
2. **Cloudflare R2**: en dash.cloudflare.com, crear bucket `argus-beta-releases`, habilitarlo como Public bucket, tomar la URL `https://pub-<hash>.r2.dev`. Crear API token con permisos R2 (read+write sobre ese bucket) → secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Anotar la URL pública en `tauri.beta.conf.json`.
3. **Updater keypair**: localmente, `pnpm tauri signer generate -- -w ~/.tauri/argus-beta.key`. La pública se pega en `tauri.beta.conf.json` → `plugins.updater.pubkey`. La privada → `TAURI_UPDATER_PRIVATE_KEY` (GH secret); la passphrase → `TAURI_UPDATER_KEY_PASSWORD`.
4. **Icon variant**: en `src-tauri/icons-beta/`, agregar set de icons con tinte naranja (Argus + dot/badge naranja). Mismas dimensiones que `icons/`.
5. **Repo settings**: habilitar `Allow GitHub Actions to create and approve pull requests` para que el bot pueda hacer el commit del bump.

El doc también explica cómo **rotar** secrets, cómo **rebootstrappear** un bucket distinto, y qué hacer si un build queda corrupto y el equipo está stuck en una versión vieja (subir manualmente un manifest a R2 que apunte a un build conocido bueno, como rollback).

### Decision 7: Iconos beta en directorio separado

`src-tauri/icons-beta/` paralelo a `src-tauri/icons/`. La beta config apunta a `icons-beta/`. Esto evita renombres en el repo cuando llegue prod, y permite ver ambos icons en diff lado a lado al cambiarlos.

Diseño del icon beta: tomar el icon de prod y aplicar un tinte naranja (`#F58219` del DESIGN.md, en una capa multiply al 35% de opacidad), o agregar un dot naranja en la esquina inferior derecha. Decidir visualmente al implementar; el spec no pide forma exacta, solo "claramente diferenciable de un vistazo en el dock".

### Decision 8: El check inicial corre 5s después del startup, no on-mount

El plugin updater puede correr inmediatamente, pero el equipo no debería ver lag al abrir la app. Diferimos el primer check 5 segundos después de que la ventana esté pintada, vía `setTimeout` en el useEffect del provider. Los checks subsecuentes corren cada 4 horas con `setInterval`.

Si el primer check encuentra update, la descarga en background no compite con la UX inicial — el usuario ya está navegando.

## Risks / Trade-offs

- **R2 `r2.dev` URL puede tener caps de bandwidth/req-rate** si Cloudflare cambia los límites del free tier → Mitigación: monitorear; si pega, sumar custom domain (cambio de un string en `tauri.beta.conf.json` y republicar con shadow URL).
- **Bot loop si `[skip ci]` falla** → el bump genera otro push que dispara otro bump infinitamente. Mitigación: el step de bump sale early si el último commit ya empieza con `chore: bump version to v`.
- **Apple cert expira en 5 años; app-specific password puede ser revocado por Apple** → Mitigación: cron de calendario manual + doc en `release-setup.md` con el procedimiento de rotación.
- **Updater Ed25519 key loss = no más updates** para todas las apps en circulación. Mitigación: backup de la clave privada en 1Password del equipo antes del primer release, escrito explícitamente en el doc.
- **Versión bumpea aun cuando el merge no cambia user-facing code** (e.g. cambio de docs) → genera builds "vacíos" que igual se distribuyen. Aceptable: el equipo se queda con el último build siempre, no hay penalty real.
- **El equipo puede tener la app abierta por días sin reiniciar** y nunca ver la update aplicada → Mitigación: el indicador del status bar es la presión social. Si se vuelve molesto, escalar a un toast pasivo después de 48h pendientes.
- **Coexistencia identifier**: si alguien instaló una versión anterior con `com.argus.app` (la actual default), seguirá teniéndola en disco con su SQLite separado al de `com.argus.beta.app`. Mitigación: avisar al equipo en el primer rollout que pueden borrar la app vieja sin perder datos del beta.
- **Notarización puede fallar transitoriamente** (Apple servers, timeouts) → Mitigación: el workflow tiene `retry: 3` en el step de `notarytool submit`. Si igual falla, se reintenta el workflow manualmente.

## Migration Plan

Es puramente aditivo desde el punto de vista del repo. No hay datos que migrar. El bootstrap manual es one-shot.

Orden de despliegue:

1. Humano corre el bootstrap de `docs/release-setup.md` (Apple cert, R2 bucket, keypair, icons-beta).
2. Land las changes de código (config split, plugin updater integrado, status bar version, workflow CI).
3. El primer push a master post-merge dispara el primer bump (`0.1.0` → `0.1.1`) y el primer release real.
4. Humano descarga `Argus_Beta_0.1.1_aarch64.dmg` (o x64) de la URL R2, instala manualmente en su mac, distribuye link al equipo por Slack.
5. A partir del próximo merge, el auto-updater toma el relevo: cada team member ve `v0.1.1 → v0.1.2` en su status bar, relanza, y queda en la nueva.

Rollback: si un build rompe la app o el updater, el remediation es publicar un `latest.json` manualmente en R2 que apunte a una versión previa conocida buena. El doc detalla el comando exacto. Como peor caso, el equipo desinstala y reinstala la `.dmg` de una versión vieja.

## Open Questions

- ¿Qué hacer cuando un user hace skip-this-version y luego esa versión es la que arregla el bug que les molestaba? Por ahora: el dev les dice "sacate el skip" verbalmente, hay un menú para limpiarlo. Si pasa seguido, evaluar UI dedicada.
- ¿En qué momento añadimos custom domain? Probablemente cuando lleguemos a release pública (no beta). Hasta entonces `r2.dev` es OK.
- ¿El indicador de versión en status bar incluye un menú al click (e.g. "Check for updates now", "About", "Skip this version")? Propuesta: sí, dropdown menu — minimal pero ahí. Confirmar al implementar.
