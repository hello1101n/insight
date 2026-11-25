import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  toWireAccountRef,
  type AccountMatch,
  type CorrectionResponse,
  type PersonAccountEntry,
  type PersonSummary,
} from "@/api/identity-client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AccountPicker } from "@/components/portal/account-picker";
import { OutcomeAlert } from "@/components/portal/outcome-alert";
import { PersonCell, PersonMarks } from "@/components/portal/person-cell";
import { PersonId } from "@/components/portal/person-id";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@gears-frontx/ui-kit";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { useCorrectionReport } from "@/hooks/use-correction-report";
import { accountKey } from "@/lib/identities/account-key";
import { detachOffered } from "@/lib/identities/cases";
import { personName } from "@/lib/identities/person-display";
import { apiErrorReason } from "@/lib/query-console/api-error";
import {
  useBindAccount,
  useDetachAccount,
  useExcludeAccount,
  usePersonAccounts,
} from "@/queries/identity-resolution";
import { useIsAdmin } from "@/queries/identity-me";
import {
  useGrantAdmin,
  usePersonAdminRole,
  useRevokeAdmin,
} from "@/queries/person-roles";
import { cn } from "@/lib/utils";

type PendingAction =
  | { kind: "closed" }
  | { kind: "bind"; account: AccountMatch }
  | { kind: "detach"; account: PersonAccountEntry }
  | { kind: "exclude"; account: PersonAccountEntry };

interface HeldPerson {
  id: string;
  card: PersonSummary | null;
}

