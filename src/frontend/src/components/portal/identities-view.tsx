import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AttentionItem,
  PersonSummary,
  ResolutionRates,
} from "@/api/identity-client";
import { QUEUE_FIRST_PAGE, QUEUE_MAX_ITEMS } from "@/api/identity-client";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Card,
  CardContent,
  CardTitle,
} from "@gears-frontx/ui-kit";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { AccountSearchView } from "@/components/portal/account-search-view";
import { CaseDialog } from "@/components/portal/case-dialog";
import { ConfirmGroupButton } from "@/components/portal/confirm-group-button";
import { MergeCaseDialog } from "@/components/portal/merge-case-dialog";
import { PersonAccountsView } from "@/components/portal/person-accounts-view";
import { PersonCell } from "@/components/portal/person-cell";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { ScrollToEnds } from "@/components/widgets/scroll-to-ends";
import { type IdentitiesSearch, usePortalSearch } from "@/lib/portal/portal-search";
import { usePortalNavActions } from "@/lib/portal/portal-nav";
import { itemKey } from "@/lib/identities/account-key";
import { activatesRow, activatesRowByKey } from "@/lib/identities/row-activation";
import { DEFAULT_MODE, MODES, resolveMode } from "@/lib/portal/identity-modes";
import { personDisplayName } from "@/lib/identities/person-display";
import {
  groupIntoCases,
  groupIsConfirmable,
  type QueueCase,
} from "@/lib/identities/cases";
import { useAttention } from "@/queries/identity-resolution";
import { TEXT_FIGURE, TEXT_LABEL } from "@/lib/type-scale";
import { STATUS_SURFACE_CLASS, type Status } from "@/lib/status";
import { cn } from "@/lib/utils";
import { ChevronDown, PartyPopper, TriangleAlert } from "lucide-react";

const KIND_ORDER = [
  "contested",
  "binding_conflict",
  "provisioned_at_login",
  "minted_from_roster",
  "no_source_id",
  "no_evidence",
] as const;

