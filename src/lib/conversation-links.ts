export type ConversationLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string }
  | { kind: "unsupported" };

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlPath(value: string) {
  try {
    const url = new URL(value);
    const pathname = decodePath(url.pathname);
    if (url.host) return undefined;
    return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return undefined;
  }
}

/**
 * Markdown produced by an agent is untrusted UI content. Classify every link
 * before it can reach WebView navigation or the operating system.
 */
export function classifyConversationLink(rawHref?: string): ConversationLinkTarget {
  const href = rawHref?.trim();
  if (!href) return { kind: "unsupported" };
  if (href.startsWith("#")) return { kind: "anchor", id: decodePath(href.slice(1)) };
  if (/^[\\/]{2}/.test(href)) return { kind: "unsupported" };

  const isWindowsPath = /^[a-z]:[\\/]/i.test(href);
  if (!isWindowsPath) {
    let url: URL | undefined;
    try {
      url = new URL(href);
    } catch {
      // Relative filesystem paths intentionally fall through below.
    }
    if (url) {
      if (["http:", "https:", "mailto:"].includes(url.protocol)) {
        return { kind: "external", url: url.toString() };
      }
      if (url.protocol === "file:") {
        const path = fileUrlPath(href);
        return path ? { kind: "file", path } : { kind: "unsupported" };
      }
      return { kind: "unsupported" };
    }
  }

  const path = decodePath(href.split(/[?#]/, 1)[0] ?? "").trim();
  return path && !path.includes("\0") ? { kind: "file", path } : { kind: "unsupported" };
}
