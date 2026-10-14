# Shopify custom data — metafields and metaobjects

The rules `/base:shopify` follows for metafields and metaobjects. The recipes that read and write
them are in `shopify-recipes.md`; the operations below passed the dev-mcp `validate` tool on Admin
API 2026-10. For anything deeper (owner types, every field type, list types, TOML syntax) the source
is the dev-mcp **"Custom Data"** topic: `learn_shopify_api` with `api: "custom-data"`, then its
docs search.

## Namespaces: who owns the key

- **`$app`** (written exactly so, with the `$`) is the namespace of the app making the call. Each app
  sees its own `$app`; another app's `$app` data is not reachable by that name. `namespace: "app"`
  without the `$` is a different, merchant namespace — a common mistake.
- **Merchant namespaces** (`custom`, or a project's own such as `product_details`) belong to the
  store. The theme reads them as `product.metafields.<namespace>.<key>`, and every app with the
  owner type's scope can read and write them.
- Theme work uses merchant namespaces: the theme reads them directly and the data outlives any one
  app.

## Definitions: merchant-owned vs app-owned

- **Merchant-owned definition** (a merchant namespace) — created in the admin (Settings → Custom
  data) or with `metafieldDefinitionCreate`. The definition fixes the type, the validations, the
  admin form and the storefront access.
- **App-owned definition** (`$app`) — declared in the app's `shopify.app.toml` and installed with the
  app; do not create it at runtime with GraphQL.

```graphql
# Required scopes: none named by the validator (in practice the owner type's write scope)
mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id namespace key type { name } access { storefront } }
    userErrors { field message code }
  }
}
```

```json
{ "definition": { "ownerType": "PRODUCT", "namespace": "custom", "key": "engraving", "name": "Engraving", "type": "single_line_text_field" } }
```

A definition is a store-wide change: it follows the skill's mutation discipline like any write.
Check first with `ProductMetafieldDefs` (recipe 6) — a second definition on the same
namespace and key is a `userErrors` entry, not a new definition.

## Writes: always `metafieldsSet`

- Write values with `metafieldsSet` (the mutation template in `shopify-recipes.md`), never by
  updating the owner's `metafields` input. It creates or updates by `ownerId` + `namespace` + `key`.
- `type` must match the definition's type; `value` is always a string — JSON types send serialized
  JSON, a reference sends the referenced gid.
- Re-read the value after the write (recipe 4).

## Metaobjects

- A **metaobject definition** is the type (`type`, its fields, its capabilities); an **entry** is one
  record of it, addressed by `type` + `handle` (recipe 5).
- With the `publishable` capability an entry is `DRAFT` or `ACTIVE`; only `ACTIVE` entries render on
  the storefront. Status is the first check when a referenced entry does not show.
- Check the definition (fields, storefront access, whether `publishable` is on):

```graphql
# Required scopes: read_metaobject_definitions
query MetaobjectDefinitionAccess($type: String!) {
  metaobjectDefinitionByType(type: $type) {
    id type name
    access { admin storefront }
    capabilities { publishable { enabled } }
    fieldDefinitions { key name type { name } required }
  }
}
```

- List the entries of a type:

```graphql
# Required scopes: read_metaobjects
query MetaobjectsByType($type: String!, $after: String) {
  metaobjects(type: $type, first: 10, after: $after) {
    nodes { id handle displayName capabilities { publishable { status } } fields { key type value } }
    pageInfo { hasNextPage endCursor }
  }
}
```

- Publish an entry (a write — the skill's mutation discipline applies):

```graphql
# Required scopes: write_metaobjects, read_metaobjects
mutation PublishMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
  metaobjectUpdate(id: $id, metaobject: $metaobject) {
    metaobject { id handle capabilities { publishable { status } } }
    userErrors { field message code }
  }
}
```

```json
{ "id": "gid://shopify/Metaobject/1234567890", "metaobject": { "capabilities": { "publishable": { "status": "ACTIVE" } } } }
```

## Reference metafields

- A metafield of type `metaobject_reference` (or `product_reference`, `file_reference`, …) stores a
  gid; `list.<type>` stores a JSON array of gids.
- Read the target in the same query with `reference { ... on Metaobject { id type handle } }`
  (`references(first: …)` for a list), as recipe 4 does.
- A reference to a `DRAFT` or deleted entry renders nothing on the storefront: follow it to recipe 5.