export function IdentitiesView({ mode }: { mode?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const active: string = resolveMode(mode);

  return (
    <div data-testid="page-manage-identities" className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 p-6">
      <header className="shrink-0">
        <h1 className="text-lg font-semibold tracking-tight">
          {t("identities.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("identities.subtitle")}
        </p>
      </header>
      <Tabs
        className="shrink-0"
        value={active}
        onValueChange={(next) => {
          const picked = String(next);
          const search = (prev: IdentitiesSearch) => ({ find: prev.find, src: prev.src });
          void navigate(
            picked === DEFAULT_MODE
              ? { to: "/manage/identities", search }
              : { to: "/manage/identities/$mode", params: { mode: picked }, search },
          );
        }}
      >
        <TabsList>
          {MODES.map((m) => (
            <TabsTrigger key={m} value={m}>
              {t(`identities.modes.${m}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {active === "person" ? <PersonAccountsView /> : null}
      {active === "accounts" ? <AccountSearchView /> : null}
      {active === "queue" ? <ReviewQueue /> : null}
    </div>
  );
}

function ReviewQueue() {
  const { t } = useTranslation();
  const [readLength, setReadLength] = useState(QUEUE_FIRST_PAGE);
  const attention = useAttention(readLength);

  const askedForMore = readLength > QUEUE_FIRST_PAGE;

  if (attention.isLoading) return <CenteredSpinner className="min-h-[60vh]" />;
  if (attention.isError || !attention.data) {
    return (
      <div className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="error"
          label={t(
            askedForMore
              ? "identities.queue.longer_read_failed"
              : "identities.queue.load_failed",
          )}
          onRetry={() =>
            askedForMore
              ? setReadLength(QUEUE_FIRST_PAGE)
              : void attention.refetch()
          }
        />
      </div>
    );
  }

  const { items, rates, truncated, items_truncated: itemsTruncated } =
    attention.data;
  const longerReadInFlight =
    attention.isFetching && attention.isPlaceholderData;
  const loadMore =
    itemsTruncated && readLength < QUEUE_MAX_ITEMS
      ? () => setReadLength((asked) => Math.min(asked * 2, QUEUE_MAX_ITEMS))
      : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
      {truncated ? (
        <Alert variant="destructive" role="status">
          <TriangleAlert />
          <AlertDescription>{t("identities.queue.truncated")}</AlertDescription>
        </Alert>
      ) : null}
      {itemsTruncated && !truncated && (!loadMore || items.length === 0) ? (
        <Alert role="status">
          <TriangleAlert />
          <AlertDescription>
            {t("identities.queue.items_truncated")}
          </AlertDescription>
        </Alert>
      ) : null}
      <RatesStrip
        rates={rates}
        decisions={items.length}
        decisionsCapped={Boolean(itemsTruncated)}
      />
      <Queue
        items={items}
        onLoadMore={loadMore}
        loadingMore={longerReadInFlight}
      />
    </div>
  );
}

function RatesStrip({
  rates,
  decisions,
  decisionsCapped,
}: {
  rates: ResolutionRates;
  decisions: number;
  decisionsCapped: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
      <Tile
        figure={String(rates.observed)}
        label={t("identities.rates.observed")}
        status="neutral"
      />
      <Tile
        figure={decisionsCapped ? `${decisions}+` : String(decisions)}
        label={t("identities.rates.decisions")}
        status="warn"
      />
      <Tile
        figure={String(rates.excluded)}
        label={t("identities.rates.excluded")}
        status="neutral"
      />
    </div>
  );
}

function Tile({
  figure,
  label,
  status,
}: {
  figure: string;
  label: string;
  status: Status;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className={TEXT_FIGURE}>{figure}</div>
      <span
        className={cn(
          TEXT_LABEL,
          "mt-1 inline-block rounded px-1.5 py-0.5",
          STATUS_SURFACE_CLASS[status],
        )}
      >
        {label}
      </span>
    </div>
  );
}

function AllResolved() {
  const { t } = useTranslation();
  return (
    <Empty className="mx-auto">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PartyPopper />
        </EmptyMedia>
        <EmptyTitle>{t("identities.queue.empty_title")}</EmptyTitle>
        <EmptyDescription>
          {t("identities.queue.empty_description")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Queue({
  items,
  onLoadMore,
  loadingMore,
}: {
  items: AttentionItem[];
  onLoadMore: (() => void) | null;
  loadingMore: boolean;
}) {
  const { t } = useTranslation();
  const { acct } = usePortalSearch();
  const { setAcct } = usePortalNavActions();
  const listRef = useRef<HTMLDivElement>(null);
  const [seenThisSitting, setSeenThisSitting] = useState<ReadonlySet<string>>(
    new Set()
  );
  const groups: Array<{ kind: string; items: AttentionItem[] }> = KIND_ORDER.map(
    (kind) => ({ kind, items: items.filter((i) => i.kind === kind) }),
  ).filter((g) => g.items.length > 0);
  const known = new Set<string>(KIND_ORDER);
  const other = items.filter((i) => !known.has(i.kind));
  if (other.length > 0) groups.push({ kind: "other", items: other });

  const select = (key: string | null) => {
    if (key) setSeenThisSitting((seen) => new Set(seen).add(key));
    setAcct(key);
  };

  const returnFocus = (key: string) => {
    requestAnimationFrame(() => {
      const row =
        listRef.current?.querySelector<HTMLElement>(
          `[data-queue-row="${CSS.escape(key)}"]`,
        ) ??
        listRef.current?.querySelector<HTMLElement>("[data-queue-row]");
      row?.focus();
    });
  };

  const onArrow = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("[data-queue-row]") ??
        []),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* WORKAROUND: a flex child shrinks inside a bounded scroller and clips its overflow-hidden group card, so the groups are blocks. */}
      <div
        ref={listRef}
        onKeyDown={onArrow}
        className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto"
      >
        {items.length === 0 && !onLoadMore ? <AllResolved /> : null}
        {groups.map((group) => (
          <QueueGroup
            key={group.kind}
            kind={group.kind}
            items={group.items}
            selectedKey={acct}
            seenThisSitting={seenThisSitting}
            onSelect={(key) => select(key === acct ? null : key)}
          />
        ))}
        {onLoadMore ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {t(
              loadingMore
                ? "identities.queue.loading_more"
                : "identities.queue.load_more",
            )}
          </Button>
        ) : null}
      </div>
      <ScrollToEnds scroller={listRef} rows={items.length} />
      <CaseDialog
        acct={acct}
        items={items}
        onClose={() => {
          const opened = acct;
          setAcct(null);
          if (opened) returnFocus(opened);
        }}
      />
    </div>
  );
}

function QueueGroup({
  kind,
  items,
  selectedKey,
  seenThisSitting,
  onSelect,
}: {
  kind: string;
  items: AttentionItem[];
  selectedKey: string | undefined;
  seenThisSitting: ReadonlySet<string>;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const cases = useMemo(() => groupIntoCases(items), [items]);

  return (
    <Card className="overflow-hidden">
      <Collapsible defaultOpen>
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="group sticky top-0 z-10 flex w-full cursor-pointer items-center gap-2 bg-card px-6 py-4 text-start hover:bg-muted"
            />
          }
        >
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t(`identities.kind.${kind}`, { defaultValue: kind })}
            <Badge variant="secondary">
              {cases.length === items.length
                ? items.length
                : t("identities.queue.case_count", {
                    count: cases.length,
                    accounts: items.length,
                  })}
            </Badge>
          </CardTitle>
          <SourceCounts items={items} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-2">
            {groupIsConfirmable(kind, items) ? (
              <ConfirmGroupButton items={items} className="self-start" />
            ) : null}
            {cases.map((queueCase) => (
              <CaseBlock
                key={queueCase.key}
                queueCase={queueCase}
                selectedKey={selectedKey}
                seenThisSitting={seenThisSitting}
                onSelect={onSelect}
              />
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function StatusBadge({ status }: { status?: string | null }) {
  const value = status?.trim();
  if (!value || value.toLowerCase() === "active") return null;
  return (
    <Badge variant="secondary" className="shrink-0">
      {value}
    </Badge>
  );
}

function SourceCounts({ items }: { items: AttentionItem[] }) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  return (
    <span className="ms-auto flex flex-wrap items-center gap-1">
      {[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([source, count]) => (
          <span
            key={source}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
          >
            {source} {count}
          </span>
        ))}
    </span>
  );
}

function CaseBlock({
  queueCase,
  selectedKey,
  seenThisSitting,
  onSelect,
}: {
  queueCase: QueueCase;
  selectedKey: string | undefined;
  seenThisSitting: ReadonlySet<string>;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const disputed = queueCase.candidates.length > 0;
  const [survivor, setSurvivor] = useState<PersonSummary | null>(null);
  const mergeable = queueCase.candidates.length >= 2;
  return (
    <div className={cn(disputed && "rounded-lg border bg-muted/20 p-2")}>
      {disputed ? (
        <div className="flex flex-col gap-2 p-1">
          <div className="text-xs text-muted-foreground">
            {t("identities.queue.case_people", {
              count: queueCase.candidates.length,
            })}
            {" · "}
            {t("identities.queue.case_accounts", {
              count: queueCase.items.length,
            })}
          </div>
          {queueCase.candidates.map((candidate) => (
            <div key={candidate.person_id} className="flex items-center gap-2">
              <PersonCell person={candidate} className="min-w-0 flex-1" />
              {mergeable ? (
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSurvivor(candidate)}
                  >
                    {t("identities.actions.merge_into_person")}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("identities.queue.absorb_all")}
                  </span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {survivor ? (
        <MergeCaseDialog
          survivor={survivor}
          absorbed={queueCase.candidates.filter(
            (c) => c.person_id !== survivor.person_id,
          )}
          onClose={() => setSurvivor(null)}
        />
      ) : null}
      <div className="flex flex-col gap-1">
        {queueCase.items.map((item) => {
          const key = itemKey(item);
          const selected = key === selectedKey;
          const label =
            item.email?.trim() ||
            item.username?.trim() ||
            item.display_name?.trim() ||
            item.account_id;
          const description = [
            item.display_name?.trim() === label ? null : item.display_name,
            item.job_title,
            item.department,
            item.manager_email
              ? t("identities.queue.reports_to", { manager: item.manager_email })
              : null,
          ]
            .map((s) => s?.trim())
            .filter(Boolean)
            .join(" · ");
          const boundTo = queueCase.candidates.find(
            (c) => c.person_id === item.bound_to,
          );
          return (
            <div
              key={key}
              // WORKAROUND: a <button> may not nest the copy controls and blocks text selection.
              role="button"
              tabIndex={0}
              data-queue-row={key}
              onClick={(event) => {
                if (activatesRow(event)) onSelect(key);
              }}
              onKeyDown={(event) => {
                if (!activatesRowByKey(event)) return;
                event.preventDefault();
                onSelect(key);
              }}
              aria-pressed={selected}
              aria-label={[
                label,
                item.source,
                boundTo
                  ? t("identities.queue.bound_to", {
                      name: personDisplayName(boundTo),
                    })
                  : null,
                item.status?.trim().toLowerCase() === "active"
                  ? null
                  : item.status,
                description || null,
              ]
                .filter(Boolean)
                .join(", ")}
              className={cn(
                "cursor-pointer rounded-md border p-3 text-start select-text",
                selected
                  ? "border-ring bg-muted"
                  : "border-transparent hover:bg-muted/60",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "truncate text-sm font-medium",
                    seenThisSitting.has(key) &&
                      !selected &&
                      "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
                {boundTo ? (
                  <Badge variant="outline" className="shrink-0">
                    {t("identities.queue.bound_to", {
                      name: personDisplayName(boundTo),
                    })}
                  </Badge>
                ) : null}
                <StatusBadge status={item.status} />
                <span className="ms-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {label === item.account_id ? item.source : `${item.source} · ${item.account_id}`}
                </span>
              </div>
              {description ? (
                <div className="truncate text-xs text-muted-foreground">
                  {description}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
