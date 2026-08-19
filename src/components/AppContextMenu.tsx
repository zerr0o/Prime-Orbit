import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  Scissors,
  TextSelect,
  Trash2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import type { Conversation, Project } from "../types";

const VIEWPORT_MARGIN = 8;

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface EditableContext {
  element: TextControl | HTMLElement;
  kind: "control" | "contenteditable";
  readOnly: boolean;
  secret: boolean;
  selectionStart: number;
  selectionEnd: number;
  range?: Range;
}

interface ContextTarget {
  x: number;
  y: number;
  projectId?: string;
  editable?: EditableContext;
  selectedText?: string;
  link?: {
    href: string;
  };
}

interface MenuAction {
  id: string;
  label: string;
  shortcut?: string;
  icon: typeof Copy;
  disabled?: boolean;
  group: "edit" | "selection" | "link" | "project" | "location" | "archive" | "danger";
  tone?: "default" | "danger";
  run: () => void | Promise<void>;
}

interface AppContextMenuProps {
  projects?: Project[];
  conversations?: Conversation[];
  onToggleProjectPin?: (project: Project) => void;
  onRenameProject?: (project: Project) => void;
  onRevealProject?: (project: Project) => void | Promise<void>;
  onArchiveProjectConversations?: (project: Project) => void;
  onDeleteProject?: (project: Project) => void;
}

function isTextControl(element: Element): element is TextControl {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ["text", "search", "url", "tel", "password"].includes(element.type);
}

function getEditableContext(target: Element): EditableContext | undefined {
  const control = target.closest("input, textarea");
  if (control && isTextControl(control)) {
    return {
      element: control,
      kind: "control",
      readOnly: control.readOnly || control.disabled,
      secret: control instanceof HTMLInputElement && control.type === "password",
      selectionStart: control.selectionStart ?? 0,
      selectionEnd: control.selectionEnd ?? 0,
    };
  }

  const contenteditable = target.closest("[contenteditable]");
  if (!(contenteditable instanceof HTMLElement) || !contenteditable.isContentEditable) return undefined;

  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 && contenteditable.contains(selection.anchorNode)
    ? selection.getRangeAt(0).cloneRange()
    : undefined;
  return {
    element: contenteditable,
    kind: "contenteditable",
    readOnly: false,
    secret: false,
    selectionStart: 0,
    selectionEnd: range?.collapsed === false ? 1 : 0,
    range,
  };
}

function restoreEditableSelection(context: EditableContext) {
  context.element.focus({ preventScroll: true });
  if (context.kind === "control") {
    const control = context.element as TextControl;
    control.setSelectionRange(context.selectionStart, context.selectionEnd);
    return;
  }
  if (!context.range) return;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(context.range.cloneRange());
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.cssText = "position:fixed;left:-10000px;top:-10000px;opacity:0";
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  }
}

function dispatchEdit(element: HTMLElement, inputType: string, data: string | null = null) {
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
}

function replaceEditableSelection(context: EditableContext, text: string, inputType: string) {
  restoreEditableSelection(context);
  if (context.kind === "control") {
    const control = context.element as TextControl;
    control.setRangeText(text, context.selectionStart, context.selectionEnd, "end");
    dispatchEdit(control, inputType, text || null);
    return;
  }

  if (document.execCommand("insertText", false, text)) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchEdit(context.element, inputType, text || null);
}

function editableSelectionText(context: EditableContext) {
  if (context.secret) return "";
  if (context.kind === "control") {
    const control = context.element as TextControl;
    return control.value.slice(context.selectionStart, context.selectionEnd);
  }
  return context.range?.toString() ?? "";
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return undefined;
  }
}

