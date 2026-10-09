# Artifact Templates

Use these as compact output shapes. Adapt them to the user's requested scope and format.

## Non-Spreadsheet Single Item

```text
Epic: [epic]
Feature: [feature]
Description: [short estimator-ready description]
Engineering Hours - FED: [hours]
Engineering Hours - BED: [hours]
Engineering Hours - QA: [hours]
Delivery Hours - BSA: [hours]
Assumptions:
- Assumes ...
- Assumes ...
```

## Spreadsheet Row

| Epic | Feature | Assumptions / Description | Engineering Hours - FED | Engineering Hours - BED | Engineering Hours - QA | Delivery Hours - BSA |
| --- | --- | --- | --- | --- | --- | --- |
| `[epic]` | `[feature]` | `[short description + assumptions]` | `[hours]` | `[hours]` | `[hours]` | `[hours]` |

## Full Estimator Package

Use this order when relevant:
- `Discovery`
- `Design`
- `Build`
- `Testing & Release`
- `Key Assumptions`
- `Out Of Scope`
- `Front-Page Project Summary`

## Phase Row Pattern

```text
Epic: [phase or epic]
Feature: [feature]
Description: [short estimator-ready description]
Engineering Hours - FED: [hours]
Engineering Hours - BED: [hours]
Engineering Hours - QA: [hours]
Delivery Hours - BSA: [hours]
Assumptions:
- Assumes ...
- Assumes ...
```

## Key Assumptions

- `Assumes [platform or architecture constraint].`
- `Assumes [ownership or dependency boundary].`
- `Assumes [approval, business rule, or data requirement].`

## Out Of Scope

```text
Item: [name]
Description: [brief scope boundary]
Assumptions:
- Assumes this work is excluded from the current phase or budget.
- Assumes this can be scoped separately if the requirement is confirmed.
```

## Front-Page Project Summary

`[merchant] is planning a Shopify [solution type] that integrates with [partner/platform], using [platform] for [core role] and supporting [primary workflow].`

## Section Blurbs

- `Discovery`: `Requirements gathering, technical validation, architecture definition, and scope alignment for the proposed solution.`
- `Design`: `UX and visual design for the scoped customer and operational experiences, where applicable.`
- `Build`: `Development of the Shopify implementation, integrations, workflows, and operational tooling included in scope.`
- `Testing & Release`: `Integrated testing, bug fixing, UAT support, launch preparation, and release coordination.`
