import { http, HttpResponse } from "msw";

import type {
  Dataset,
  DatasetRecord,
  Dependents,
  MetricDefinition,
  MetricResult,
  Widget,
} from "@/api/custom-client";

import { DEPLOYS_ROWS } from "./dashboard-handlers";

const UPDATED_AT = "2026-09-01T09:00:00.000Z";

const DEPLOYMENTS: Dataset = {
  name: "deployments",
  declaration: {
    title: "Deployments",
    description: "One record for each deploy of a service.",
    fields: [
      { name: "service", path: "service", type: "string", role: "dimension" },
      {
        name: "environment",
        path: "environment",
        type: "string",
        role: "dimension",
      },
      {
        name: "deployed_at",
        path: "deployed_at",
        type: "datetime",
        role: "time",
        default_clock: true,
      },
      {
        name: "duration_s",
        path: "duration_s",
        type: "int",
        role: "measurable",
        description: "Seconds from the start of the deploy to its end.",
      },
    ],
    row_identity: ["service", "deployed_at"],
  },
};

const SERVICES = ["example-api", "example-web", "example-worker"];

const RECORDS: DatasetRecord[] = Array.from({ length: 8 }, (_, index) => {
  const day = String(24 + index).padStart(2, "0");
  return {
    id: `rec-${index + 1}`,
    received_at: `2026-08-${day}T10:05:00.000Z`,
    raw_data: {
      service: SERVICES[index % SERVICES.length],
      environment: index % 3 === 0 ? "staging" : "production",
      deployed_at: `2026-08-${day}T10:00:00.000Z`,
      duration_s: 120 + ((index * 47) % 300),
    },
  };
});

interface MockMetric {
  name: string;
  body: MetricDefinition;
  result: MetricResult;
  holders: Dependents["holders"];
}

const metrics: Record<string, MockMetric> = {
  deploys: {
    name: "Deploys per week",
    body: {
      dataset: DEPLOYMENTS.name,
      fields: [
        { field: "deployed_at", type: "datetime", as_name: "week" },
        { field: "service", type: "string", agg: "count", as_name: "deploys" },
      ],
      group_by: ["week"],
      order_by: { field: "week" },
    },
    result: DEPLOYS_ROWS,
    holders: [
      { kind: "widgets", id: "deploys-per-week", name: "Deploys per week" },
    ],
  },
  "deploy-duration": {
    name: "Deploy duration by service",
    body: {
      dataset: DEPLOYMENTS.name,
      fields: [
        { field: "service", type: "string", as_name: "service" },
        { field: "duration_s", type: "int", agg: "avg", as_name: "duration" },
      ],
      group_by: ["service"],
    },
    result: {
      columns: ["service", "duration"],
      rows: SERVICES.map((service, index) => [service, 180 + index * 65]),
    },
    holders: [
      {
        kind: "widgets",
        id: "deploy-duration-bars",
        name: "Deploy duration by service",
      },
    ],
  },
};

interface MockWidget {
  name: string;
  body: Widget;
  holders: Dependents["holders"];
}

const widgets: Record<string, MockWidget> = {
  "deploys-per-week": {
    name: "Deploys per week",
    body: { type: "table", metric: "deploys", columns: ["week", "deploys"] },
    holders: [
      { kind: "dashboards", id: "delivery-overview", name: "Delivery overview" },
    ],
  },
  "deploy-duration-bars": {
    name: "Deploy duration by service",
    body: { type: "bar", metric: "deploy-duration", x: "service", y: "duration" },
    holders: [],
  },
};

const notFound = () => new HttpResponse(null, { status: 404 });

function catalogue<T extends { name: string }>(items: T[], url: string) {
  const query = new URL(url).searchParams;
  const needle = (query.get("q") ?? "").toLowerCase();
  const offset = Number(query.get("offset") ?? 0);
  const limit = Number(query.get("limit") ?? 50);
  const matched = items.filter((item) =>
    item.name.toLowerCase().includes(needle)
  );

  return { items: matched.slice(offset, offset + limit), total: matched.length };
}

