---
name: "Triage feedback"
description: Revisa los feedbacks in-app en DynamoDB, contrasta con las issues de GitHub y crea issues para los nuevos
category: Workflow
tags: [feedback, dynamodb, github, triage]
---

Triage del feedback in-app de Argus: lee la tabla de feedback en DynamoDB, contrasta cada item con las issues de GitHub, crea issues para los feedbacks nuevos, y deja los estados sincronizados para que el flujo sea idempotente (correr el comando dos veces no duplica issues).

**Contexto fijo del proyecto** (no preguntar, ya está resuelto):
- Tabla DynamoDB: **resolver siempre desde SSM**.
- Región: `us-east-1`
- Credenciales AWS: usar las del entorno (`.envrc` ya exporta el perfil); no pasar `--profile`.
- Repo GitHub: `gsulloa/argus`
- Partition key fija: `pk = "FEEDBACK"`; sort key `sk` = ULID (orden cronológico)
- Campo `status`: `new` → `triaged` → `done` | `wontfix`
- Lifecycle de triage:
  - `new` = sin issue todavía → hay que crear issue.
  - `triaged` = ya tiene issue abierta.
  - `done` = su issue ya está cerrada (resuelta).

**Pasos**

0. **Resolver el nombre de la tabla desde SSM** (siempre, nunca hardcodear):
   ```bash
   TABLE=$(aws ssm get-parameter --name /Argus/feedback/table-name \
     --region us-east-1 --query Parameter.Value --output text)
   ```
   Usar `"$TABLE"` en todos los comandos de DynamoDB siguientes.

1. **Leer todos los feedbacks de DynamoDB** (más recientes según `sk`/`createdAt`):
   ```bash
   aws dynamodb query \
     --table-name "$TABLE" \
     --key-condition-expression "pk = :pk" \
     --expression-attribute-values '{":pk": {"S": "FEEDBACK"}}' \
     --region us-east-1 --output json
   ```
   Para cada item registra: `sk`, `status`, `category` (bug/idea/other), `message`, `createdAt`, y la `metadata` relevante (appVersion, os, osVersion, arch, locale, activeEngineType).

2. **Leer las issues recientes de GitHub** para poder contrastar:
   ```bash
   gh issue list --repo gsulloa/argus --state all --limit 50 \
     --json number,title,state,labels,createdAt,body
   ```
   Las issues creadas desde feedback in-app llevan el `sk` en el footer (`sk \`...\``), así que el match más confiable es por `sk`; si no, por contenido del `message`.

3. **Construir el mapeo feedback → issue** y clasificar cada feedback:
   - **`triaged`**: buscar su issue asociada. Si la issue está **CLOSED** → el feedback está resuelto (acción: marcar `done` en el paso 6). Si sigue **OPEN** → dejar en `triaged`, sin acción.
   - **`new`**: confirmar que NO existe ya una issue equivalente (por `sk` o por contenido, para no duplicar). Si no existe → crear issue (paso 4) y luego marcar `triaged` (paso 6). Si ya existía una issue (p.ej. creada manualmente) → no crear; marcar `triaged` o `done` según el estado de esa issue.
   - **`done` / `wontfix`**: ignorar, ya cerrados.

4. **Crear una issue por cada feedback nuevo**, respetando el formato de feedback in-app del repo (ver issues #173/#174/#175 como referencia). Usar `--body-file` con un temp file para evitar problemas de escaping. Plantilla del body:

   ```markdown
   ## Reporte (in-app feedback)

   > <message del feedback, citado>

   ## Interpretación

   <qué problema/idea se entiende, en términos del producto>

   ## Reproducción     ← solo si es bug

   1. ...

   ## Esperado

   <comportamiento esperado>

   ---
   <sub>Origen: in-app feedback · categoría `<category>` · app v<appVersion> · <os> <osVersion> (<arch>) · engine activo: <activeEngineType> · <fecha createdAt YYYY-MM-DD> · sk `<sk>`</sub>
   ```

   - Label: `bug` para `category: bug`; `enhancement` para `category: idea` (y `other` según criterio).
   - Título descriptivo del caso, no la cita literal.
   - Comando: `gh issue create --repo gsulloa/argus --title "..." --label <label> --body-file /tmp/<archivo>.md`
   - Guardar el número de issue devuelto para el resumen y la bitácora.

5. **Pausa de criterio**: las issues son outward-facing. Si algún feedback es ambiguo, redundante con otro, o spam, no crear issue a ciegas — resolverlo o reportarlo. El resto, crear directamente (el usuario ya autorizó la creación al invocar el comando).

6. **Sincronizar estados en DynamoDB** para dejar el flujo idempotente:
   - Cada feedback `new` para el que se creó (o ya existía) una issue abierta → `triaged`.
   - Cada feedback `triaged` cuya issue está cerrada → `done`.
   ```bash
   aws dynamodb update-item \
     --table-name "$TABLE" \
     --key '{"pk":{"S":"FEEDBACK"},"sk":{"S":"<SK>"}}' \
     --update-expression "SET #s = :v" \
     --expression-attribute-names '{"#s":"status"}' \
     --expression-attribute-values '{":v":{"S":"<triaged|done>"}}' \
     --region us-east-1
   ```

7. **Reportar un resumen** al usuario: tabla feedback → status → issue (con estado), issues nuevas creadas con sus números/links, y los estados actualizados en DynamoDB.
