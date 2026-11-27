/**
 * "Who viewed this report" (ADR-040): a summary of the audit log's report.viewed
 * (GLIO members, by person) and report.share_viewed (people outside GLIO, by share
 * link — never identified) entries for one report snapshot.
 */

export interface ViewRow {
  created_at: string;
  actor_kind: string;
  actor_user_id: string | null;
  action: string;
  metadata: { share_id?: string } | null;
}

export interface Viewer {
  kind: "member" | "share";
  /** User id for members, share id for links ("" if a share view carries none). */
  id: string;
  views: number;
  first: string;
  last: string;
}

export function summarizeViews(rows: ViewRow[]): Viewer[] {
  const by = new Map<string, Viewer>();
  for (const r of rows) {
    let kind: Viewer["kind"];
    let id: string;
    if (r.action === "report.viewed" && r.actor_kind === "user" && r.actor_user_id) {
      kind = "member";
      id = r.actor_user_id;
    } else if (r.action === "report.share_viewed") {
      kind = "share";
      id = r.metadata?.share_id ?? "";
    } else {
      continue;
    }
    const key = `${kind}:${id}`;
    const v = by.get(key);
    if (!v) by.set(key, { kind, id, views: 1, first: r.created_at, last: r.created_at });
    else {
      v.views += 1;
      if (r.created_at < v.first) v.first = r.created_at;
      if (r.created_at > v.last) v.last = r.created_at;
    }
  }
  return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}
