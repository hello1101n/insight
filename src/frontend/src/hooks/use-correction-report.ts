import { useTranslation } from "react-i18next";

import type { CorrectionResponse } from "@/api/identity-client";
import { toast } from "@gears-frontx/ui-kit";
import { fullyDecided, refusedCount } from "@/lib/identities/outcomes";

const MINTED_ID_TOAST_MS = 15_000;

export function useCorrectionReport(): (result: CorrectionResponse) => boolean {
  const { t } = useTranslation();
  return (result: CorrectionResponse) => {
    if (!fullyDecided(result)) {
      const refused = refusedCount(result);
      toast.add({
        type: "error",
        title: refused > 0
          ? t("identities.outcomes.toast_refused", { count: refused })
          : t("identities.dialogs.failed"),
      });
      return false;
    }

    const message =
      result.applied > 0
        ? t("identities.outcomes.toast_applied", { count: result.applied })
        : t("identities.outcomes.toast_already");
    toast.add({
      type: "success",
      title: message,
      description: result.new_person_id
        ? `${t("identities.outcomes.new_person")} ${result.new_person_id}`
        : undefined,
      timeout: result.new_person_id ? MINTED_ID_TOAST_MS : undefined,
    });
    return true;
  };
}
