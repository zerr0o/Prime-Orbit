import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

const RELEASE_NOTES_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Release notes arrive from the signed update manifest but still render as untrusted content. */
export function safeReleaseNotesHref(rawHref?: string) {
  const href = rawHref?.trim();
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    return RELEASE_NOTES_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function openReleaseNotesLink(href: string) {
  try {
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

export function ReleaseNotesMarkdown({ content }: { content: string }) {
  return (
    <div className="update-release-notes-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => key === "href" ? safeReleaseNotesHref(url) ?? "" : ""}
        components={{
          a: ({ children, href }) => {
            const safeHref = safeReleaseNotesHref(href);
            return safeHref
              ? <a href={safeHref} rel="noreferrer" onClick={(event) => { event.preventDefault(); void openReleaseNotesLink(safeHref); }}>{children}</a>
              : <span className="update-release-notes-unsupported-link">{children}</span>;
          },
          img: ({ alt }) => alt ? <span className="update-release-notes-image-alt">{alt}</span> : null,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