function fieldOf(record: DatasetRecord, field: string): unknown {
  return field === "received_at"
    ? record.received_at
    : (record.raw_data as Record<string, unknown>)[field];
}

function compare(a: unknown, b: unknown): number {
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b));
}

function recordPage(url: string) {
  const query = new URL(url).searchParams;
  const by = query.get("order_by") ?? "received_at";
  const descending = query.get("direction") === "desc";
  const offset = Number(query.get("offset") ?? 0);
  const limit = Number(query.get("limit") ?? 20);
  const ordered = [...RECORDS].sort((a, b) =>
    compare(fieldOf(a, by), fieldOf(b, by))
  );
  if (descending) ordered.reverse();

  return {
    records: ordered.slice(offset, offset + limit),
    total: RECORDS.length,
    limit,
  };
}

export const catalogueHandlers = [
  http.get("/api/v3/v1/datasets", ({ request }) => {
    const listed = [
      {
        name: DEPLOYMENTS.name,
        title: DEPLOYMENTS.declaration.title,
        fields: DEPLOYMENTS.declaration.fields.length,
        updated_at: UPDATED_AT,
      },
    ];
    const page = catalogue(listed, request.url);

    return HttpResponse.json({
      names: page.items.map((item) => item.name),
      ...page,
    });
  }),
  http.get("/api/v3/v1/datasets/:name", ({ params }) =>
    params.name === DEPLOYMENTS.name
      ? HttpResponse.json(DEPLOYMENTS)
      : notFound()
  ),
  http.get("/api/v3/v1/datasets/:name/records", ({ params, request }) =>
    params.name === DEPLOYMENTS.name
      ? HttpResponse.json(recordPage(request.url))
      : notFound()
  ),
  http.get("/api/v3/v1/datasets/:name/dependents", ({ params }) =>
    params.name === DEPLOYMENTS.name
      ? HttpResponse.json({ metrics: Object.keys(metrics) })
      : notFound()
  ),
  http.get("/api/v3/v1/metrics", ({ request }) => {
    const listed = Object.entries(metrics).map(([id, metric]) => ({
      id,
      name: metric.name,
      updated_at: UPDATED_AT,
      body: metric.body,
    }));

    return HttpResponse.json(catalogue(listed, request.url));
  }),
  http.get("/api/v3/v1/metrics/:id", ({ params }) => {
    const id = String(params.id);
    const metric = metrics[id];
    if (!metric) return notFound();

    return HttpResponse.json({
      id,
      name: metric.name,
      body: metric.body,
      clock: { field: "deployed_at", from: "dataset" },
      updated_at: UPDATED_AT,
    });
  }),
  http.post("/api/v3/v1/metrics/:id/run", ({ params }) => {
    const metric = metrics[String(params.id)];

    return metric ? HttpResponse.json(metric.result) : notFound();
  }),
  http.get("/api/v3/v1/widgets", ({ request }) => {
    const listed = Object.entries(widgets).map(([id, widget]) => ({
      id,
      name: widget.name,
      updated_at: UPDATED_AT,
      body: widget.body,
      metric_name: metrics[widget.body.metric]?.name ?? null,
    }));

    return HttpResponse.json(catalogue(listed, request.url));
  }),
  http.get("/api/v3/v1/widgets/:id", ({ params }) => {
    const id = String(params.id);
    const widget = widgets[id];
    if (!widget) return notFound();

    return HttpResponse.json({
      id,
      name: widget.name,
      body: widget.body,
      updated_at: UPDATED_AT,
    });
  }),
  http.get("/api/v3/v1/:kind/:id/dependents", ({ params }) => {
    const id = String(params.id);
    const stored =
      params.kind === "metrics"
        ? metrics[id]
        : params.kind === "widgets"
          ? widgets[id]
          : undefined;
    if (!stored) return notFound();

    return HttpResponse.json({ holders: stored.holders, hidden: 0 });
  }),
];
