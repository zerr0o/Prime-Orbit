import { useEffect, useId, useRef, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode } from "react";
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

export function Modal({ title, description, icon, children, onClose, width = "560px", footer, className = "", bodyClassName = "" }: PropsWithChildren<{ title: string; description?: ReactNode; icon?: ReactNode; onClose: () => void; width?: string; footer?: ReactNode; className?: string; bodyClassName?: string }>) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  onCloseRef.current = onClose;
  // This effect owns one open-modal lifecycle. App-level polling can rerender
  // the modal with a fresh callback identity; restarting the effect would
  // restore and then reassign focus while the user is typing.
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    const focusableSelector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusFirstControl = () => {
      if (dialog && document.activeElement && dialog.contains(document.activeElement)) return;
      const first = dialog?.querySelector<HTMLElement>("[data-modal-autofocus]")
        ?? dialog?.querySelector<HTMLElement>("[autofocus]")
        ?? dialog?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialog)?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirstControl);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={`modal-card ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} style={{ maxWidth: width }}>
        <header className="modal-header">
          <div className="modal-heading">
            {icon ? <span className="modal-heading-icon" aria-hidden="true">{icon}</span> : null}
            <div>
              <h2 id={titleId}>{title}</h2>
              {description ? <p id={descriptionId}>{description}</p> : null}
            </div>
          </div>
          <IconButton label={t("common.close")} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className={`modal-body ${bodyClassName}`.trim()}>{children}</div>
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
