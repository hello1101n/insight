import { useTranslation } from "react-i18next";

import type {
  AttentionItem,
  BindingHistoryEntry,
  PersonSummary,
} from "@/api/identity-client";
import { AccountActions } from "@/components/portal/account-actions";
import { PersonId } from "@/components/portal/person-id";
import { Badge } from "@gears-frontx/ui-kit";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import type { AccountRef } from "@/lib/identities/account-key";
import { holderCard, isQueueItem } from "@/lib/identities/cases";
import { personDisplayName } from "@/lib/identities/person-display";
import { accountTrail } from "@/lib/identities/trail";
import { formatUtcAge, formatUtcInstant } from "@/lib/format";
import { useAccountBinding } from "@/queries/identity-resolution";

const VERB_KEYS: Record<string, string> = {
  "operator-bind": "identities.history.bind",
  "operator-merge": "identities.history.merge",
  "operator-detach": "identities.history.detach",
  "operator-exclude": "identities.history.exclude",
  "login-bootstrap": "identities.history.login_bootstrap",
  "roster-mint": "identities.history.roster_mint",
  "auto-seed-link": "identities.history.auto_seed_link",
  "auto-seed-employee-id-link": "identities.history.auto_seed_employee_id_link",
};

export function AccountDetail({
  accountRef,
  queueItem,
  vouched = false,
  holder,
  onDecided,
}: {
  accountRef: AccountRef;
  queueItem: AttentionItem | undefined;
  vouched?: boolean;
  holder?: PersonSummary | null;
  onDecided?: () => void;
}) {
  const { t } = useTranslation();
  const binding = useAccountBinding(accountRef);

  if (binding.isLoading) return <CenteredSpinner className="min-h-40" />;
  if (binding.isError) {
    return (
      <ComingSoon
        variant="card"
        state="error"
        label={t("identities.detail.load_failed")}
        onRetry={() => void binding.refetch()}
      />
    );
  }
  if (!binding.data) return null;

  const neverSeen =
    !vouched &&
    queueItem == null &&
    binding.data.person_id == null &&
    binding.data.history.length === 0;
  if (neverSeen) {
    return (
      <ComingSoon
        variant="card"
        state="empty"
        label={t("identities.detail.not_found")}
      />
    );
  }

  const candidates = queueItem?.candidates ?? [];
  const boundCard = holderCard(
    binding.data.person_id ?? null,
    holder,
    candidates
  );
  const events = accountTrail(binding.data.history, binding.data.operations);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div className="shrink-0">
        <AccountActions
          accountRef={accountRef}
          binding={binding.data}
          candidates={candidates}
          holder={boundCard}
          queued={queueItem != null && isQueueItem(queueItem.kind)}
          onDecided={onDecided}
        />
      </div>
      <section className="flex min-h-0 flex-1 flex-col">
        <SectionLabel>{t("identities.detail.history")}</SectionLabel>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("identities.detail.no_history")}
          </p>
        ) : (
          <ol className="flex min-h-48 flex-1 flex-col gap-2 overflow-y-auto pe-1">
            {events.map((event) => (
              <HistoryRow
                key={event.key}
                entry={event.entry}
                comment={event.comment}
                known={boundCard ? [...candidates, boundCard] : candidates}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function HistoryRow({
  entry,
  comment,
  known,
}: {
  entry: BindingHistoryEntry;
  comment?: string;
  known: PersonSummary[];
}) {
  const { t } = useTranslation();
  const reason = entry.reason?.trim() || undefined;
  const verbKey = reason ? VERB_KEYS[reason] : undefined;
  const target =
    entry.person ?? known.find((c) => c.person_id === entry.person_id);
  return (
    <li className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline">
          {verbKey ? t(verbKey) : (reason ?? t("identities.history.linked"))}
        </Badge>
        <span className="ms-auto text-xs text-muted-foreground">
          {formatUtcInstant(entry.recorded_at, "d MMM yyyy, HH:mm")}
          <span className="opacity-70">
            {` (${formatUtcAge(entry.recorded_at)})`}
          </span>
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{t("identities.history.to")}</span>
        {target ? (
          <span className="font-medium text-foreground">
            {personDisplayName(target)}
          </span>
        ) : null}
        <PersonId id={entry.person_id} />
        <span className="ms-auto">
          {!entry.by_operator
            ? t("identities.history.by_automation")
            : entry.author
              ? t("identities.history.by_name", {
                  name: personDisplayName(entry.author),
                })
              : t("identities.history.by_operator")}
        </span>
      </div>
      {comment ? (
        <p className="mt-1.5 border-s-2 ps-2 text-xs text-foreground italic select-text">
          {comment}
        </p>
      ) : null}
    </li>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}
