import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanSearch, Search, TriangleAlert } from "lucide-react";

import {
  QUEUE_MAX_ITEMS,
  type AccountMatch,
  type AttentionItem,
} from "@/api/identity-client";
import { CaseDialog, type CaseRow } from "@/components/portal/case-dialog";
import { PersonCell } from "@/components/portal/person-cell";
import { SourceFilter } from "@/components/portal/source-filter";
import {
  Alert,
  AlertDescription,
  Badge,
  Input,
  Spinner,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Card,
  CardContent,
} from "@gears-frontx/ui-kit";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { ScrollToEnds } from "@/components/widgets/scroll-to-ends";
import { useAutoLoadOnScroll } from "@/hooks/use-auto-load-on-scroll";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { accountKey, itemKey } from "@/lib/identities/account-key";
import { matchesAccountSearch } from "@/lib/identities/account-search";
import { KIND_SEARCH_MATCH } from "@/lib/identities/cases";
import { personDisplayName } from "@/lib/identities/person-display";
import { activatesRow, activatesRowByKey } from "@/lib/identities/row-activation";
import { formatSources, normalizeSources, parseSources } from "@/lib/identities/sources";
import { usePortalNavActions } from "@/lib/portal/portal-nav";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";
import {
  listsAnyAccount,
  MAX_SEARCH_CHARS,
  SEARCH_DEBOUNCE_MS,
  useAccountList,
  useAccountSources,
  useAttention,
} from "@/queries/identity-resolution";
import { cn } from "@/lib/utils";

const UNMATCHED_REASON_KEYS: Readonly<Record<string, string>> = {
  contested: "identities.accounts.reasons.contested",
  no_source_id: "identities.accounts.reasons.no_source_id",
  no_evidence: "identities.accounts.reasons.no_evidence",
};

const UNMATCHED_KINDS = Object.keys(UNMATCHED_REASON_KEYS);

const HEADING_CLASS =
  "text-xs font-medium tracking-wider text-muted-foreground uppercase";

const ROW_GRID_CLASS =
  "grid cursor-pointer grid-cols-1 items-center gap-2 rounded-md border p-3 text-start select-text lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_minmax(0,11rem)]";

function accountLabel(item: {
  email?: string | null;
  username?: string | null;
  display_name?: string | null;
  account_id: string;
}): string {
  return (
    item.email?.trim() ||
    item.username?.trim() ||
    item.display_name?.trim() ||
    item.account_id
  );
}

