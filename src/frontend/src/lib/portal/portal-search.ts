import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import type { OwnedFilter } from "@/api/custom-client";
import { validateDateRange } from "@/api/period-to-date-range";
import { isRangeToken } from "@/lib/custom/time-range";
import { formatSources, parseSources } from "@/lib/identities/sources";
import type { PeriodValue } from "@/types/insight";

export interface GlobalSearch {
  scope?: string;
  direct?: boolean;
  slice?: string;
  period?: PeriodValue;
  from?: string;
  to?: string;
}

export interface ExploreSearch {
  repo?: string;
}

export interface IdentitiesSearch {
  acct?: string;
  src?: string;
  person?: string;
  find?: string;
}

export interface MetricsViewSearch {
  metrics?: string;
  compare?: string;
}

export interface DashboardListSearch {
  folder?: string;
  tag?: string[];
  owned?: OwnedFilter;
}

export interface DashboardSearch {
  range?: string;
  widget?: string;
}

export type PortalSearch = GlobalSearch &
  ExploreSearch &
  IdentitiesSearch &
  MetricsViewSearch &
  DashboardListSearch &
  DashboardSearch;

const PERIODS = new Set<string>(["week", "month", "quarter", "year"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_KEY = /^(none|[a-z][a-z0-9_]*\.[a-z0-9_.]+)$/;
const PERSON_ID = /^[0-9a-z-]+$/;

const MAX_SOURCES = 20;
const MAX_SOURCE_CHARS = 30;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function scalar(v: unknown): string | undefined {
  return typeof v === "number" || typeof v === "boolean" ? String(v) : str(v);
}

function list(v: unknown, part: RegExp): string | undefined {
  const parts = (str(v) ?? "").split(",").filter((value) => part.test(value));
  return parts.length > 0 ? parts.join(",") : undefined;
}

function strs(v: unknown): string[] | undefined {
  const values = (Array.isArray(v) ? v : [v])
    .map(scalar)
    .filter((value) => value !== undefined);

  return values.length > 0 ? values : undefined;
}

// WORKAROUND: the router spreads a validator's result over the raw query, so every validator
// returns each of its keys, `undefined` when dropped.

export function validateGlobalSearch(raw: Record<string, unknown>): GlobalSearch {
  const period = str(raw.period);
  const from = str(raw.from);
  const to = str(raw.to);
  const custom =
    from && to && ISO_DATE.test(from) && ISO_DATE.test(to) && validateDateRange({ from, to }).valid;
  return {
    scope: str(raw.scope)?.toLowerCase(),
    direct: raw.direct === true || raw.direct === "true" || raw.direct === 1 ? true : undefined,
    slice: str(raw.slice),
    period: period && PERIODS.has(period) ? (period as PeriodValue) : undefined,
    from: custom ? from : undefined,
    to: custom ? to : undefined,
  };
}

export const GLOBAL_SEARCH_KEYS = [
  "scope",
  "direct",
  "slice",
  "period",
  "from",
  "to",
] satisfies Array<keyof GlobalSearch>;

export function validateExploreSearch(raw: Record<string, unknown>): ExploreSearch {
  return { repo: str(raw.repo) };
}

export function validateIdentitiesSearch(raw: Record<string, unknown>): IdentitiesSearch {
  return {
    acct: str(raw.acct),
    src: formatSources(
      parseSources(str(raw.src))
        .filter((source) => source.length <= MAX_SOURCE_CHARS)
        .slice(0, MAX_SOURCES),
    ),
    person: str(raw.person)?.toLowerCase(),
    find: str(raw.find),
  };
}

export function validateMetricsViewSearch(raw: Record<string, unknown>): MetricsViewSearch {
  return {
    metrics: list(raw.metrics, METRIC_KEY),
    compare: list(str(raw.compare)?.toLowerCase(), PERSON_ID),
  };
}

export function validateDashboardListSearch(raw: Record<string, unknown>): DashboardListSearch {
  return {
    folder: str(raw.folder),
    tag: strs(raw.tag),
    owned: raw.owned === "me" || raw.owned === "shared" ? raw.owned : undefined,
  };
}

export function validateDashboardSearch(raw: Record<string, unknown>): DashboardSearch {
  return {
    range: isRangeToken(str(raw.range) ?? "") ? str(raw.range) : undefined,
    widget: str(raw.widget),
  };
}

export function usePortalSearch(): PortalSearch {
  return useSearch({ strict: false }) as PortalSearch;
}

export type PortalSearchPatch =
  | Partial<PortalSearch>
  | ((prev: PortalSearch) => Partial<PortalSearch>);

// WORKAROUND: `retainSearchParams` restores any listed key absent from the result, so a cleared
// key is set to `undefined`, never deleted.
export function applySearchPatch(
  prev: Record<string, unknown>,
  patch: Partial<PortalSearch>,
): Record<string, unknown> {
  const next = { ...prev };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value === "" || value === false ? undefined : value;
  }
  return next;
}

export function useSetPortalSearch(): (
  patch: PortalSearchPatch,
  opts?: { replace?: boolean },
) => void {
  const navigate = useNavigate();
  return useCallback(
    (patch, opts) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const resolved = typeof patch === "function" ? patch(prev as PortalSearch) : patch;
          return applySearchPatch(prev, resolved);
        },
        replace: opts?.replace ?? false,
        resetScroll: false,
      });
    },
    [navigate],
  );
}