async function openExternalLink(href: string) {
  const protocol = new URL(href, window.location.href).protocol;
  if (!["http:", "https:", "mailto:"].includes(protocol)) return;
  try {
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

/**
 * Mount once near the application root. It suppresses the WebView's native
 * context menu globally and renders a focused app menu only when the target has
 * useful contextual actions.
 */
export function AppContextMenu({
  projects = [],
  conversations = [],
  onToggleProjectPin,
  onRenameProject,
  onRevealProject,
  onArchiveProjectConversations,
  onDeleteProject,
}: AppContextMenuProps = {}) {
  const { t } = useI18n();
  const [context, setContext] = useState<ContextTarget>();
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | undefined>(undefined);

  const close = useCallback((restoreFocus = false) => {
    setContext(undefined);
    if (restoreFocus) restoreFocusRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const target = event.target;
      if (!(target instanceof Element)) {
        setContext(undefined);
        return;
      }

      const projectTarget = target.closest<HTMLElement>('[data-context-type="project"][data-context-id]');
      const projectId = projectTarget?.dataset.contextId;
      if (projectId) {
        restoreFocusRef.current = target.closest<HTMLElement>("button, [tabindex]")
          ?? projectTarget.querySelector<HTMLElement>("button:not([tabindex='-1']), [tabindex]:not([tabindex='-1'])")
          ?? undefined;
        const rect = projectTarget.getBoundingClientRect();
        const x = event.clientX || rect.left;
        const y = event.clientY || rect.bottom;
        setPosition({ x, y });
        setContext({ x, y, projectId });
        return;
      }

      const editable = getEditableContext(target);
      const anchor = target.closest("a[href]");
      const selection = window.getSelection();
      const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
      let selectionTouchesTarget = false;
      try {
        selectionTouchesTarget = Boolean(selectedRange?.intersectsNode(target));
      } catch {
        selectionTouchesTarget = false;
      }
      const selectedText = editable
        ? editableSelectionText(editable)
        : selectionTouchesTarget ? selection?.toString() ?? "" : "";
      const link = anchor instanceof HTMLAnchorElement && anchor.href ? { href: anchor.href } : undefined;

      if (!editable && !selectedText && !link) {
        setContext(undefined);
        return;
      }

      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const rect = target.getBoundingClientRect();
      const x = event.clientX || rect.left;
      const y = event.clientY || rect.bottom;
      setPosition({ x, y });
      setContext({ x, y, editable, selectedText, link });
    };

    document.addEventListener("contextmenu", handleContextMenu, true);
    return () => document.removeEventListener("contextmenu", handleContextMenu, true);
  }, []);

  useEffect(() => {
    if (!context) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") {
        close(true);
      }
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [close, context]);

  const actions = useMemo<MenuAction[]>(() => {
    if (!context) return [];
    if (context.projectId) {
      const project = projects.find((item) => item.id === context.projectId);
      if (!project) return [];
      const visibleConversationCount = conversations.filter(
        (conversation) => conversation.projectId === project.id && !conversation.archived,
      ).length;
      return [
        {
          id: project.pinned ? "unpin-project" : "pin-project",
          label: t(project.pinned ? "context.unpinProject" : "context.pinProject"),
          icon: project.pinned ? PinOff : Pin,
          group: "project",
          run: () => onToggleProjectPin?.(project),
        },
        {
          id: "rename-project",
          label: t("context.renameProject"),
          icon: Pencil,
          group: "project",
          run: () => onRenameProject?.(project),
        },
        {
          id: "reveal-project",
          label: t("context.revealProject"),
          icon: FolderOpen,
          group: "location",
          run: () => onRevealProject?.(project),
        },
        {
          id: "archive-project-conversations",
          label: t("context.archiveProjectConversations"),
          icon: Archive,
          disabled: visibleConversationCount === 0,
          group: "archive",
          run: () => onArchiveProjectConversations?.(project),
        },
        {
          id: "delete-project",
          label: t("context.deleteProject"),
          icon: Trash2,
          group: "danger",
          tone: "danger",
          run: () => onDeleteProject?.(project),
        },
      ];
    }
    const result: MenuAction[] = [];
    const editable = context.editable;
    if (editable) {
      const selectedText = editableSelectionText(editable);
      const hasSelection = editable.selectionEnd > editable.selectionStart || Boolean(editable.range && !editable.range.collapsed);
      result.push(
        {
          id: "cut",
          label: t("context.cut"),
          shortcut: "Ctrl+X",
          icon: Scissors,
          disabled: editable.readOnly || editable.secret || !hasSelection,
          group: "edit",
          run: async () => {
            if (!selectedText || !(await writeClipboard(selectedText))) return;
            replaceEditableSelection(editable, "", "deleteByCut");
          },
        },
        {
          id: "copy",
          label: t("context.copy"),
          shortcut: "Ctrl+C",
          icon: Copy,
          disabled: editable.secret || !hasSelection,
          group: "edit",
          run: async () => { await writeClipboard(selectedText); },
        },
        {
          id: "paste",
          label: t("context.paste"),
          shortcut: "Ctrl+V",
          icon: ClipboardPaste,
          disabled: editable.readOnly,
          group: "edit",
          run: async () => {
            const text = await readClipboard();
            if (text === undefined) {
              restoreEditableSelection(editable);
              document.execCommand("paste");
              return;
            }
            replaceEditableSelection(editable, text, "insertFromPaste");
          },
        },
        {
          id: "select-all",
          label: t("context.selectAll"),
          shortcut: "Ctrl+A",
          icon: TextSelect,
          group: "edit",
          run: () => {
            editable.element.focus({ preventScroll: true });
            if (editable.kind === "control") {
              (editable.element as TextControl).select();
              return;
            }
            const range = document.createRange();
            range.selectNodeContents(editable.element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          },
        },
      );
    } else if (context.selectedText) {
      result.push({
        id: "copy-selection",
        label: t("context.copy"),
        shortcut: "Ctrl+C",
        icon: Copy,
        group: "selection",
        run: async () => { await writeClipboard(context.selectedText ?? ""); },
      });
    }

    if (context.link) {
      result.push(
        {
          id: "open-link",
          label: t("context.openLink"),
          icon: ExternalLink,
          group: "link",
          run: () => openExternalLink(context.link!.href),
        },
        {
          id: "copy-link",
          label: t("context.copyLink"),
          icon: Copy,
          group: "link",
          run: async () => { await writeClipboard(context.link!.href); },
        },
      );
    }
    return result;
  }, [context, conversations, onArchiveProjectConversations, onDeleteProject, onRenameProject, onRevealProject, onToggleProjectPin, projects, t]);

  useLayoutEffect(() => {
    if (!context || !menuRef.current) return;
    const bounds = menuRef.current.getBoundingClientRect();
    const x = Math.max(VIEWPORT_MARGIN, Math.min(context.x, window.innerWidth - bounds.width - VIEWPORT_MARGIN));
    const y = Math.max(VIEWPORT_MARGIN, Math.min(context.y, window.innerHeight - bounds.height - VIEWPORT_MARGIN));
    setPosition((current) => current.x === x && current.y === y ? current : { x, y });
    menuRef.current.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }, [actions.length, context]);

  if (!context || actions.length === 0) return null;

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "ArrowUp") nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
    else if (event.key === "ArrowDown") nextIndex = activeIndex >= items.length - 1 ? 0 : activeIndex + 1;
    items[nextIndex]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={menuRef}
      className="app-context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={t("context.menu")}
      onKeyDown={handleMenuKeyDown}
    >
      {actions.map((action, index) => {
        const previous = actions[index - 1];
        const Icon = action.icon;
        return (
          <div key={action.id}>
            {previous && previous.group !== action.group ? <div className="app-context-separator" role="separator" /> : null}
            <button
              className={`app-context-item ${action.tone === "danger" ? "is-danger" : ""}`}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                close(true);
                void action.run();
              }}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{action.label}</span>
              {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