export function AccountSearchView() {
  const { t } = useTranslation();
  const { acct, src } = usePortalSearch();
  const { setAcct } = usePortalNavActions();
  const setSearch = useSetPortalSearch();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const sources = useMemo(() => parseSources(src), [src]);
  const search = useAccountList(debounced, "browse", sources);
  const attention = useAttention(QUEUE_MAX_ITEMS, sources, UNMATCHED_KINDS);
  const observedSources = useAccountSources();
  const sourceOptions = normalizeSources([
    ...(observedSources.data ?? []),
    ...sources,
  ]);
  const unmatchedHeading = useId();
  const accountsHeading = useId();

  const lists = listsAnyAccount(debounced, "browse");
  const items = lists
    ? (search.data?.pages ?? []).flatMap((page) => page.items)
    : [];
  const loading = search.isFetching && !search.isFetchingNextPage;
  const asked = debounced.trim() !== "" && lists;
  const stale = query !== debounced || search.isPlaceholderData;
  const scroller = useRef<HTMLDivElement>(null);
  const loadMore = useAutoLoadOnScroll({
    hasNextPage: search.hasNextPage,
    isFetchingNextPage: search.isFetchingNextPage,
    fetchNextPage: () => void search.fetchNextPage(),
    root: scroller,
  });

  const unmatchedAll: AttentionItem[] = attention.isError
    ? []
    : (attention.data?.items ?? []).filter(
        (item) => Object.hasOwn(UNMATCHED_REASON_KEYS, item.kind),
      );
  const queued = new Set(unmatchedAll.map(itemKey));
  const unmatched = unmatchedAll.filter((item) =>
    matchesAccountSearch(item, debounced),
  );
  const unmatchedComplete =
    !attention.isLoading &&
    !attention.isError &&
    attention.data != null &&
    attention.data.truncated !== true &&
    attention.data.items_truncated !== true;
  const walk = unmatched.map(itemKey);
  const listed: CaseRow[] = items.map((m) => ({
    kind: KIND_SEARCH_MATCH,
    source: m.source,
    source_id: m.source_id,
    account_id: m.account_id,
    email: m.email,
    username: m.username,
    display_name: m.display_name,
    candidates: [],
    holder: m.person ?? null,
  }));
  const openable: CaseRow[] = [
    ...unmatchedAll,
    ...listed.filter((row) => !queued.has(itemKey(row))),
  ];

  const attentionTruncated = attention.data?.truncated === true;
  const showUnmatched =
    attention.isError ||
    attention.isLoading ||
    attentionTruncated ||
    unmatchedComplete ||
    unmatched.length > 0;
  const showAccounts =
    search.isError ||
    items.length > 0 ||
    (lists && search.hasNextPage) ||
    (!loading && !stale);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            type="search"
            icon={<Search />}
            end={loading ? <Spinner /> : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("identities.accounts.placeholder")}
            aria-label={t("identities.accounts.placeholder")}
            maxLength={MAX_SEARCH_CHARS}
            className={cn(loading && "[&::-webkit-search-cancel-button]:hidden")}
          />
        </div>
        <SourceFilter
          sources={sourceOptions}
          picked={sources}
          failed={observedSources.isError}
          onChange={(next) => setSearch({ src: formatSources(next) })}
        />
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          className="flex h-full min-w-0 flex-col gap-6 overflow-y-auto"
        >
          {showUnmatched ? (
            <section
              aria-labelledby={unmatchedHeading}
              className="flex flex-col gap-3"
            >
              <div className="flex items-center gap-2">
                <h2 id={unmatchedHeading} className={HEADING_CLASS}>
                  {t("identities.accounts.unmatched")}
                </h2>
                {attention.isLoading ? <Spinner /> : null}
              </div>
              {attention.isError ? (
                <ComingSoon
                  variant="card"
                  state="error"
                  label={t("identities.queue.load_failed")}
                  onRetry={() => void attention.refetch()}
                />
              ) : (
                <>
                  {attentionTruncated ? (
                    <Alert role="status">
                      <TriangleAlert />
                      <AlertDescription>
                        {t("identities.queue.truncated")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {unmatchedComplete && unmatched.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("identities.accounts.none_unmatched")}
                    </p>
                  ) : null}
                  {unmatched.length > 0 ? (
                    <Card>
                      <CardContent className="flex flex-col gap-1">
                        {unmatched.map((item) => (
                          <UnmatchedRow
                            key={itemKey(item)}
                            item={item}
                            selected={itemKey(item) === acct}
                            onOpen={() => setAcct(itemKey(item))}
                          />
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}
                  {attention.data?.items_truncated ? (
                    <Alert role="status">
                      <TriangleAlert />
                      <AlertDescription>
                        {t("identities.queue.items_truncated")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {showAccounts ? (
            <section
              aria-labelledby={accountsHeading}
              className="flex flex-col gap-3"
            >
              <h2 id={accountsHeading} className={HEADING_CLASS}>
                {t("identities.accounts.all_accounts")}
              </h2>

              {search.isError ? (
                <ComingSoon
                  variant="card"
                  state="error"
                  label={t("identities.accounts.failed")}
                />
              ) : null}

              {!loading && !stale && items.length === 0 && !search.isError ? (
                <Empty className="mx-auto">
                  <EmptyHeader>
                    {asked ? null : (
                      <EmptyMedia variant="icon">
                        <ScanSearch />
                      </EmptyMedia>
                    )}
                    <EmptyTitle>
                      {t(
                        asked
                          ? "identities.accounts.no_matches"
                          : "identities.accounts.none_observed",
                      )}
                    </EmptyTitle>
                    <EmptyDescription>
                      {t(
                        asked
                          ? "identities.accounts.no_matches_description"
                          : "identities.accounts.none_observed_description",
                      )}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}

              {items.length > 0 || (lists && search.hasNextPage) ? (
                <Card>
                  <CardContent className="flex flex-col gap-1">
                    {items.map((item) => (
                      <AccountRow
                        key={accountKey(item)}
                        item={item}
                        selected={accountKey(item) === acct}
                        addressesKnown={
                          unmatchedComplete && !queued.has(accountKey(item))
                        }
                        onOpen={() => setAcct(accountKey(item))}
                      />
                    ))}
                    {search.hasNextPage ? (
                      <div
                        ref={loadMore}
                        aria-live="polite"
                        className="p-2 text-sm text-muted-foreground"
                      >
                        {search.isFetchingNextPage
                          ? t("identities.accounts.loading_more")
                          : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
            </section>
          ) : null}
        </div>
        <ScrollToEnds scroller={scroller} rows={items.length + unmatched.length} />
      </div>

      <CaseDialog
        acct={acct}
        items={openable}
        walk={walk}
        onNavigate={setAcct}
        onClose={() => setAcct(null)}
      />
    </div>
  );
}

function UnmatchedRow({
  item,
  selected,
  onOpen,
}: {
  item: AttentionItem;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label = accountLabel(item);
  const reason = t(UNMATCHED_REASON_KEYS[item.kind]);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (activatesRow(event)) onOpen();
      }}
      onKeyDown={(event) => {
        if (!activatesRowByKey(event)) return;
        event.preventDefault();
        onOpen();
      }}
      aria-pressed={selected}
      aria-label={[label, item.source, reason, t("identities.accounts.unbound")].join(", ")}
      className={cn(
        ROW_GRID_CLASS,
        selected ? "border-ring bg-muted" : "border-transparent hover:bg-muted/60",
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {item.source} · {item.account_id}
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{reason}</span>
      <span className="text-xs text-muted-foreground">
        {t("identities.accounts.unbound")}
      </span>
    </div>
  );
}

function AccountRow({
  item,
  selected,
  addressesKnown,
  onOpen,
}: {
  item: AccountMatch;
  selected: boolean;
  addressesKnown: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label = accountLabel(item);
  const holder =
    item.person ?? (item.excluded || !addressesKnown ? null : item.address_holder);
  const matchedByEmail = item.person == null && holder != null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (activatesRow(event)) onOpen();
      }}
      onKeyDown={(event) => {
        if (!activatesRowByKey(event)) return;
        event.preventDefault();
        onOpen();
      }}
      aria-pressed={selected}
      aria-label={[
        label,
        item.source,
        item.person
          ? t("identities.queue.bound_to", {
              name: personDisplayName(item.person),
            })
          : matchedByEmail
            ? `${t("identities.accounts.matched_by_email")}: ${personDisplayName(holder)}`
            : item.excluded
              ? t("identities.accounts.excluded")
              : t("identities.accounts.unbound"),
      ]
        .filter(Boolean)
        .join(", ")}
      className={cn(
        ROW_GRID_CLASS,
        selected ? "border-ring bg-muted" : "border-transparent hover:bg-muted/60",
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {item.source} · {item.account_id}
        </div>
      </div>
      {holder ? (
        <PersonCell person={holder} />
      ) : item.excluded ? (
        <Badge variant="outline" className="justify-self-start">
          {t("identities.accounts.excluded")}
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("identities.accounts.unbound")}
        </span>
      )}
      {matchedByEmail ? (
        <Badge variant="outline" className="justify-self-start">
          {t("identities.accounts.matched_by_email")}
        </Badge>
      ) : item.person || (item.excluded && item.bound_by_operator) ? (
        <Badge variant="outline" className="justify-self-start">
          {item.bound_by_operator
            ? t("identities.person_accounts.by_operator")
            : t("identities.person_accounts.by_automation")}
        </Badge>
      ) : null}
    </div>
  );
}
