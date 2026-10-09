# Implementation Plan Template

Use this template for scoping Shopify Plus projects at Domaine. Copy and fill in each section.

---

## 1. Executive Summary

> [2-3 sentences: what is being built, for whom, and why]

**Client:** [Merchant name]
**Shopify Plan:** [Plus / Enterprise]
**Store URL:** [myshopify.com domain]
**Project Lead:** [Domaine team member]
**Target Launch:** [Date]

## 2. Scope

### In Scope

- [ ] [Feature 1: brief description]
- [ ] [Feature 2: brief description]
- [ ] [Feature 3: brief description]

### Out of Scope

- [Explicitly list anything discussed but not included]
- [Prevents scope creep and sets merchant expectations]

## 3. Technical Approach

For each feature, specify the implementation method:

| Feature | Approach | Shopify Surface | Plus Required |
|---|---|---|---|
| [Feature 1] | [Theme section / Function / Extension / App / API] | [Theme / Checkout / Admin / Storefront] | [Yes/No] |
| [Feature 2] | ... | ... | ... |

### Approach Details

#### [Feature 1]

**What:** [Brief description]
**How:** [Technical approach -- which Shopify APIs, extension types, or theme patterns]
**Dependencies:** [What needs to exist first -- metafield definitions, app installs, etc.]
**Risks:** [Known technical risks or unknowns]

## 4. Architecture

### Data Flow

> [Describe how data moves between systems]

### Integration Points

| System | Direction | Method | Data |
|---|---|---|---|
| [ERP/PIM/OMS] | [Inbound/Outbound/Bidirectional] | [Webhook/API/File] | [Products/Orders/Inventory] |

### Custom Data Model

| Resource | Metafield/Metaobject | Type | Purpose |
|---|---|---|---|
| Product | `app.care_guide` | `single_line_text_field` | Care instructions |
| Shop | `app.announcement` | `rich_text_field` | Store-wide announcement |
| Custom | `$app:author` (metaobject) | Definition | Content authors |

See base's **Shopify Dev MCP** server (`learn_shopify_api` first) for data modeling guidance and type options.

## 5. Dependencies

- [ ] Shopify Plus plan confirmed
- [ ] Theme access (Collaborator account or theme files)
- [ ] App installation permissions
- [ ] Third-party API credentials / documentation
- [ ] Metafield/metaobject definitions created
- [ ] Test data available on dev store
- [ ] Merchant availability for review sessions

## 6. Milestones

| Phase | Deliverables | Timeline | LOE |
|---|---|---|---|
| Discovery | Requirements doc, technical approach | Week 1 | X hrs |
| Setup | Dev store, app scaffold, TOML config | Week 2 | X hrs |
| Development | [Feature list] | Weeks 3-N | X hrs |
| QA & Testing | Test plan execution, bug fixes | Week N+1 | X hrs |
| Merchant Review | Demo, feedback, revisions | Week N+2 | X hrs |
| Launch | Deploy to production, monitoring | Week N+3 | X hrs |

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [Risk 1] | [Low/Med/High] | [Low/Med/High] | [Mitigation strategy] |
| Shopify API changes | Low | High | Pin API version, test on preview |
| Third-party API instability | Medium | High | Error handling, retry logic, fallback |

## 8. LOE Estimate

See the LOE guidelines in `/pm:solutions-engineering` for typical ranges per component type.

| Component | Estimate | Complexity |
|---|---|---|
| [Component 1] | X hrs | [Low/Med/High] |
| [Component 2] | X hrs | [Low/Med/High] |
| **Subtotal** | X hrs | |
| QA buffer (25%) | X hrs | |
| **Total** | X hrs | |
