import type {
  MetricDrilldownRequest,
  MetricDrilldownResponse,
  MetricEvidenceColumn,
  MetricEvidenceRow,
  MetricEvidenceSort,
} from "@/api/metric-drilldown-client";

import { metaFor } from "./metric-results-factory";
import { PEOPLE } from "./registry";

const PAGE_ROWS_PER_PERSON = 15;

function hash(input: string): number {
  let h = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    h ^= input.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const REPOSITORIES = [
  "example/platform",
  "example/web",
  "example/ingestion",
  "example/docs",
];

const BRANCHES = ["main", "release/1.4", "develop"];

const SUBJECTS = [
  "Add the parser",
  "Fix logging on retry",
  "Cache the resolved roster",
  "Drop the unused column",
  "Rename the evidence relation",
  "Handle an empty period",
  "",
  "Widen the cursor to the sort key",
];

interface DetailColumn {
  key: string;
  label: string;
  type: MetricEvidenceColumn["type"];
}

const COMMIT_COLUMNS: DetailColumn[] = [
  { key: "ref", label: "Ref", type: "string" },
  { key: "title", label: "Title", type: "string" },
  { key: "repository", label: "Repository", type: "string" },
  { key: "author", label: "Author", type: "string" },
  { key: "lines_added", label: "Lines added", type: "number" },
  { key: "lines_removed", label: "Lines removed", type: "number" },
];

const REQUEST_COLUMNS: DetailColumn[] = [
  { key: "ref", label: "Ref", type: "string" },
  { key: "title", label: "Title", type: "string" },
  { key: "repository", label: "Repository", type: "string" },
  { key: "author", label: "Author", type: "string" },
  { key: "destination_branch", label: "Destination branch", type: "string" },
];

const TASK_COLUMNS: DetailColumn[] = [
  { key: "ref", label: "Ref", type: "string" },
  { key: "title", label: "Title", type: "string" },
  { key: "project", label: "Project", type: "string" },
  { key: "type", label: "Type", type: "string" },
];

function detailColumns(metricKey: string): DetailColumn[] {
  if (metricKey.startsWith("git.pr")) return REQUEST_COLUMNS;
  if (metricKey.startsWith("git.")) return COMMIT_COLUMNS;
  if (metricKey.startsWith("tasks.")) return TASK_COLUMNS;
  return [];
}

function isRatio(metricKey: string): boolean {
  return metaFor(metricKey).computation === "ratio";
}

function showsValue(metricKey: string): boolean {
  const { computation, format } = metaFor(metricKey);
  return (
    ["median", "percentile", "stddev"].includes(computation) ||
    format === "decimal" ||
    format === "currency"
  );
}

function dayIn(period: { from: string; to: string }, offset: number): string {
  const [year, month, day] = period.from.split("-").map(Number);
  const start = Date.UTC(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  const [toYear, toMonth, toDay] = period.to.split("-").map(Number);
  const end = Date.UTC(toYear ?? 2026, (toMonth ?? 1) - 1, toDay ?? 1);
  const span = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  return new Date(start + (offset % span) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const NAME_BY_PERSON = new Map(
  PEOPLE.map((person) => [person.person_id, person.name]),
);

function rosterOf(request: MetricDrilldownRequest): string[] {
  if (request.entity.type === "persons") return request.entity.ids;
  if (request.entity.type === "person") return [request.entity.id];
  return ["tenant"];
}

function servesPerson(request: MetricDrilldownRequest): boolean {
  return request.entity.type === "persons" && !isRatio(request.metric_key);
}

export function drilldownColumns(
  request: MetricDrilldownRequest,
): MetricEvidenceColumn[] {
  const columns: MetricEvidenceColumn[] = [];
  if (servesPerson(request)) {
    columns.push({
      key: "person",
      label: "Who",
      type: "string",
      sortable: false,
    });
  }
  if (isRatio(request.metric_key)) {
    return [
      ...columns,
      { key: "date", label: "Date", type: "date", sortable: true },
      { key: "numerator", label: "Numerator", type: "number", sortable: true },
      {
        key: "denominator",
        label: "Denominator",
        type: "number",
        sortable: true,
      },
    ];
  }

  const details = detailColumns(request.metric_key);
  columns.push(
    ...details.map((column) => ({ ...column, sortable: true })),
    { key: "date", label: "Date", type: "date" as const, sortable: true },
  );
  if (details.length === 0 || showsValue(request.metric_key)) {
    columns.push({
      key: "value",
      label: "Value",
      type: "number",
      sortable: true,
    });
  }
  return columns;
}

function evidenceRows(request: MetricDrilldownRequest): MetricEvidenceRow[] {
  const roster = rosterOf(request);
  const ratio = isRatio(request.metric_key);
  const details = detailColumns(request.metric_key);
  const withPerson = servesPerson(request);

  return roster.flatMap((personId, personIndex) =>
    Array.from({ length: PAGE_ROWS_PER_PERSON }, (_, index) => {
      const seed = hash(`${request.metric_key}|${personId}|${index}`);
      const date = dayIn(request.period, seed % 90);
      const values: Record<string, unknown> = {};
      if (withPerson) {
        values.person = NAME_BY_PERSON.get(personId) ?? null;
      }
      if (ratio) {
        const denominator = (seed % 7) + 1;
        return {
          values: {
            ...values,
            date,
            numerator: seed % 40,
            denominator,
          },
        };
      }

      const ref = String((seed % 30_000) + 1);
      const repository = REPOSITORIES[seed % REPOSITORIES.length]!;
      for (const column of details) {
        switch (column.key) {
          case "ref":
            values.ref = ref;
            break;
          case "title":
            values.title = SUBJECTS[seed % SUBJECTS.length] ?? "";
            break;
          case "repository":
            values.repository = repository;
            break;
          case "author":
            values.author = NAME_BY_PERSON.get(personId) ?? personId;
            break;
          case "project":
            values.project = repository.split("/")[1] ?? repository;
            break;
          case "type":
            values.type = seed % 3 === 0 ? "Bug" : "Task";
            break;
          case "destination_branch":
            values.destination_branch = BRANCHES[seed % BRANCHES.length]!;
            break;
          case "lines_added":
            values.lines_added = seed % 4 === 0 ? null : seed % 320;
            break;
          case "lines_removed":
            values.lines_removed = seed % 4 === 0 ? null : seed % 90;
            break;
          default:
            break;
        }
      }
      values.date = date;
      if (details.length === 0 || showsValue(request.metric_key)) {
        values.value =
          metaFor(request.metric_key).format === "decimal"
            ? ((seed % 120) + 1) / 10
            : (seed % 12) + 1;
      }

      return {
        values,
        links: values.ref
          ? {
              ref: `https://example.com/${repository}/pull/${ref}`,
              title: `https://example.com/${repository}/pull/${ref}`,
              repository: `https://example.com/${repository}`,
            }
          : {},
        __tiebreak: `${personIndex}:${index}`,
      } as MetricEvidenceRow & { __tiebreak: string };
    }),
  );
}

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function naturalKey(text: string): string {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) && trimmed.length < 20
    ? trimmed.padStart(20, "0")
    : trimmed;
}

function orderKey(
  row: MetricEvidenceRow,
  column: MetricEvidenceColumn,
): number | string {
  const text = cellText(row.values[column.key]);
  if (column.type === "number") return Number.parseFloat(text) || 0;
  if (column.type === "date") return text.trim();
  return naturalKey(text);
}

function compare(left: number | string, right: number | string): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function ordered(
  rows: MetricEvidenceRow[],
  columns: MetricEvidenceColumn[],
  sort: MetricEvidenceSort,
): MetricEvidenceRow[] {
  const column = columns.find((candidate) => candidate.key === sort.key);
  if (!column) return rows;
  const factor = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const leftEmpty = cellText(left.values[column.key]).trim() === "";
    const rightEmpty = cellText(right.values[column.key]).trim() === "";
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;

    const byKey = compare(orderKey(left, column), orderKey(right, column));
    if (byKey !== 0) return byKey * factor;

    const tiebreak = compare(
      (left as { __tiebreak?: string }).__tiebreak ?? "",
      (right as { __tiebreak?: string }).__tiebreak ?? "",
    );
    return tiebreak * factor;
  });
}

function narrowed(
  rows: MetricEvidenceRow[],
  columns: MetricEvidenceColumn[],
  search: string | undefined,
): MetricEvidenceRow[] {
  const needle = search?.trim().toLowerCase();
  if (!needle) return rows;
  const searchable = columns.filter((column) => column.key !== "person");
  return rows.filter((row) =>
    searchable.some((column) =>
      cellText(row.values[column.key]).toLowerCase().includes(needle),
    ),
  );
}

const NEWEST_FIRST: MetricEvidenceSort = { key: "date", direction: "desc" };

function fingerprint(request: MetricDrilldownRequest): string {
  return String(
    hash(
      JSON.stringify([
        request.metric_key,
        request.entity,
        request.period,
        request.filters,
        request.display_dimensions,
        request.sort ?? NEWEST_FIRST,
        request.search ?? null,
      ]),
    ),
  );
}

function offsetOf(request: MetricDrilldownRequest): number {
  if (!request.cursor) return 0;
  try {
    const decoded = JSON.parse(atob(request.cursor)) as {
      fp?: string;
      at?: number;
    };
    return decoded.fp === fingerprint(request) ? Number(decoded.at ?? 0) : 0;
  } catch {
    return 0;
  }
}

export function buildMetricDrilldownResponse(
  request: MetricDrilldownRequest,
): MetricDrilldownResponse {
  const columns = drilldownColumns(request);
  const sort =
    request.sort && columns.some((c) => c.key === request.sort?.key && c.sortable)
      ? request.sort
      : NEWEST_FIRST;

  const matching = ordered(
    narrowed(evidenceRows(request), columns, request.search),
    columns,
    sort,
  );

  const limit = Math.max(1, Math.min(request.limit ?? 100, 250));
  const offset = offsetOf(request);
  const page = matching.slice(offset, offset + limit);
  const next = offset + page.length;

  return {
    selection: {
      metric_key: request.metric_key,
      entity: request.entity,
      period: request.period,
      filters: request.filters,
      display_dimensions: request.display_dimensions,
      sort,
      search: request.search?.trim() || null,
    },
    columns,
    rows: page.map(({ values, links }) => ({ values, links })),
    next_cursor:
      next < matching.length
        ? btoa(JSON.stringify({ fp: fingerprint(request), at: next }))
        : null,
  };
}

export function buildMetricDrilldownCsv(
  request: MetricDrilldownRequest,
): string {
  const response = buildMetricDrilldownResponse({ ...request, limit: 250 });
  const cell = (value: unknown) => `"${cellText(value).replaceAll('"', '""')}"`;
  return [
    response.columns.map((column) => cell(column.label)).join(","),
    ...response.rows.map((row) =>
      response.columns.map((column) => cell(row.values[column.key])).join(","),
    ),
  ].join("\r\n");
}
