# Shopify analytics — ShopifyQL

Numbers, totals, trends and breakdowns (sales, orders, revenue, sessions, conversion) come from
**ShopifyQL**, not from paging Admin GraphQL records. `/base:shopify` sends it through the Admin
GraphQL field `shopifyqlQuery`, so it runs through every runner in the skill's runner table. The
source for schemas, metrics, dimensions and clauses is the dev-mcp **"ShopifyQL"** topic:
`learn_shopify_api` with `api: "shopifyql"`, then its docs search. Never guess a metric or a
dimension name — a name the docs did not return is the usual parse error.

## The wrapper

```graphql
# Required scopes: read_reports
query ShopifyqlReport($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}
```

```json
{ "q": "FROM sales SHOW total_sales SINCE -7d UNTIL today" }
```

- Pass the ShopifyQL as the `$q` variable. A `"""…"""` block string inline works in GraphiQL, but
  fe's runner refuses to narrow a document that holds one.
- **Read-only.** ShopifyQL only reads; it needs `read_reports` and never a mutation confirmation.
- **Check `parseErrors` first.** Non-empty = the ShopifyQL is invalid: fix it against the docs and
  run again. `validate` checks the GraphQL wrapper only, never the ShopifyQL inside it — running it
  is the only proof.
- `columns` gives each column's `name` and `dataType`; `rows` holds the values in that order. Quote
  the window (`SINCE … UNTIL …`, `DURING …`) with the numbers.

## Example statements

Write `FROM … SHOW …`, never `SELECT`. The `FROM` schema must own the metric — `sales` owns
`total_sales`, `net_sales` and `orders`.

| Question | ShopifyQL |
|---|---|
| Sales in the last 7 days | `FROM sales SHOW total_sales SINCE -7d UNTIL today` |
| Daily sales and orders, last 30 days | `FROM sales SHOW total_sales, orders TIMESERIES day SINCE -30d UNTIL today` |
| Orders by sales channel, last 30 days | `FROM sales SHOW total_sales, orders GROUP BY sales_channel SINCE startOfDay(-30d) UNTIL today ORDER BY total_sales DESC LIMIT 10` |
| Top products last month | `FROM sales SHOW total_sales, orders GROUP BY product_title DURING last_month ORDER BY total_sales DESC LIMIT 10` |
