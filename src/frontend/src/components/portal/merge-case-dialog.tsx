import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast, Button, Checkbox } from "@gears-frontx/ui-kit";

import type { CorrectionResponse, PersonSummary } from "@/api/identity-client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PersonCell } from "@/components/portal/person-cell";
import { personDisplayName } from "@/lib/identities/person-display";
import {
  combineOutcomes,
  fullyDecided,
  refusedCount,
} from "@/lib/identities/outcomes";
import { apiErrorReason } from "@/lib/query-console/api-error";
import {
  useMergePersons,
  usePersonAccountsMany,
} from "@/queries/identity-resolution";

const PREVIEW_ROWS = 5;

export function MergeCaseDialog({
  survivor,
  absorbed,
  onClose,
}: {
  survivor: PersonSummary;
  absorbed: PersonSummary[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const merge = useMergePersons();
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(absorbed.map((person) => person.person_id)),
  );

  const taking = absorbed.filter((person) => chosen.has(person.person_id));
  const moving = usePersonAccountsMany(taking.map((person) => person.person_id));
  const survivorName = personDisplayName(survivor);

  const toggle = (personId: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(personId)) next.add(personId);
      return next;
    });

  const run = async () => {
    if (running) return;
    setRunning(true);
    setFailure(null);

    const landed: CorrectionResponse[] = [];
    for (const person of taking) {
      try {
        landed.push(
          await merge.mutateAsync({
            source_person_id: person.person_id,
            target_person_id: survivor.person_id,
          }),
        );
      } catch (error) {
        setRunning(false);
        reportOutlivingDialog(t, setFailure, apiErrorReason(error, t("identities.dialogs.failed")), landed);
        return;
      }
    }
    setRunning(false);

    const result = combineOutcomes(landed);
    if (!fullyDecided(result)) {
      const refused = refusedCount(result);
      reportOutlivingDialog(
        t,
        setFailure,
        refused > 0
          ? t("identities.outcomes.toast_refused", { count: refused })
          : t("identities.dialogs.failed"),
        landed,
      );
      return;
    }

    toast.add({
      type: "success",
      title: t("identities.outcomes.toast_applied", { count: result.applied }),
    });
    onClose();
  };

  const nothingChosen = taking.length === 0;
  const canConfirmMerge =
    !nothingChosen && moving.ready && moving.accounts.length > 0;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("identities.dialogs.merge_case_title", { name: survivorName })}
      description={t("identities.dialogs.merge_case_description", {
        name: survivorName,
      })}
      confirmLabel={t("identities.actions.merge_confirm")}
      destructive
      isPending={running}
      confirmDisabled={!canConfirmMerge}
      error={failure}
      onConfirm={() => void run()}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t("identities.dialogs.merge_case_stays")}</SectionLabel>
          <PersonCell person={survivor} />
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel>
            {t("identities.dialogs.merge_case_absorbed", {
              count: absorbed.length,
            })}
          </SectionLabel>
          {absorbed.map((person) =>
            absorbed.length === 1 ? (
              <PersonCell key={person.person_id} person={person} />
            ) : (
              <label
                key={person.person_id}
                htmlFor={`absorb-${person.person_id}`}
                className="flex cursor-pointer items-center gap-2 rounded-sm p-1 hover:bg-muted"
              >
                <Checkbox
                  id={`absorb-${person.person_id}`}
                  checked={chosen.has(person.person_id)}
                  disabled={running}
                  onCheckedChange={() => toggle(person.person_id)}
                />
                <PersonCell person={person} className="min-w-0 flex-1" />
              </label>
            ),
          )}
        </div>

        {nothingChosen ? (
          <p className="text-sm text-muted-foreground">
            {t("identities.dialogs.merge_case_none_chosen")}
          </p>
        ) : moving.failed ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <span>{t("identities.dialogs.merge_preview_failed")}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => moving.refetch()}
            >
              {t("common.actions.retry")}
            </Button>
          </div>
        ) : !moving.ready ? (
          <p className="text-sm text-muted-foreground">
            {t("identities.dialogs.merge_preview_loading")}
          </p>
        ) : (
          <div className="text-sm">
            <p>
              {t("identities.dialogs.merge_preview", {
                count: moving.accounts.length,
              })}
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {moving.accounts.slice(0, PREVIEW_ROWS).map((account) => (
                <li
                  key={`${account.source}:${account.source_id}:${account.account_id}`}
                  className="truncate font-mono text-xs text-muted-foreground"
                >
                  {account.source} ·{" "}
                  {account.email ?? account.username ?? account.account_id}
                </li>
              ))}
            </ul>
            {moving.accounts.length > PREVIEW_ROWS ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("identities.dialogs.merge_preview_more", {
                  count: moving.accounts.length - PREVIEW_ROWS,
                })}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

function reportOutlivingDialog(
  t: (key: string, vars?: Record<string, unknown>) => string,
  setFailure: (message: string) => void,
  reason: string,
  landed: readonly CorrectionResponse[],
) {
  const applied = combineOutcomes(landed).applied;
  setFailure(reason);
  toast.add({
    type: "error",
    title: reason,
    description: applied > 0
      ? t("identities.outcomes.toast_partial", { count: applied })
      : undefined,
  });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}
