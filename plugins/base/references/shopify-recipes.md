# Shopify store recipes — Admin GraphQL, validated

The store questions `/base:shopify` answers, as ready operations. Every operation is one document
plus variables, so it runs unchanged through every runner in the skill's runner table. All of them
passed the dev-mcp `validate` tool against **Admin API 2026-10**. The scope comment on each is the
validator's `Required scopes` line; where the validator names none for a write, the comment gives
the owner type's write scope.

Version: the recipes were validated on `2026-10`, the version fe's runner defaults to.

Rules for every recipe:
- `first:10` (metafields `first:50`), and read `pageInfo` — `hasNextPage: true` means the answer is
  partial; page with `after: <endCursor>` or narrow the `query:` filter.
- Resolve a handle, a title or a SKU to its gid in the same flow (recipes 1–3), then use the gid.
  Never fill an id or a namespace from unrelated context.
- The answer names its evidence: the field, its value, and the file key for a theme fact.
- An `ACCESS_DENIED` error names a missing scope of the credential, not a wrong query.

## 1. Product by handle

Answers: does the product exist, its status, its template, its options and variants.

```graphql
# Required scopes: read_products
query ProductByHandle($handle: String!, $after: String) {
  productByIdentifier(identifier: {handle: $handle}) {
    id title handle status templateSuffix
    options { name values }
    variants(first: 10, after: $after) {
      nodes { id sku title selectedOptions { name value } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

```json
{ "handle": "signet-ring" }
```

Read: `null` = no product with that handle. `status` must be `ACTIVE` for the storefront.
`templateSuffix` names the template: `null` → `templates/product.json`, `"engraved"` →
`templates/product.engraved.json`. `variants.pageInfo.hasNextPage: true` = more variants than
listed; page on with `after` before saying a variant does not exist.

## 2. Product search by title

Answers: which products match a name the developer half remembers.

```graphql
# Required scopes: read_products
query ProductSearch($q: String!, $after: String) {
  products(first: 10, query: $q, after: $after) {
    nodes { id title handle status }
    pageInfo { hasNextPage endCursor }
  }
}
```

```json
{ "q": "title:*ring*" }
```

Read: more than one hit → list them and ask which one; do not pick.

## 3. Variant by SKU

Answers: which product and variant carry a SKU.

```graphql
# Required scopes: read_products
query VariantBySku($q: String!) {
  productVariants(first: 10, query: $q) {
    nodes { id sku title product { id handle title } }
  }
}
```

```json
{ "q": "sku:ABC-1" }
```

Read: an empty `nodes` = no variant with that SKU. Two hits = a duplicated SKU, itself a finding.

## 4. Product metafields

Answers: which metafields a product has, their types and values, and the metaobject a reference
points to. The aliased `engraving` field reads one known key directly — rename the alias and
change `namespace`/`key` to the key the question is about.

```graphql
# Required scopes: read_products, read_metaobjects
query ProductMetafields($id: ID!, $ns: String) {
  product(id: $id) {
    id
    metafields(first: 50, namespace: $ns) {
      nodes { namespace key type value reference { ... on Metaobject { id type handle } } }
      pageInfo { hasNextPage endCursor }
    }
    engraving: metafield(namespace: "custom", key: "engraving") { type value }
  }
}
```

```json
{ "id": "gid://shopify/Product/1234567890", "ns": "custom" }
```

Read: the direct field `null` = the value is not set on this product (not "empty"). Omit `ns` to
list every namespace. A `reference` gives the metaobject to check with recipe 5.

## 5. Metaobject by handle

Answers: what a metaobject entry holds and whether it is live.

```graphql
# Required scopes: read_metaobjects
query MetaobjectByHandle($type: String!, $handle: String!) {
  metaobjectByHandle(handle: {type: $type, handle: $handle}) {
    id type handle displayName
    fields { key type value }
    capabilities { publishable { status } }
  }
}
```

```json
{ "type": "engraving_style", "handle": "script" }
```

Read: `capabilities.publishable.status` `DRAFT` = the storefront does not render it; `ACTIVE` = live.
`publishable: null` = the definition has no publishable capability (always live).

## 6. Product metafield definitions

Answers: which metafields are defined for products, their types, validations and storefront access.

```graphql
# Required scopes: none named by the validator
query ProductMetafieldDefs($ns: String, $after: String) {
  metafieldDefinitions(ownerType: PRODUCT, first: 50, namespace: $ns, after: $after) {
    nodes { namespace key name type { name } validations { name value } access { storefront } pinnedPosition }
    pageInfo { hasNextPage endCursor }
  }
}
```

```json
{ "ns": "custom" }
```

Read: a value with no definition here is an unstructured metafield — the admin shows it under
"Unstructured metafields", not in the product form. `access.storefront` `NONE` hides the key from
the Storefront API only (a headless reader); a Liquid theme reads it whatever the setting.

## 7. Themes

Answers: which themes the store has and which one is live.

```graphql
# Required scopes: read_themes
query Themes {
  themes(first: 20) { nodes { id name role processing updatedAt } }
}
```

Read: `role: MAIN` is the published theme; `UNPUBLISHED` themes are previews and drafts.
`processing: true` = an upload still in progress.

## 8. Main theme product templates

Answers: what the live theme's product templates contain — sections, blocks, settings.

```graphql
# Required scopes: read_themes
query MainProductTemplate($after: String) {
  themes(first: 1, roles: [MAIN]) {
    nodes {
      id name
      files(filenames: ["templates/product.json", "templates/product.*.json"], first: 10, after: $after) {
        nodes { filename size updatedAt body { ... on OnlineStoreThemeFileBodyText { content } } }
        pageInfo { hasNextPage endCursor }
        userErrors { code filename }
      }
    }
  }
}
```

Read: `content` is the file text. A JSON template may start with a `/* … */` header comment —
strip it before `JSON.parse`. Theme files are read by `filenames:` only. This wildcard list is an
overview: it pages (`pageInfo`), and Shopify may return fewer files than `first:` to stay under its
payload limit. For the one template `templateSuffix` names (recipe 1), read it by its exact name
with `MainThemeFiles` below.

For files by exact name (the template `templateSuffix` names, `sections/main-product.liquid`,
`config/settings_data.json`), the same shape with the list as a variable (validated on 2026-10 as
well):

```graphql
# Required scopes: read_themes
query MainThemeFiles($filenames: [String!]!, $after: String) {
  themes(first: 1, roles: [MAIN]) {
    nodes {
      id name
      files(filenames: $filenames, first: 10, after: $after) {
        nodes { filename size updatedAt body { ... on OnlineStoreThemeFileBodyText { content } } }
        pageInfo { hasNextPage endCursor }
        userErrors { code filename }
      }
    }
  }
}
```

```json
{ "filenames": ["templates/product.engraved.json"] }
```

## 9. Product publications

Answers: on which sales channels the product is published or staged.

```graphql
# Required scopes: read_products, read_publications
query ProductPublications($id: ID!, $after: String) {
  product(id: $id) {
    id onlineStoreUrl publishedAt
    resourcePublicationsV2(first: 20, onlyPublished: false, after: $after) {
      nodes { isPublished publishDate publication { id catalog { title } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

```json
{ "id": "gid://shopify/Product/1234567890" }
```

Read: `onlyPublished: false` keeps the unpublished and staged rows; without it an unpublished
product has no Online Store row at all. The Online Store row with `isPublished: false` (or
`onlineStoreUrl: null`) = not on the storefront. `catalogType` defaults to `APP` (sales channels):
for a market or B2B catalog question add `catalogType: MARKET` or `catalogType: COMPANY_LOCATION`.
Name a publication by `publication.catalog.title` — `Publication.name` is deprecated.

## 10. Inventory per location

Answers: stock per variant and location, and whether the variant sells when out of stock.

```graphql
# Required scopes: read_products, read_inventory, read_locations, read_markets_home
query ProductInventory($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: 10, after: $after) {
      nodes {
        sku inventoryPolicy
        inventoryItem {
          tracked
          inventoryLevels(first: 10) {
            nodes { location { name } quantities(names: ["available", "on_hand", "committed"]) { name quantity } }
            pageInfo { hasNextPage }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

```json
{ "id": "gid://shopify/Product/1234567890" }
```

Read: `inventoryPolicy: CONTINUE` sells past zero; `DENY` stops at zero. `tracked: false` = no stock
count at all. `inventoryLevels.pageInfo.hasNextPage: true` = more than 10 locations: name that
variant's stock as partial.

## 11. Market availability

Answers: is the product published and priced for one country's buyers.

```graphql
# Required scopes: read_products, read_publications
query MarketAvail($id: ID!, $country: CountryCode!) {
  product(id: $id) {
    publishedInContext(context: {country: $country})
    contextualPricing(context: {country: $country}) { priceRange { minVariantPrice { amount currencyCode } } }
  }
}
```

```json
{ "id": "gid://shopify/Product/1234567890", "country": "CA" }
```

Read: `publishedInContext: false` = buyers in that country do not see it, even when recipe 9 says
published.

## 12. Shop environment

Answers: which store this is, its plan, and its public domain.

```graphql
# Required scopes: none named by the validator
query ShopEnv {
  shop { name myshopifyDomain plan { partnerDevelopment shopifyPlus } primaryDomain { host } }
}
```

Read: `partnerDevelopment: true` = a development store. Check `myshopifyDomain` before any mutation:
it proves which store the runner talks to.

## PDP checklist — "why does X not show on the product page"

Walk the steps in this order and stop at the first that fails. Cite the failing step with field,
value and file key. Usually four queries.

1. **Status and template** — recipe 1: `status` is `ACTIVE`; `templateSuffix` names the template
   file the next steps read.
2. **Option and variant** — recipe 1 (`options`, `selectedOptions`); recipe 10 when the feature
   depends on stock: the option value or variant the feature needs exists.
3. **Metafield value** — recipe 4: the value is set (not `null`) under the exact namespace, key and
   type; recipe 6: a definition exists with that type. `access.storefront` matters only to a
   Storefront API (headless) reader — never a step-3 failure for a Liquid theme.
4. **Referenced metaobject** — recipe 5: the entry exists and `capabilities.publishable.status` is
   `ACTIVE`.
5. **Publication and market** — recipe 9: published on the Online Store; recipe 11: published for
   the buyer's country.
6. **Theme template block** — `MainThemeFiles` (recipe 8) with the exact template name
   `templateSuffix` gives (`["templates/product.<suffix>.json"]`): the block is there, it is not
   `"disabled": true`, and its setting reads the same `namespace.key` as step 3.
7. **Section settings** — `MainThemeFiles` (recipe 8) with `config/settings_data.json` or the
   section file: no toggle turns the feature off.

Custom data rules (namespaces, definitions, metaobject status) live in `shopify-custom-data.md`.

## Mutation templates

The discipline is the skill's: show the full document and variables, get a "yes" in a separate
turn, run it once, read `userErrors`, then re-read the value with the matching recipe. A refusal is
quoted verbatim; the same document is never sent again.

### metafieldsSet

```graphql
# Required scopes: write_products (PRODUCT owner)
mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key type value }
    userErrors { field message code }
  }
}
```

```json
{ "metafields": [ { "ownerId": "gid://shopify/Product/1234567890", "namespace": "custom", "key": "engraving", "type": "single_line_text_field", "value": "Script" } ] }
```

Read: an empty `userErrors` and the value echoed back = written; re-read with recipe 4. The write
scope follows the owner type (`write_products` for a product). Up to 25 metafields per call; a
`type` that differs from the definition's is a `userErrors` entry.

### productUpdate

```graphql
# Required scopes: write_products (the validator also lists read_products)
mutation ProductUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id title tags }
    userErrors { field message }
  }
}
```

```json
{ "product": { "id": "gid://shopify/Product/1234567890", "tags": ["engraving"] } }
```

Read: the argument is `product:` (`ProductUpdateInput`). `tags` replaces the whole list;
read the current tags first and send the full new list. Re-read with recipe 1.
