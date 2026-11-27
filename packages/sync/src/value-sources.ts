import type { ValueSource } from "@glio/connectors";
import type { SqlExecutor } from "./sql.ts";

/** Which sales count as this client's purchase value (migration 0019). Default: website only. */
export async function clientValueSources(db: SqlExecutor, clientId: string): Promise<ValueSource[]> {
  const [row] = await db.query("select value_sources from public.client_economics where client_id = $1", [clientId]);
  const list = (row?.value_sources as string[] | undefined) ?? ["website"];
  const valid = list.filter((s): s is ValueSource => s === "website" || s === "app" || s === "shop");
  return valid.length ? valid : ["website"];
}
