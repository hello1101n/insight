import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { useViewer } from "@/auth";
import { normalizePersonId } from "@/lib/metrics/entity";
import { usePortalNavActions, usePortalScope } from "@/lib/portal/portal-nav";

export function ScopeChip({ label }: { label: string }) {
  const { t } = useTranslation();
  const { root } = usePortalScope();
  const { personId } = useViewer();
  const { setScope } = usePortalNavActions();

  const scopedToSomeoneElse =
    root != null &&
    normalizePersonId(root) !== normalizePersonId(personId ?? "");
  if (!scopedToSomeoneElse) return null;

  return (
    <span className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 ps-3 pe-1 text-sm">
      <span className="text-muted-foreground">{t("metrics_view.scoped")}</span>
      <span className="font-medium">{label}</span>
      <button
        type="button"
        aria-label={t("metrics_view.clear_scope", { label })}
        onClick={() => setScope({ root: null })}
        className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}
