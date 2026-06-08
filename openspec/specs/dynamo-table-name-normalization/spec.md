# dynamo-table-name-normalization Specification

## Purpose

The `dynamo-table-name-normalization` capability defines an optional per-connection rule that folds a live physical DynamoDB table name into a stable logical name, so that context lookups, schema-sync, and badge matching survive CDK-style per-deploy table-name suffixes.

## Requirements

### Requirement: Table-name normalization rule

The Dynamo module SHALL define an optional per-connection **table-name normalization rule** that folds a live physical DynamoDB table name into a stable **logical name**. The rule supports two mutually-exclusive authoring forms:

- a **simple form** with an optional literal `prefix` and an optional regex `suffix_pattern`, and
- an **advanced form** with a single `regex` containing a named capture group `logical`.

When both forms are absent or empty, the rule is the **identity transform** (the name is returned unchanged). A configured rule that fails to match a given name SHALL also return the name unchanged (degrading to exact match) rather than producing an empty or partial logical name.

#### Scenario: Unconfigured rule is identity

- **WHEN** a connection has no table-name normalization rule and `normalize("Events")` is computed
- **THEN** the result is `"Events"`, identical to the input

#### Scenario: Prefix and suffix-pattern strip to the logical name

- **WHEN** the rule is `prefix: "MyApp-prod-"`, `suffix_pattern: "-[A-Z0-9]+$"` and `normalize("MyApp-prod-EventsTable-3M4N5O6P7Q8R")` is computed
- **THEN** the result is `"EventsTable"`

#### Scenario: Capture regex returns the logical group

- **WHEN** the rule is `regex: "^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$"` and `normalize("MyApp-prod-EventsTable-3M4N5O6P7Q8R")` is computed
- **THEN** the result is `"EventsTable"`, taken from the `logical` capture group

#### Scenario: Random suffix changes between deploys still normalize equal

- **WHEN** the rule strips `prefix: "MyApp-prod-"` and `suffix_pattern: "-[A-Z0-9]+$"`, and `normalize` is computed for both `"MyApp-prod-EventsTable-3M4N5O6P7Q8R"` and `"MyApp-prod-EventsTable-9Z8Y7X6W5V4U"`
- **THEN** both results are `"EventsTable"`

#### Scenario: Non-matching name degrades to identity

- **WHEN** the rule is `regex: "^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$"` and `normalize("SomeOtherTable")` is computed (the regex does not match)
- **THEN** the result is `"SomeOtherTable"` unchanged, so an exact-match lookup still works

### Requirement: Logical-name lookup is the only ambiguity-free direction

Normalization SHALL only be applied in the physical → logical direction. Because a context lookup always starts from exactly one open physical table, normalizing it yields exactly one logical name and no ambiguity. When a process enumerates **many** live tables (schema-sync) and two or more distinct live tables normalize to the same logical name, that is a collision the enumerating process MUST handle (see `connection-context-folders`); the normalization rule itself does not attempt a reverse logical → physical mapping.

#### Scenario: Single open table yields a single logical name

- **WHEN** the user opens one physical table `MyApp-prod-EventsTable-3M4N5O6P7Q8R` under a connection whose rule strips the prefix and random suffix
- **THEN** the lookup uses exactly the logical name `EventsTable` with no ambiguity
