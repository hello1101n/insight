import { Search } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AccountMatch } from "@/api/identity-client";
import { PersonCell } from "@/components/portal/person-cell";
import { Badge, Input, Spinner } from "@gears-frontx/ui-kit";
import { useAutoLoadOnScroll } from "@/hooks/use-auto-load-on-scroll";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { accountKey } from "@/lib/identities/account-key";
import { personDisplayName } from "@/lib/identities/person-display";
import { activatesRow, activatesRowByKey } from "@/lib/identities/row-activation";
import {
  listsAnyAccount,
  SEARCH_DEBOUNCE_MS,
  useAccountList,
} from "@/queries/identity-resolution";
import { cn } from "@/lib/utils";

export function AccountPicker({
  onPick,
  excludeKeys = [],
  placeholder,
}: {
  onPick: (account: AccountMatch) => void;
  excludeKeys?: string[];
  placeholder: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = useAccountList(debounced, "match");

  const excluded = new Set(excludeKeys);
  const asked = listsAnyAccount(debounced, "match");
  const items = asked
    ? (search.data?.pages ?? [])
        .flatMap((page) => page.items)
        .filter((item) => !excluded.has(accountKey(item)))
    : [];
  const loading = search.isFetching && !search.isFetchingNextPage;
  const behind = query !== debounced || search.isPlaceholderData;
  const exhausted = !search.hasNextPage;
  const scroller = useRef<HTMLDivElement>(null);
  const loadMore = useAutoLoadOnScroll({
    hasNextPage: Boolean(asked && search.hasNextPage),
    isFetchingNextPage: search.isFetchingNextPage,
    fetchNextPage: () => void search.fetchNextPage(),
    root: scroller,
  });

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="w-full shrink-0">
        <Input
          type="search"
          icon={<Search />}
          end={loading ? <Spinner /> : undefined}
          className={cn(loading && "[&::-webkit-search-cancel-button]:hidden")}
          placeholder={placeholder}
          aria-label={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {asked && search.isError ? (
        <p className="text-sm text-destructive">
          {t("identities.accounts.failed")}
        </p>
      ) : null}
      {asked &&
      search.data &&
      items.length === 0 &&
      !loading &&
      !behind &&
      exhausted ? (
        <p className="text-sm text-muted-foreground">
          {t("identities.accounts.no_matches")}
        </p>
      ) : null}
      {/* WORKAROUND: an IntersectionObserver only reports targets inside its root, so the marker stays inside the scroller. */}
      {items.length > 0 || (asked && search.hasNextPage) ? (
        <div ref={scroller} className="min-h-0 max-h-64 overflow-y-auto">
          <ul
            aria-busy={behind}
            className={cn("flex flex-col gap-1", behind && "opacity-60")}
          >
            {items.map((item) => (
              <li key={accountKey(item)}>
                <AccountOption item={item} onPick={() => onPick(item)} />
              </li>
            ))}
          </ul>
          {asked && search.hasNextPage ? (
            <p
              ref={loadMore}
              aria-live="polite"
              className="p-2 text-sm text-muted-foreground"
            >
              {search.isFetchingNextPage
                ? t("identities.accounts.loading_more")
                : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AccountOption({
  item,
  onPick,
}: {
  item: AccountMatch;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const label =
    item.email?.trim() ||
    item.username?.trim() ||
    item.display_name?.trim() ||
    item.account_id;
  return (
    // WORKAROUND: a <button> may not nest the copy control and blocks text selection.
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (activatesRow(event)) onPick();
      }}
      onKeyDown={(event) => {
        if (!activatesRowByKey(event)) return;
        event.preventDefault();
        onPick();
      }}
      aria-label={[
        label,
        item.source,
        item.person
          ? t("identities.queue.bound_to", {
              name: personDisplayName(item.person),
            })
          : item.excluded
            ? t("identities.accounts.excluded")
            : t("identities.accounts.unbound"),
      ].join(", ")}
      className="grid w-full cursor-pointer grid-cols-1 items-center gap-2 rounded-md border border-transparent p-2 text-start select-text hover:bg-muted/60 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {item.source} · {item.account_id}
        </div>
      </div>
      {item.person ? (
        <PersonCell person={item.person} />
      ) : item.excluded ? (
        <Badge variant="outline" className="justify-self-start">
          {t("identities.accounts.excluded")}
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("identities.accounts.unbound")}
        </span>
      )}
    </div>
  );
}
