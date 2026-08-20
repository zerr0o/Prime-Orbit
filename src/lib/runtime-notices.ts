import { translate, type AppLanguage } from "../i18n";

export type RuntimeNotice =
  | {
      kind: "html_export";
      status: "success";
      conversationId: string;
      conversationTitle: string;
      path: string;
    }
  | {
      kind: "html_export";
      status: "error";
      conversationId: string;
      conversationTitle: string;
      error: string;
    };

export interface RuntimeNoticeToast {
  tone: "success" | "error";
  message: string;
  persistent: true;
}

/** Keep background operation feedback independent from the currently mounted
 * conversation. This pure formatter also makes the bilingual contract easy to
 * verify without mounting the desktop application. */
export function runtimeNoticeToast(language: AppLanguage, notice: RuntimeNotice): RuntimeNoticeToast {
  if (notice.status === "success") {
    return {
      tone: "success",
      message: translate(language, "app.htmlExportSuccess", {
        title: notice.conversationTitle,
        path: notice.path,
      }),
      persistent: true,
    };
  }
  return {
    tone: "error",
    message: translate(language, "app.htmlExportFailed", {
      title: notice.conversationTitle,
      error: notice.error,
    }),
    persistent: true,
  };
}
