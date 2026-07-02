## ADDED Requirements

### Requirement: Readable rendering of scalar and network Postgres types

The Postgres value serializer that backs `postgres_query_table` (and, by reference, the SQL editor's row-set results) SHALL render the actual value of Postgres types that have a natural scalar or textual representation, rather than a `<typename>` placeholder. Specifically, values of type `oid`, `xid`, `xid8`, `interval`, `inet`, `cidr`, `macaddr`, and `macaddr8` MUST be returned as their real value:

- `oid`, `xid`, `xid8` MUST be returned as a JSON number.
- `interval` MUST be returned as a human-readable duration string.
- `inet` and `cidr` MUST be returned as their address string, preserving the network prefix where applicable (e.g. `192.168.1.0/24`).
- `macaddr` and `macaddr8` MUST be returned as their colon-separated hexadecimal string.

The `<typename>` string envelope (`"<" + type_name + ">"`) MUST remain reachable ONLY as a last resort for types that can be decoded neither as one of the explicitly handled types, nor as a `String`, nor as one of the types listed above. A decode failure for any listed type MUST degrade gracefully (fall through to the string attempt and then the placeholder) and MUST NOT drop the row or panic. `NULL` values of these types MUST continue to be returned as JSON `null`. This behavior is shared by `postgres_query_table` and the SQL editor result path, which use the same `Value` envelope handling.

#### Scenario: interval renders as a readable duration
- **WHEN** a query returns a column of type `interval` with the value `interval '1 year 2 mons 3 days 04:05:06'`
- **THEN** the cell value is the string `1 year 2 mons 3 days 04:05:06` (Postgres-style), not `<interval>`

#### Scenario: oid renders as a number
- **WHEN** a query returns a column of type `oid` with the value `12345`
- **THEN** the cell value is the JSON number `12345`, not `<oid>`

#### Scenario: xid and xid8 render as numbers
- **WHEN** a query returns columns of type `xid` and `xid8` with numeric transaction ids
- **THEN** each cell value is the corresponding JSON number, not `<xid>`

#### Scenario: inet preserves host address
- **WHEN** a query returns a column of type `inet` with the value `192.168.0.1`
- **THEN** the cell value is the string `192.168.0.1`, not `<inet>`

#### Scenario: cidr preserves the network prefix
- **WHEN** a query returns a column of type `cidr` with the value `10.0.0.0/8`
- **THEN** the cell value is the string `10.0.0.0/8` (the `/8` prefix is preserved), not `<cidr>`

#### Scenario: macaddr renders as hex string
- **WHEN** a query returns a column of type `macaddr` with the value `08:00:2b:01:02:03`
- **THEN** the cell value is the string `08:00:2b:01:02:03`, not `<macaddr>`

#### Scenario: NULL of a newly-handled type stays null
- **WHEN** a query returns a `NULL` value in an `interval`, `oid`, `inet`, or `xid` column
- **THEN** the cell value is JSON `null`

#### Scenario: genuinely unsupported type still shows the placeholder
- **WHEN** a query returns a column of a type that cannot be decoded as a handled type, a `String`, or any of the newly-handled types (for example `tsvector`)
- **THEN** the cell value falls back to the `<typename>` string envelope and the row is still returned intact
