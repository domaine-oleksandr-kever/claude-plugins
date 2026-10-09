# Merchant Handoff Template

Prepare this document for every project delivery. The audience is the merchant's team (non-technical).

---

## Project: [Project Name]

**Client:** [Merchant name]
**Delivered by:** [Domaine team members]
**Delivery Date:** [Date]
**Store:** [myshopify.com URL]

---

## 1. What Was Built

> [2-3 paragraph summary of everything delivered]

### Deliverables

| # | Deliverable | Type | Status |
|---|---|---|---|
| 1 | [Feature name] | [Theme / Function / Extension / App] | Complete |
| 2 | [Feature name] | ... | Complete |
| 3 | [Feature name] | ... | Complete |

### Apps Installed

| App | Purpose | Installed By |
|---|---|---|
| [App name] | [What it does] | Domaine |

### Functions Activated

| Function | Type | Handle |
|---|---|---|
| [Function name] | [Cart Transform / Discount / etc.] | [function-handle] |

## 2. How To Use It

### [Feature 1: Merchant-Facing Name]

**Where to find it:** [Admin path or storefront location]

**How to configure:**
1. [Step 1 with specific admin paths]
2. [Step 2]
3. [Step 3]

**Tips:**
- [Helpful tip for daily use]
- [Common scenario and how to handle it]

### [Feature 2: Merchant-Facing Name]

[Repeat for each feature]

## 3. Configuration Guide

### Metafields

| Resource | Field Name | Location in Admin | What to Enter |
|---|---|---|---|
| Product | Care Guide | Products > [Product] > Metafields | Care instructions text |
| Product | Author | Products > [Product] > Metafields | Select an author |

See the Shopify help docs on [managing metafields](https://help.shopify.com/en/manual/custom-data/metafields/managing-metafields).

### Theme Customizer Settings

| Section | Setting | What It Controls |
|---|---|---|
| [Section name] | [Setting name] | [Description] |

### Discount Configuration

| Discount | Type | How to Manage |
|---|---|---|
| [Discount name] | [Automatic / Code] | Admin > Discounts |

## 4. Known Limitations

| Limitation | Why | Workaround |
|---|---|---|
| [What it can't do] | [Technical reason in plain language] | [Alternative approach if any] |

## 5. Maintenance Requirements

### Regular Tasks

- [ ] Keep apps updated when Shopify prompts for API version upgrades
- [ ] Review discount function behavior after Shopify platform updates
- [ ] Monitor webhook delivery health in the app dashboard
- [ ] [Project-specific maintenance tasks]

### API Version

The current implementation uses API version **[version]**. Shopify deprecates API versions on a rolling schedule. When prompted to upgrade, contact Domaine for assistance.

### Theme Updates

If the theme is updated (Foundation or custom), the following files should be reviewed for conflicts:
- [List of modified theme files]

## 6. Support Contacts

| Issue Type | Contact | Channel |
|---|---|---|
| General questions | [Domaine contact] | [Email / Slack] |
| Urgent production issues | [Domaine escalation] | [Phone / Slack] |
| Shopify platform issues | Shopify Plus Support | [Merchant's Plus rep] |
| App-specific issues | [App vendor] | [Support URL] |

## 7. Appendix

### Technical Details (for developers)

- **GitHub repository:** [URL if applicable]
- **App config:** `shopify.app.[config].toml`
- **Function handles:** [List of deployed function handles]
- **Webhook endpoints:** [List of webhook URLs]
- **Environment variables:** [List of required env vars -- NOT values]