export function PersonDialog({
  personId,
  card,
  onClose,
}: {
  personId: string | undefined;
  card: PersonSummary | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  const liveId = personId ?? null;
  const liveCard = card?.person_id === liveId ? card : null;

  // WORKAROUND: the popup animates closed after `?person=` clears, so the subject
  // is held in state until the next one opens.
  const [held, setHeld] = useState<HeldPerson | null>(null);
  if (liveId && (held?.id !== liveId || held.card !== liveCard)) {
    setHeld({ id: liveId, card: liveCard });
  }
  const shown = liveId ? { id: liveId, card: liveCard } : held;
  const person: PersonSummary | null = shown
    ? (shown.card ?? { person_id: shown.id })
    : null;
  const named = person ? personName(person) : null;

  return (
    <Dialog
      open={liveId != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={popupRef}
        closeLabel={t("common.actions.close")}
        className="flex h-[85vh] flex-col gap-4 sm:max-w-3xl"
        // WORKAROUND: `initialFocus={false}` leaves focus in the aria-hidden page behind the dialog.
        tabIndex={-1}
        initialFocus={popupRef}
      >
        <DialogHeader>
          <DialogTitle
            render={<h2 className="flex min-w-0 items-center gap-2" />}
          >
            <span
              className={cn(
                "truncate select-text",
                !named && "text-muted-foreground italic",
              )}
            >
              {named ?? t("identities.person.unnamed")}
            </span>
            {person ? <PersonMarks person={person} /> : null}
          </DialogTitle>
          <DialogDescription render={<div className="flex items-center gap-1" />}>
            {person ? <PersonId id={person.person_id} /> : null}
            {person ? (
              <AdminRoleControl
                key={person.person_id}
                personId={person.person_id}
              />
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {person ? (
          <PersonBody
            key={person.person_id}
            person={person}
            onDecided={() => {
              // WORKAROUND: the refetch unmounts the pressed control and the browser drops focus to
              // `body`; refocus a frame later, once the list has settled.
              requestAnimationFrame(() => popupRef.current?.focus());
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const LAST_ADMIN_REASON = "last_admin_protected";

function isLastAdminRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return false;
  const context = (body as { context?: unknown }).context;
  if (typeof context !== "object" || context === null) return false;
  return (context as { reason?: unknown }).reason === LAST_ADMIN_REASON;
}

function AdminRoleControl({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const viewer = useIsAdmin();
  const held = usePersonAdminRole(viewer.isAdmin ? personId : null);
  const grant = useGrantAdmin(personId);
  const revoke = useRevokeAdmin(personId);

  if (viewer.isError) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => viewer.retry()}
      >
        {t("identities.person.admin_viewer_unknown")}
      </Button>
    );
  }

  if (!viewer.isAdmin) return null;

  if (held.isUnknown) {
    return (
      <span className="text-muted-foreground text-xs">
        {t("identities.person.admin_unknown")}
      </span>
    );
  }

  const refusedAsLastAdmin = isLastAdminRefusal(revoke.error);
  const failed = !refusedAsLastAdmin && (grant.isError || revoke.isError);

  return (
    <>
      {held.isAdmin ? (
        <Badge variant="secondary">{t("identities.person.admin_badge")}</Badge>
      ) : null}
      {held.isPending ? null : held.isAdmin ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={revoke.isPending || held.personRoleId == null}
          onClick={() => {
            if (held.personRoleId) revoke.mutate(held.personRoleId);
          }}
        >
          {t("identities.person.admin_revoke")}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {t("identities.person.admin_grant")}
        </Button>
      )}
      {refusedAsLastAdmin ? (
        <span className="text-destructive text-xs">
          {t("identities.person.admin_last")}
        </span>
      ) : failed ? (
        <span className="text-destructive text-xs">
          {apiErrorReason(
            grant.error ?? revoke.error,
            t("identities.person.admin_failed")
          )}
        </span>
      ) : null}
    </>
  );
}

function PersonBody({
  person,
  onDecided,
}: {
  person: PersonSummary;
  onDecided: () => void;
}) {
  const { t } = useTranslation();
  const accounts = usePersonAccounts(person.person_id);
  const [action, setAction] = useState<PendingAction>({ kind: "closed" });
  const [outcome, setOutcome] = useState<CorrectionResponse | null>(null);
  const report = useCorrectionReport();

  const bind = useBindAccount();
  const detach = useDetachAccount();
  const exclude = useExcludeAccount();

  const close = () => {
    setAction({ kind: "closed" });
    bind.reset();
    detach.reset();
    exclude.reset();
  };
  const done = (result: CorrectionResponse) => {
    close();
    const settled = report(result);
    setOutcome(settled ? null : result);
    if (settled) onDecided();
  };

  if (accounts.isLoading) return <CenteredSpinner className="min-h-40" />;
  if (accounts.isError || !accounts.data) {
    return (
      <ComingSoon
        variant="card"
        state="error"
        label={t("identities.person_accounts.load_failed")}
        onRetry={() => void accounts.refetch()}
      />
    );
  }

  const entries = accounts.data.accounts;
  const detachable = detachOffered(person.person_id, entries.length);
  const busy = bind.isPending || detach.isPending || exclude.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {outcome ? <OutcomeAlert outcome={outcome} /> : null}

      <section className="flex min-h-0 flex-col">
        <SectionLabel>{t("identities.person_window.bind_section")}</SectionLabel>
        <AccountPicker
          placeholder={t("identities.person_window.find_account")}
          excludeKeys={entries.map(accountKey)}
          onPick={(account) => setAction({ kind: "bind", account })}
        />
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <SectionLabel>
          {t("identities.person_accounts.accounts")}
          <Badge variant="secondary">{entries.length}</Badge>
        </SectionLabel>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("identities.person_accounts.no_accounts")}
          </p>
        ) : (
          <ul className="flex min-h-24 flex-1 flex-col gap-1 overflow-y-auto pe-1">
            {entries.map((entry) => (
              <li key={accountKey(entry)}>
                <AccountRow
                  entry={entry}
                  detachable={detachable}
                  busy={busy}
                  onDetach={() => setAction({ kind: "detach", account: entry })}
                  onExclude={() => setAction({ kind: "exclude", account: entry })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {action.kind === "bind" ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("identities.person_window.bind_title")}
          description={
            action.account.person &&
            action.account.person.person_id !== person.person_id
              ? t("identities.person_window.bind_from_description", {
                  name: personName(action.account.person) ??
                    action.account.person.person_id,
                })
              : t("identities.person_window.bind_description")
          }
          confirmLabel={t("identities.actions.bind")}
          isPending={bind.isPending}
          error={
            bind.isError
              ? apiErrorReason(bind.error, t("identities.dialogs.failed"))
              : null
          }
          onConfirm={() =>
            bind.mutate(
              {
                account: toWireAccountRef(action.account),
                person_id: person.person_id,
              },
              { onSuccess: done },
            )
          }
        >
          <AccountLine account={action.account} />
          <PersonCell person={person} />
        </ConfirmDialog>
      ) : null}

      {action.kind === "detach" ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("identities.person_window.detach_title")}
          description={t("identities.person_window.detach_description")}
          confirmLabel={t("identities.actions.detach_confirm")}
          isPending={detach.isPending}
          error={
            detach.isError
              ? apiErrorReason(detach.error, t("identities.dialogs.failed"))
              : null
          }
          onConfirm={() =>
            detach.mutate({ account: toWireAccountRef(action.account) }, { onSuccess: done })
          }
        >
          <AccountLine account={action.account} />
        </ConfirmDialog>
      ) : null}

      {action.kind === "exclude" ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("identities.dialogs.exclude_title")}
          description={t("identities.dialogs.exclude_description")}
          confirmLabel={t("identities.actions.exclude_confirm")}
          destructive
          isPending={exclude.isPending}
          error={
            exclude.isError
              ? apiErrorReason(exclude.error, t("identities.dialogs.failed"))
              : null
          }
          onConfirm={() =>
            exclude.mutate({ account: toWireAccountRef(action.account) }, { onSuccess: done })
          }
        >
          <AccountLine account={action.account} />
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function AccountLine({
  account,
}: {
  account: { source: string; account_id: string; email?: string | null; username?: string | null };
}) {
  const label = account.email?.trim() || account.username?.trim() || account.account_id;
  return (
    <div className="min-w-0 rounded-md border p-2">
      <div className="truncate text-sm font-medium select-text">{label}</div>
      <div className="truncate font-mono text-xs text-muted-foreground select-text">
        {account.source} · {account.account_id}
      </div>
    </div>
  );
}

function AccountRow({
  entry,
  detachable,
  busy,
  onDetach,
  onExclude,
}: {
  entry: PersonAccountEntry;
  detachable: boolean;
  busy: boolean;
  onDetach: () => void;
  onExclude: () => void;
}) {
  const { t } = useTranslation();
  const label = entry.email?.trim() || entry.username?.trim() || entry.account_id;
  const names = { account: label, source: entry.source };
  return (
    <div className="grid grid-cols-1 items-center gap-2 rounded-md border border-transparent p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_auto]">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium select-text">{label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground select-text">
          {entry.source} · {entry.account_id}
        </div>
      </div>
      <Badge variant="outline" className="justify-self-start">
        {entry.bound_by_operator
          ? t("identities.person_accounts.by_operator")
          : t("identities.person_accounts.by_automation")}
      </Badge>
      <div className="flex shrink-0 flex-wrap gap-2">
        {detachable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={t("identities.person_window.detach_account", names)}
            onClick={onDetach}
          >
            {t("identities.person_window.detach")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy}
          aria-label={t("identities.person_window.exclude_account", names)}
          onClick={onExclude}
        >
          {t("identities.person_window.exclude")}
        </Button>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}
