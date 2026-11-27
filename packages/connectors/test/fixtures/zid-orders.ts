/** SYNTHETIC Zid order, shaped after docs.zid.sa list-of-orders.md (ShortOrderSerializer). */
export function zidOrder(id: number, over: Record<string, unknown> = {}) {
  return {
    id, invoice_number: id, code: `TEST${id}`, store_id: 1, currency_code: "SAR",
    order_status: { name: "جديد", code: "new" }, payment_status: "paid", order_total: "100.00", order_total_string: "100.00 SAR",
    customer: { id: 9, name: "Test Customer", email: "customer@example.test", mobile: "966500000000" },
    shipping: { address: { formatted_address: "Test Street 1", city: { name: "Test City" } } },
    source: "Store", created_at: "2026-01-01 10:00:00", updated_at: "2026-01-01 10:00:00",
    ...over,
  };
}
