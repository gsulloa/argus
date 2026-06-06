---
# Hand-authored. physical_table is derived from the parent directory name — do not add it here.
system:
  kind: dynamo_model
  name: AuditEvent
  access_patterns:
    - index: "table"
      pk: "${tenantId}"
      sk: "${eventTs}#${eventId}"
    - name: "Events in time window (prefix)"
      index: "table"
      pk: "${tenantId}"
      sk: "${eventTs}"
    - name: "All events for tenant"
      index: "table"
      pk: "${tenantId}"
---

# AuditEvent

Append-only audit event. Each item belongs to a single tenant and is addressed
by a composite sort key of `<ISO-8601 timestamp>#<UUID v4>`.

## Access pattern notes

- **Exact get** — supply `tenantId`, `eventTs`, and `eventId` for a point read.
- **Time-window prefix** — supply `tenantId` and a timestamp prefix (e.g.
  `2026-06-06T`) to retrieve all events in that day using `begins_with`.
- **Full partition scan** — supply `tenantId` only to retrieve all events for a
  tenant (use sparingly on high-volume tenants).
