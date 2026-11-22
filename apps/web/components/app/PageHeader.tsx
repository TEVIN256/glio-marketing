export interface Crumb { href?: string; label: string }

/** Page title with breadcrumbs and an actions slot. */
export function PageHeader({ crumbs, title, subtitle, actions }: { crumbs?: Crumb[]; title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i}>
                {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
                {i < crumbs.length - 1 && <span aria-hidden="true" className="crumb-sep"> / </span>}
              </span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
