import { useEffect, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";
import { useI18n } from "../i18n";

export function IconButton({ label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props} />;
}

export function Button({ variant = "secondary", loading, className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean }) {
  return (
    <button type="button" className={`button button-${variant} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children }: PropsWithChildren<{ tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info" }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`switch ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)} aria-label={label}>
      <span />
    </button>
  );
}

export function Modal({ title, description, children, onClose, width = "560px", footer }: PropsWithChildren<{ title: string; description?: string; onClose: () => void; width?: string; footer?: ReactNode }>) {
  const { t } = useI18n();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title" style={{ maxWidth: width }}>
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <IconButton label={t("common.close")} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function EmptyState({ icon, title, description, children }: PropsWithChildren<{ icon: ReactNode; title: string; description: string }>) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {children ? <div className="empty-actions">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14 }: { width?: string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} />;
}
