"use client";

import { usePathname } from "next/navigation";
import { signOut, switchLanguage } from "@/app/actions";

export interface SidebarWorkspace {
  id: string;
  name: string;
  clients: Array<{ id: string; name: string }>;
  pendingApprovals: number;
}

export interface SidebarProps {
  lang: "ar" | "en";
  email: string;
  workspaces: SidebarWorkspace[];
  labels: { home: string; workspaces: string; clients: string; allClients: string; switchLang: string; signOut: string; website: string; approvals: string };
}

const MAX_CLIENTS = 8;

/** Navy app sidebar: workspaces and their clients, language, sign out. */
export function Sidebar({ lang, email, workspaces, labels }: SidebarProps) {
  const path = usePathname() ?? "";
  const wsMatch = path.match(/^\/w\/([^/]+)/);
  const clientMatch = path.match(/^\/w\/[^/]+\/c\/([^/]+)/);
  const activeWs = wsMatch?.[1];
  const activeClient = clientMatch?.[1];
  const onApprovals = /^\/w\/[^/]+\/approvals/.test(path);

  return (
    <aside className="sidebar" aria-label={labels.workspaces}>
      <a className="sidebar-brand" href="/app" aria-label="GLIO">GLIO<span aria-hidden="true">.</span></a>
      <nav className="sidebar-nav">
        <a href="/app" className={path === "/app" ? "active" : undefined} aria-current={path === "/app" ? "page" : undefined}>
          <Icon d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /> {labels.home}
        </a>
        {workspaces.map((w) => {
          const open = w.id === activeWs;
          return (
            <div key={w.id} className="sidebar-group">
              <a href={`/w/${w.id}`} className={open && !activeClient && !onApprovals ? "active" : undefined} aria-current={open && !activeClient && !onApprovals ? "page" : undefined}>
                <Icon d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /> <span className="truncate">{w.name}</span>
              </a>
              {open && (
                <ul>
                  <li>
                    <a href={`/w/${w.id}/approvals`} className={onApprovals ? "active" : undefined} aria-current={onApprovals ? "page" : undefined}>
                      <Icon d="M9 12l2 2 4-4M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
                      <span className="truncate">{labels.approvals}</span>
                      {w.pendingApprovals > 0 && <span className="pill" aria-label={`${w.pendingApprovals}`}>{w.pendingApprovals}</span>}
                    </a>
                  </li>
                  {w.clients.slice(0, MAX_CLIENTS).map((c) => (
                    <li key={c.id}>
                      <a href={`/w/${w.id}/c/${c.id}`} className={c.id === activeClient ? "active" : undefined} aria-current={c.id === activeClient ? "page" : undefined}>
                        <span className="dot" aria-hidden="true" /> <span className="truncate">{c.name}</span>
                      </a>
                    </li>
                  ))}
                  {w.clients.length > MAX_CLIENTS && (
                    <li><a href={`/w/${w.id}`} className="more">{labels.allClients}</a></li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <form action={switchLanguage}>
          <input type="hidden" name="lang" value={lang === "ar" ? "en" : "ar"} />
          <button type="submit" className="sidebar-btn" lang={lang === "ar" ? "en" : "ar"}>{labels.switchLang}</button>
        </form>
        <a className="sidebar-link" href="/">{labels.website}</a>
        <div className="sidebar-user" dir="ltr" title={email}>{email}</div>
        <form action={signOut}>
          <button type="submit" className="sidebar-btn">{labels.signOut}</button>
        </form>
      </div>
    </aside>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
