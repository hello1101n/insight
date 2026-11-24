import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AccountBinding,
  CorrectionResponse,
  PersonSummary,
  WireAccountRef,
} from "@/api/identity-client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OutcomeAlert } from "@/components/portal/outcome-alert";
import { PersonCell } from "@/components/portal/person-cell";
import { PersonId } from "@/components/portal/person-id";
import { PersonPicker } from "@/components/portal/person-picker";
import { Button } from "@gears-frontx/ui-kit";
import { useCorrectionReport } from "@/hooks/use-correction-report";
import type { AccountRef } from "@/lib/identities/account-key";
import { apiErrorReason } from "@/lib/query-console/api-error";
import {
  useBindAccount,
  useDetachAccount,
  useExcludeAccount,
  usePersonAccounts,
} from "@/queries/identity-resolution";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

function sentences(...parts: (string | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type PendingAction =
  | { kind: "closed" }
  | { kind: "bind"; person: PersonSummary }
  | { kind: "detach" }
  | { kind: "exclude" };

export function AccountActions({
  accountRef,
  binding,
  candidates,
  holder,
  queued = false,
  onDecided,
}: {
  accountRef: AccountRef;
  binding: AccountBinding;
  candidates: PersonSummary[];
  holder?: PersonSummary | null;
  queued?: boolean;
  onDecided?: () => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<PendingAction>({ kind: "closed" });
  const [outcome, setOutcome] = useState<CorrectionResponse | null>(null);
  const report = useCorrectionReport();

  const bind = useBindAccount();
  const detach = useDetachAccount();
  const exclude = useExcludeAccount();
  const busy = bind.isPending || detach.isPending || exclude.isPending;

  const wireRef: WireAccountRef = {
    source: accountRef.source,
    source_id: accountRef.source_id,
    id: accountRef.account_id,
  };
  const boundId = binding.person_id ?? null;
  const boundCard =
    holder?.person_id === boundId
      ? holder
      : candidates.find((c) => c.person_id === boundId);

  const rivals = candidates.filter((c) => c.person_id !== boundId);
  const owned = usePersonAccounts(boundId);
  const detachable =
    boundId == null || (owned.data != null && owned.data.accounts.length > 1);

  const confirmable =
    boundCard != null && candidates.some((c) => c.person_id === boundId);

  const close = () => {
    setAction({ kind: "closed" });
    bind.reset();
    detach.reset();
    exclude.reset();
  };
  const done = (result: CorrectionResponse) => {
    close();
    if (!report(result)) {
      setOutcome(result);
      return;
    }

    setOutcome(null);
    onDecided?.();
  };

  return (
    <div className="flex flex-col gap-4">
      {outcome ? <OutcomeAlert outcome={outcome} /> : null}

      <section>
        <SectionLabel>{t("identities.detail.current_binding")}</SectionLabel>
        {boundId ? (
          <div className="flex items-center gap-2">
            {boundCard ? (
              <PersonCell person={boundCard} className="min-w-0 flex-1" />
            ) : (
              <div className="min-w-0 flex-1">
                <PersonId id={boundId} />
              </div>
            )}
            {confirmable ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  boundCard && setAction({ kind: "bind", person: boundCard })
                }
              >
                {t("identities.actions.confirm")}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("identities.detail.unbound")}
          </p>
        )}
      </section>

      {rivals.length > 0 ? (
        <section>
          <SectionLabel>{t("identities.detail.candidates")}</SectionLabel>
          <div className="flex flex-col gap-2">
            {rivals.map((candidate) => (
              <div key={candidate.person_id} className="flex items-center gap-2">
                <PersonCell person={candidate} className="min-w-0 flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAction({ kind: "bind", person: candidate })}
                >
                  {t("identities.actions.bind")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionLabel>
          {boundId
            ? t("identities.actions.assign_other")
            : t("identities.actions.assign_person")}
        </SectionLabel>
        <PersonPicker
          excludeIds={[
            ...candidates.map((c) => c.person_id),
            ...(boundCard ? [boundCard.person_id] : []),
            ...(boundId ? [boundId] : []),
          ]}
          onPick={(person) => setAction({ kind: "bind", person })}
        />
      </section>

      <section className="flex flex-wrap gap-2">
        {detachable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setAction({ kind: "detach" })}
          >
            {t("identities.actions.detach")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => setAction({ kind: "exclude" })}
        >
          {t("identities.actions.exclude")}
        </Button>
      </section>

      {action.kind === "bind" ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={
            action.person.person_id === boundId
              ? t("identities.dialogs.confirm_title")
              : t("identities.dialogs.bind_title")
          }
          description={sentences(
            action.person.person_id === boundId
              ? t("identities.dialogs.confirm_description")
              : boundId
                ? t("identities.dialogs.rebind_description")
                : t("identities.dialogs.bind_description"),
            queued ? t("identities.dialogs.leaves_queue") : null,
          )}
          confirmLabel={
            action.person.person_id === boundId
              ? t("identities.actions.confirm")
              : t("identities.actions.bind")
          }
          isPending={bind.isPending}
          error={
            bind.isError
              ? apiErrorReason(bind.error, t("identities.dialogs.failed"))
              : null
          }
          onConfirm={() =>
            bind.mutate(
              { account: wireRef, person_id: action.person.person_id },
              { onSuccess: done },
            )
          }
        >
          <PersonCell person={action.person} />
        </ConfirmDialog>
      ) : null}

      {action.kind === "detach" ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("identities.dialogs.detach_title")}
          description={sentences(
            t("identities.dialogs.detach_description"),
            queued ? t("identities.dialogs.leaves_queue") : null,
          )}
          confirmLabel={t("identities.actions.detach_confirm")}
          isPending={detach.isPending}
          error={
            detach.isError
              ? apiErrorReason(detach.error, t("identities.dialogs.failed"))
              : null
          }
          onConfirm={() => detach.mutate({ account: wireRef }, { onSuccess: done })}
        />
      ) : null}

      {action.kind === "exclude" ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("identities.dialogs.exclude_title")}
          description={sentences(
            t("identities.dialogs.exclude_description"),
            queued ? t("identities.dialogs.leaves_queue") : null,
          )}
          confirmLabel={t("identities.actions.exclude_confirm")}
          destructive
          isPending={exclude.isPending}
          error={
            exclude.isError
              ? apiErrorReason(exclude.error, t("identities.dialogs.failed"))
              : null
          }
          onConfirm={() => exclude.mutate({ account: wireRef }, { onSuccess: done })}
        />
      ) : null}
    </div>
  );
}
