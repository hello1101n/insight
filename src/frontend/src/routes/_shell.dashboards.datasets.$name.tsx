import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { DeclaredField } from "@/api/custom-client";
import { Held } from "@/components/custom/held-by";
import {
  Button,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@gears-frontx/ui-kit";
import {
  ARRIVED,
  RecordTable,
  type Ordering,
} from "@/components/custom/record-table";
import { refusal } from "@/components/custom/refusal";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import {
  datasetDependentsQuery,
  datasetQuery,
  datasetRecordsQuery,
  metricQuery,
  ASSUMED_FIRST_PAGE_ROWS,
} from "@/queries/custom";
import { TEXT_BODY, TEXT_HEADING, TEXT_LABEL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_shell/dashboards/datasets/$name")({
  component: DatasetPage,
});

function datasetNameFromPath(pathname: string): string {
  const match = pathname.match(/^\/dashboards\/datasets\/([^/]+)/);

  return match ? decodeURIComponent(match[1]) : "";
}

function DatasetPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const name = datasetNameFromPath(pathname);
  const dataset = useQuery(datasetQuery(name));

  if (dataset.isPending)
    return (
      <CenteredSpinner data-testid="page-custom-dataset" className="min-h-40" />
    );

  if (dataset.isError) {
    return (
      <div data-testid="page-custom-dataset" className="flex flex-col gap-2">
        <h1 className={cn(TEXT_HEADING, "font-mono")}>{name}</h1>
        <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
          {refusal(dataset.error, "That dataset is not there.")}
        </p>
        <Link
          to="/dashboards/datasets"
          className={cn(
            TEXT_BODY,
            "underline decoration-dotted underline-offset-4"
          )}
        >
          Back to the catalogue
        </Link>
      </div>
    );
  }

  const { declaration } = dataset.data;

  return (
    <div data-testid="page-custom-dataset" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className={cn(TEXT_HEADING, "font-mono")}>{name}</h1>
          <Link
            to="/dashboards/datasets"
            className={cn(
              TEXT_BODY,
              "self-start underline decoration-dotted underline-offset-4"
            )}
          >
            Back to the catalogue
          </Link>
        </div>
        <span className={cn(TEXT_BODY, "text-muted-foreground")}>
          {declaration.title}
        </span>
      </header>
      {declaration.description ? (
        <p className={TEXT_BODY}>{declaration.description}</p>
      ) : null}

      <Declaration
        fields={declaration.fields}
        identity={declaration.row_identity}
      />
      <Records name={name} fields={declaration.fields} />
      <Dependents name={name} />
    </div>
  );
}

function Declaration({
  fields,
  identity,
}: {
  fields: DeclaredField[];
  identity?: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Declaration</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {fields.map((field) => (
            <li
              key={field.name}
              className="flex flex-wrap items-baseline gap-2"
            >
              <code className={cn(TEXT_BODY, "font-mono")}>{field.name}</code>
              <Badge variant="secondary">{field.type}</Badge>
              {field.role ? (
                <Badge variant="secondary">{field.role}</Badge>
              ) : null}
              {field.default_clock ? (
                <Badge variant="info">main date</Badge>
              ) : null}
              {field.person ? <Badge variant="info">person</Badge> : null}
              {field.description ? (
                <span className={cn(TEXT_BODY, "text-muted-foreground")}>
                  {field.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {identity?.length ? (
          <p className={cn(TEXT_LABEL, "text-muted-foreground")}>
            One record per {identity.join(", ")}.
          </p>
        ) : (
          <p className={cn(TEXT_LABEL, "text-muted-foreground")}>
            Every record stands on its own.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const COLUMNS_AT_FIRST = 10;

function Records({
  name,
  fields,
}: {
  name: string;
  fields: readonly DeclaredField[];
}) {
  const [page, setPage] = useState(0);
  const [ordering, setOrdering] = useState<Ordering>({
    by: ARRIVED,
    descending: true,
  });
  const [shown, setShown] = useLocalStorageState<string[]>({
    key: `insight.custom.dataset.${name}.columns`,
    defaultValue: fields.slice(0, COLUMNS_AT_FIRST).map((field) => field.name),
    parse: storedColumns,
    serialize: (value) => JSON.stringify(value),
  });

  const [servedPageSize, setServedPageSize] = useState(ASSUMED_FIRST_PAGE_ROWS);

  const records = useQuery(
    datasetRecordsQuery(name, {
      offset: page * servedPageSize,
      orderBy: ordering.by,
      descending: ordering.descending,
    })
  );

  const waiting = records.isPlaceholderData;
  const held = records.data?.limit;
  if (held !== undefined && held !== servedPageSize) setServedPageSize(held);

  const order = (next: Ordering) => {
    setOrdering(next);
    setPage(0);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Records</CardTitle>
      </CardHeader>
      <CardContent>
        {records.isPending ? (
          <CenteredSpinner className="min-h-24" />
        ) : records.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
              {refusal(records.error, "Couldn't read the records.")}
            </p>
            {page > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setPage(0)}>
                Back to the first page
              </Button>
            ) : null}
          </div>
        ) : records.data.total === 0 ? (
          <p className={cn(TEXT_BODY, "text-muted-foreground")}>
            Nothing has arrived yet.
          </p>
        ) : (
          <div
            className={cn("flex flex-col gap-3", waiting && "opacity-60")}
            aria-busy={waiting || undefined}
          >
            <RecordTable
              fields={fields}
              records={records.data.records}
              shown={shown}
              ordering={ordering}
              onShow={setShown}
              onOrder={order}
            />
            <Paging
              page={page}
              servedPageSize={servedPageSize}
              held={records.data.records.length}
              total={records.data.total}
              waiting={waiting}
              onPage={setPage}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Paging({
  page,
  servedPageSize,
  held,
  total,
  waiting,
  onPage,
}: {
  page: number;
  servedPageSize: number;
  held: number;
  total: number;
  waiting: boolean;
  onPage: (page: number) => void;
}) {
  const first = page * servedPageSize + 1;
  const last = page * servedPageSize + held;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        aria-live="polite"
        className={cn(TEXT_LABEL, "text-muted-foreground")}
      >
        {waiting
          ? "Reading…"
          : held === 0
            ? `Nothing left past record ${first - 1} of ${total}`
            : `${first}–${last} of ${total} records received`}
      </span>
      <span className="ms-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={waiting || page === 0}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={waiting || held === 0 || last >= total}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </span>
    </div>
  );
}

function storedColumns(raw: string): string[] | undefined {
  const held: unknown = JSON.parse(raw);
  if (!Array.isArray(held)) return undefined;
  if (!held.every((name) => typeof name === "string")) return undefined;

  return held;
}

function Dependents({ name }: { name: string }) {
  const dependents = useQuery(datasetDependentsQuery(name));
  const metrics = useQueries({
    queries: (dependents.data ?? []).map((id) => metricQuery(id)),
  });

  return (
    <Held
      title="Metrics reading it"
      empty="Nothing reads it, so it can be taken away."
      pending={dependents.isPending}
      error={dependents.error}
      holders={dependents.data?.map((id, index) => ({
        kind: "metrics" as const,
        id,
        name: metrics[index]?.data?.name ?? id,
      }))}
    />
  );
}
