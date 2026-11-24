import { useTranslation } from "react-i18next";

import type { CorrectionResponse } from "@/api/identity-client";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
} from "@gears-frontx/ui-kit";
import { refusedCount } from "@/lib/identities/outcomes";

export function OutcomeAlert({ outcome }: { outcome: CorrectionResponse }) {
  const { t } = useTranslation();
  const refused = refusedCount(outcome);
  return (
    <Alert variant={refused > 0 ? "destructive" : "default"} role="status">
      <AlertTitle className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">
          {t("identities.outcomes.applied", { count: outcome.applied })}
        </Badge>
        {outcome.already_decided > 0 ? (
          <Badge variant="outline">
            {t("identities.outcomes.already_decided", {
              count: outcome.already_decided,
            })}
          </Badge>
        ) : null}
        {refused > 0 ? (
          <Badge variant="destructive">
            {t("identities.outcomes.refused", { count: refused })}
          </Badge>
        ) : null}
      </AlertTitle>
      {outcome.new_person_id ? (
        <AlertDescription className="font-mono">
          {t("identities.outcomes.new_person")} {outcome.new_person_id}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
