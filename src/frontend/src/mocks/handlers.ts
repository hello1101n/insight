import { http, HttpResponse } from "msw";

import type { AppliedSchedule } from "@/api/connector-health-client";
import { CONNECTORS_BASE } from "@/api/connectors-client";
import { FEEDBACK_MESSAGE_MAX } from "@/api/feedback-client";
import type { MetricDrilldownRequest } from "@/api/metric-drilldown-client";
import type { MetricResultsRequest } from "@/api/metric-results-client";
import { isPersonId } from "@/lib/metrics/entity";

import { ADMIN_ASSIGNMENTS } from "./admin-assignments";
import { catalogueHandlers } from "./catalogue-handlers";
import { seedConnectorScheduleScenarios } from "./connector-schedule-scenarios";
import { connectorScheduleMocks } from "./connector-schedules";
import { buildMetricDefinitions } from "./metric-definitions-factory";
import { dashboardHandlers } from "./dashboard-handlers";
import {
  buildMetricDrilldownCsv,
  buildMetricDrilldownResponse,
} from "./metric-drilldown-factory";
import { buildMetricResultsResponse } from "./metric-results-factory";
import { buildIngestionIntensity } from "./ingestion-factory";
import { buildIdentityTree, PEOPLE, PEOPLE_BY_EMAIL } from "./registry";

const defaultPerson = PEOPLE[0];

function peopleItem(person: (typeof PEOPLE)[number]) {
  const [firstName, ...lastName] = person.name.split(" ");
  return {
    person_id: person.person_id,
    display_name: person.name,
    first_name: firstName ?? null,
    last_name: lastName.join(" ") || null,
    username: null,
    email: person.email,
    attributes: {
      department: person.department,
      division: person.department,
      job_title: person.role,
      status: "Active",
    },
    manager_person_id: person.supervisor_person_id,
    manager_name:
      PEOPLE.find((p) => p.person_id === person.supervisor_person_id)?.name ??
      null,
  };
}

const MOCK_PAGE_SIZE = 8;

const DECIDED_MOCK_ACCOUNTS = new Set<string>();

function pageOf<T>(items: T[], params: URLSearchParams, query: string) {
  const limit = Math.min(Number(params.get("limit") ?? 20), MOCK_PAGE_SIZE);
  const cursor = params.get("cursor");
  const decoded = cursor ? JSON.parse(atob(cursor)) : null;
  const offset = decoded?.q === query ? Number(decoded.at) : 0;

  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  const more = next < items.length;

  return {
    items: slice,
    next_cursor: more ? btoa(JSON.stringify({ q: query, at: next })) : null,
  };
}

const MOCK_SESSION = {
  user: defaultPerson?.person_id ?? "00000000-0000-0000-0000-0000000000bb",
  email: defaultPerson?.email ?? "bob.park@example.com",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  roles: ["user"],
  csrf_token: "mock-csrf-token",
};

function mockSessionTiming(): { expires_at: number; refresh_at: number } {
  const now = Math.floor(Date.now() / 1000);
  return { expires_at: now + 600, refresh_at: now + 510 };
}

const HELD_BY = "2517cd48-4961-52b3-a401-b0e5a03858a4";

const AI_BASE = "/api/analytics/v1/ai";

let mockCredential = { configured: true, hint: "wxyz" };
let mockContextSeq = 0;
let mockSystemPrompt: string | null = null;

const DEFAULT_SYSTEM_PROMPT = [
  "You explain one workplace metric to the person it describes.",
  "",
  "Say what the number is, how it moved, and how it sits against the team median. Offer the most likely reading, and name what would confirm or rule it out. Describe the system, never judge the person. If the data is too thin to support a reading, say so and stop.",
  "",
  "Four sentences at most. No headings, no bullet lists.",
].join("\n");

const mockContext = new Map<
  string,
  {
    id: string;
    scope: "tenant" | "person";
    title: string;
    body: string;
    updated_at: string;
  }
>([
  [
    "ctx-org-1",
    {
      id: "ctx-org-1",
      scope: "tenant",
      title: "How Example Corp reads these metrics",
      body: "Numbers describe systems, not people. Never rank a person against a peer; explain what a movement could mean and what would confirm it.",
      updated_at: "2026-08-12T09:00:00Z",
    },
  ],
  [
    "ctx-me-1",
    {
      id: "ctx-me-1",
      scope: "person",
      title: "How my week is shaped",
      body: "Tuesdays and Thursdays are meeting-heavy by design, so time outside meetings dips there and it is not a problem to flag.",
      updated_at: "2026-08-14T09:00:00Z",
    },
  ],
]);

export const handlers = [
  ...dashboardHandlers,
  ...catalogueHandlers,
  http.get("/auth/me", () =>
    HttpResponse.json({ ...MOCK_SESSION, ...mockSessionTiming() })
  ),
  http.post("/auth/refresh", () => HttpResponse.json(mockSessionTiming())),
  http.post("/auth/logout", () => HttpResponse.json({ rp_logout_url: null })),
  http.post("/api/analytics/v1/metric-results", async ({ request }) => {
    const body = (await request
      .json()
      .catch(() => null)) as MetricResultsRequest | null;
    if (!body || !body.entity || !Array.isArray(body.metrics)) {
      return HttpResponse.json({ error: "invalid_argument" }, { status: 400 });
    }

    const entityType: unknown = (body.entity as { type?: unknown }).type;
    if (entityType !== "person" && entityType !== "tenant") {
      return HttpResponse.json(
        { error: "invalid_argument", field: "entity.type" },
        { status: 400 }
      );
    }

    if (
      body.entity.type === "person" &&
      (!Array.isArray(body.entity.ids) ||
        !body.entity.ids.every(
          (id) => typeof id === "string" && isPersonId(id)
        ))
    ) {
      return HttpResponse.json(
        { error: "invalid_argument", field: "entity.ids" },
        { status: 400 }
      );
    }
    if (
      body.entity.type === "tenant" &&
      body.metrics.some((metric) =>
        metric.views.some((view) => view.view === "peer")
      )
    ) {
      return HttpResponse.json(
        { error: "invalid_argument", field: "metrics.views" },
        { status: 400 }
      );
    }
    return HttpResponse.json(buildMetricResultsResponse(body));
  }),
  http.post("/api/analytics/v1/metric-drilldown", async ({ request }) => {
    const body = (await request
      .json()
      .catch(() => null)) as MetricDrilldownRequest | null;
    if (!body?.metric_key || !body.entity || !body.period) {
      return HttpResponse.json({ error: "invalid_argument" }, { status: 400 });
    }
    return HttpResponse.json(buildMetricDrilldownResponse(body));
  }),
  http.post(
    "/api/analytics/v1/metric-drilldown/export",
    async ({ request }) => {
      const body = (await request
        .json()
        .catch(() => null)) as MetricDrilldownRequest | null;
      if (!body?.metric_key || !body.entity || !body.period) {
        return HttpResponse.json(
          { error: "invalid_argument" },
          { status: 400 }
        );
      }
      return new HttpResponse(buildMetricDrilldownCsv(body), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${body.metric_key}.csv"`,
        },
      });
    }
  ),
  http.get("/api/identity/v1/me", () =>
    HttpResponse.json({
      person_id:
        defaultPerson?.person_id ?? "00000000-0000-0000-0000-0000000000bb",
      insight_tenant_id: "00000000-0000-4000-8000-00000000c0de",
      roles: [
        {
          role_id: "a4d11000-0000-4000-8000-000000000001",
          name: "admin",
        },
      ],
      visibility_policy: "org_chart",
    })
  ),
  http.get("/api/analytics/v1/metric-definitions", () =>
    HttpResponse.json({ metrics: buildMetricDefinitions() })
  ),
  http.get(
    "/api/identity/v1/resolution/accounts/:source/:sourceId/:accountId",
    ({ params }) => {
      if (params.accountId === "874") {
        const minted = {
          person_id: "01900000-0000-7000-8000-0000000000d0",
          display_name: "Ravi Menon",
          job_title: "Facilities Lead",
        };
        return HttpResponse.json({
          source: params.source,
          source_id: params.sourceId,
          account_id: params.accountId,
          person_id: minted.person_id,
          history: [
            {
              person_id: minted.person_id,
              person: minted,
              author_person_id: "00000000-0000-0000-0000-000000000000",
              by_operator: false,
              reason: "roster-mint",
              recorded_at: "2026-08-14T06:30:00.000000",
            },
          ],
          operations: [],
        });
      }
      if (params.accountId === "gh-main" || params.accountId === "gl-alt") {
        return HttpResponse.json({
          source: params.source,
          source_id: params.sourceId,
          account_id: params.accountId,
          person_id: HELD_BY,
          history: [
            {
              person_id: HELD_BY,
              author_person_id: "00000000-0000-0000-0000-000000000000",
              by_operator: params.accountId === "gl-alt",
              reason: "seed",
              recorded_at: "2026-08-14T06:30:00.000000",
            },
          ],
          operations: [],
        });
      }
      if (params.accountId !== "dev-42") {
        return HttpResponse.json({
          source: params.source,
          source_id: params.sourceId,
          account_id: params.accountId,
          person_id: null,
          history: [],
        });
      }
      const [bob, carol] = PEOPLE;
      return HttpResponse.json({
        source: params.source,
        source_id: params.sourceId,
        account_id: params.accountId,
        person_id: bob?.person_id,
        history: [
          {
            person_id: bob?.person_id,
            person: bob
              ? {
                  person_id: bob.person_id,
                  email: bob.email,
                  display_name: bob.name,
                  job_title: bob.role,
                }
              : null,
            author_person_id: carol?.person_id,
            author: carol
              ? {
                  person_id: carol.person_id,
                  email: carol.email,
                  display_name: carol.name,
                  job_title: carol.role,
                }
              : null,
            by_operator: true,
            reason: "operator-bind",
            recorded_at: "2026-08-01T10:15:00.000000",
          },
          {
            person_id: carol?.person_id,
            author_person_id: "00000000-0000-0000-0000-000000000000",
            by_operator: false,
            reason: "",
            recorded_at: "2026-07-15T08:00:00.000000",
          },
          {
            person_id: carol?.person_id,
            author_person_id: "00000000-0000-0000-0000-000000000000",
            by_operator: false,
            reason: "login-bootstrap",
            recorded_at: "2026-07-01T06:30:00.000000",
          },
        ],
        operations: [
          {
            operation_id: "01900000-0000-7000-8000-0000000000f1",
            verb: "operator-bind",
            author_person_id: carol?.person_id,
            author: carol
              ? {
                  person_id: carol.person_id,
                  email: carol.email,
                  display_name: carol.name,
                  job_title: carol.role,
                }
              : null,
            comment:
              "Checked with HR — same person, the chat handle is theirs.",
            accounts_touched: 3,
            outcome: "applied",
            recorded_at: "2026-08-01T10:15:00.000000",
          },
        ],
      });
    }
  ),
  http.get("/api/identity/v1/persons", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim() ?? "";
    const terms = q ? q.toLowerCase().split(/\s+/) : [];
    const items = PEOPLE.filter((p) =>
      terms.every((term) =>
        isPersonId(term)
          ? p.person_id.toLowerCase() === term
          : [p.name, p.email, p.role].some((v) =>
              v.toLowerCase().includes(term)
            )
      )
    )
      .map((p) => ({
        person_id: p.person_id,
        email: p.email,
        username: null,
        display_name: p.name,
        job_title: p.role,
        status: "active",
      }))
      .sort((left, right) =>
        (left.display_name ?? "").localeCompare(right.display_name ?? "")
      );
    return HttpResponse.json(pageOf(items, params, q));
  }),
  http.get("/api/identity/v1/visible-persons", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim().toLowerCase() ?? "";
    const items = PEOPLE.filter(
      (p) =>
        !q || [p.name, p.email, p.role].some((v) => v.toLowerCase().includes(q))
    )
      .map((p) => ({
        person_id: p.person_id,
        email: p.email,
        username: null,
        display_name: p.name,
        job_title: p.role,
        status: "active",
      }))
      .sort((left, right) =>
        (left.display_name ?? "").localeCompare(right.display_name ?? "")
      );
    return HttpResponse.json(pageOf(items, params, q));
  }),
  http.get("/api/identity/v1/people", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim().toLowerCase() ?? "";
    const terms = q ? q.split(/\s+/) : [];
    const items = PEOPLE.filter((person) =>
      terms.every((term) =>
        [person.name, person.email, person.role, person.department].some(
          (value) => value.toLowerCase().includes(term)
        )
      )
    )
      .map(peopleItem)
      .sort((left, right) =>
        left.display_name.localeCompare(right.display_name)
      );
    return HttpResponse.json(pageOf(items, params, q));
  }),
  http.get("/api/identity/v1/people/:personId", ({ params }) => {
    const personId = String(params.personId).toLowerCase();
    const person = PEOPLE.find(
      (candidate) => candidate.person_id.toLowerCase() === personId
    );
    return person
      ? HttpResponse.json(peopleItem(person))
      : HttpResponse.json(
          { type: "urn:insight:error:person_not_found" },
          { status: 404 }
        );
  }),
  http.get("/api/identity/v1/person-roles", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const personId = params.get("person");
    if (personId === null) {
      const role = params.get("role");
      return HttpResponse.json({
        items: [...ADMIN_ASSIGNMENTS.values()].filter(
          (assignment) => role === null || assignment.role_id === role
        ),
        next_cursor: null,
      });
    }
    const assignment = ADMIN_ASSIGNMENTS.get(personId.toLowerCase());
    return HttpResponse.json({
      items: assignment ? [assignment] : [],
      next_cursor: null,
    });
  }),
  http.post("/api/identity/v1/person-roles", async ({ request }) => {
    const body = (await request.json()) as {
      person_id: string;
      role_id: string;
    };
    const assignment = {
      person_role_id: crypto.randomUUID(),
      insight_tenant_id: "00000000-0000-4000-8000-00000000c0de",
      person_id: body.person_id,
      role_id: body.role_id,
      valid_from: new Date().toISOString(),
      valid_to: null,
      author_person_id: "00000000-0000-0000-0000-0000000000bb",
      reason: null,
      created_at: new Date().toISOString(),
    };
    ADMIN_ASSIGNMENTS.set(body.person_id.toLowerCase(), assignment);
    return HttpResponse.json(assignment, { status: 201 });
  }),
  http.delete("/api/identity/v1/person-roles/:personRoleId", ({ params }) => {
    const id = String(params.personRoleId);
    for (const [person, assignment] of ADMIN_ASSIGNMENTS) {
      if (assignment.person_role_id !== id) continue;
      if (ADMIN_ASSIGNMENTS.size === 1) {
        return HttpResponse.json(
          { context: { reason: "last_admin_protected" } },
          { status: 409 }
        );
      }
      ADMIN_ASSIGNMENTS.delete(person);
      return new HttpResponse(null, { status: 204 });
    }
    return HttpResponse.json(
      { type: "urn:insight:error:person_role_not_found" },
      { status: 404 }
    );
  }),
  http.get("/api/identity/v1/resolution/accounts", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim() ?? "";
    const needle = q.toLowerCase();
    const picked = (params.get("source") ?? "").split(",").filter(Boolean);
    const card = (p: (typeof PEOPLE)[number]) => ({
      person_id: p.person_id,
      email: p.email,
      display_name: p.name,
      job_title: p.role,
    });
    const bound = PEOPLE.map((p, index) => ({
      source: index % 2 === 0 ? "github" : "gitlab",
      source_id: "01900000-0000-7000-8000-00000000aa01",
      account_id: `acct-${index + 1}`,
      email: p.email,
      username: null,
      display_name: p.name,
      person: card(p),
      bound_by_operator: index % 3 === 0,
    }));
    const [, , alice, david] = PEOPLE;
    const unbound = [
      {
        source: "gitlab-commit-email",
        source_id: "01900000-0000-7000-8000-00000000aa04",
        account_id: "david.liu@example.com",
        email: "david.liu@example.com",
        username: null,
        display_name: null,
        person: null,
        address_holder: david ? card(david) : null,
        bound_by_operator: false,
      },
      {
        source: "gitlab",
        source_id: "01900000-0000-7000-8000-00000000aa02",
        account_id: "a.kim",
        email: alice?.email ?? "alice.kim@example.com",
        username: null,
        display_name: null,
        person: null,
        address_holder: alice ? card(alice) : null,
        bound_by_operator: false,
      },
      {
        source: "github",
        source_id: "01900000-0000-7000-8000-00000000aa01",
        account_id: "dev-42",
        email: "dev42@example.com",
        username: "dev42",
        display_name: null,
        person: null,
        bound_by_operator: false,
      },
      {
        source: "github",
        source_id: "01900000-0000-7000-8000-00000000aa01",
        account_id: "ci-runner-3",
        email: null,
        username: "ci-runner-3",
        display_name: null,
        person: null,
        excluded: true,
        bound_by_operator: true,
      },
    ];
    const items = [...bound, ...unbound]
      .filter(
        (item) =>
          !needle ||
          [item.display_name, item.email, item.account_id].some((v) =>
            v?.toLowerCase().includes(needle)
          )
      )
      .filter((item) => picked.length === 0 || picked.includes(item.source));
    items.sort((left, right) =>
      (left.email ?? left.account_id).localeCompare(
        right.email ?? right.account_id
      )
    );
    return HttpResponse.json(pageOf(items, params, q));
  }),
  http.get("/api/identity/v1/resolution/sources", () =>
    HttpResponse.json({
      items: ["github", "gitlab", "gitlab-commit-email", "hr"],
    })
  ),
  http.get(
    "/api/identity/v1/resolution/persons/:personId/accounts",
    ({ params }) =>
      HttpResponse.json({
        person_id: params.personId,
        accounts: [
          {
            source: "github",
            source_id: "01900000-0000-7000-8000-00000000aa01",
            account_id: "gh-main",
            email: "main@example.com",
            username: "gh-main",
            bound_by_operator: false,
          },
          {
            source: "gitlab",
            source_id: "01900000-0000-7000-8000-00000000aa02",
            account_id: "gl-alt",
            email: null,
            username: "gl-alt",
            bound_by_operator: true,
          },
        ],
      })
  ),
  ...["bind", "merge", "detach", "exclude"].map((verb) =>
    http.post(`/api/identity/v1/resolution/${verb}`, async ({ request }) => {
      type WireAccount = { source: string; source_id: string; id: string };
      const body = (await request.json().catch(() => null)) as {
        account?: WireAccount;
        bindings?: Array<{ account: WireAccount }>;
      } | null;
      const decided: WireAccount[] =
        verb === "bind"
          ? (body?.bindings ?? []).map((binding) => binding.account)
          : verb === "merge" || !body?.account
            ? []
            : [body.account];
      for (const account of decided) {
        DECIDED_MOCK_ACCOUNTS.add(
          `${account.source}|${account.source_id}|${account.id}`
        );
      }
      const named =
        verb === "merge"
          ? [
              {
                source: "github",
                source_id: "01900000-0000-7000-8000-00000000aa01",
                id: "dev-42",
              },
            ]
          : decided;
      return HttpResponse.json({
        applied: named.length,
        already_decided: 0,
        items: named.map((account) => ({
          source: account.source,
          source_id: account.source_id,
          account_id: account.id,
          outcome: "applied",
        })),
        ...(verb === "detach"
          ? { new_person_id: "01900000-0000-7000-8000-00000000dead" }
          : {}),
      });
    })
  ),
  http.get("/api/identity/v1/resolution/attention", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const picked = (params.get("source") ?? "").split(",").filter(Boolean);
    const kinds = (params.get("kind") ?? "").split(",").filter(Boolean);
    const [bob, carol, alice] = PEOPLE;
    const card = (p: (typeof PEOPLE)[number], extra?: object) => ({
      person_id: p.person_id,
      email: p.email,
      username: null,
      display_name: p.name,
      job_title: p.role ?? null,
      status: "active",
      ...extra,
    });
    const queue = [
      {
        kind: "contested",
        source: "github",
        source_id: "01900000-0000-7000-8000-00000000aa01",
        account_id: "dev-42",
        email: "dev42@example.com",
        username: "dev42",
        bound_to: null,
        candidates: [card(bob), card(carol)],
      },
      {
        kind: "binding_conflict",
        source: "gitlab",
        source_id: "01900000-0000-7000-8000-00000000aa02",
        account_id: "a.kim",
        email: alice?.email ?? "alice.kim@example.com",
        username: null,
        bound_to: alice?.person_id,
        candidates: [card(alice)],
      },
      {
        kind: "no_evidence",
        source: "github",
        source_id: "01900000-0000-7000-8000-00000000aa01",
        account_id: "ci-bot-7",
        email: null,
        username: "ci-bot-7",
        candidates: [],
      },
      {
        kind: "provisioned_at_login",
        source: "github",
        source_id: "01900000-0000-7000-8000-00000000aa01",
        account_id: "new-joiner",
        email: null,
        username: "new-joiner",
        bound_to: carol?.person_id,
        candidates: [card(carol, { provisional: true })],
      },
      {
        kind: "minted_from_roster",
        source: "hr",
        source_id: "01900000-0000-7000-8000-00000000aa03",
        account_id: "874",
        email: null,
        username: null,
        display_name: "Ravi Menon",
        job_title: "Facilities Lead",
        department: "Operations",
        status: "Active",
        manager_email: "carol.chen@example.com",
        bound_to: "01900000-0000-7000-8000-0000000000d0",
        candidates: [
          {
            person_id: "01900000-0000-7000-8000-0000000000d0",
            email: null,
            username: null,
            display_name: "Ravi Menon",
            job_title: "Facilities Lead",
            status: "active",
            provisional: true,
          },
        ],
      },
      {
        kind: "no_evidence",
        source: "hr",
        source_id: "01900000-0000-7000-8000-00000000aa03",
        account_id: "921",
        email: null,
        username: null,
        display_name: "Nadia Orlov",
        job_title: "Office Manager",
        department: "Operations",
        status: "Inactive",
        manager_email: "carol.chen@example.com",
        candidates: [],
      },
      {
        kind: "no_source_id",
        source: "gitlab",
        source_id: "01900000-0000-7000-8000-00000000aa02",
        account_id: "pm.lee",
        email: "pm.lee@example.com",
        username: null,
        candidates: [],
      },
      {
        kind: "contested",
        source: "gitlab",
        source_id: "01900000-0000-7000-8000-00000000aa02",
        account_id: "shared-ci",
        email: "shared.ci@example.com",
        username: "shared-ci",
        bound_to: null,
        candidates: [card(alice), card(carol)],
      },
      {
        kind: "no_evidence",
        source: "gitlab",
        source_id: "01900000-0000-7000-8000-00000000aa02",
        account_id: "build-agent",
        email: null,
        username: "build-agent",
        candidates: [],
      },
    ]
      .filter((item) => picked.length === 0 || picked.includes(item.source))
      .filter((item) => kinds.length === 0 || kinds.includes(item.kind))
      .filter(
        (item) =>
          !DECIDED_MOCK_ACCOUNTS.has(
            `${item.source}|${item.source_id}|${item.account_id}`
          )
      );
    return HttpResponse.json({
      items: queue,
      rates: {
        observed: 60,
        bound: 55,
        pending: 3,
        no_source_id: 0,
        no_evidence: 2,
        excluded: 1,
      },
      truncated: false,
      items_truncated: false,
    });
  }),
  http.post("/api/identity/v1/profiles", async ({ request }) => {
    const body = (await request.json().catch(() => null)) as {
      value_type?: string;
      value?: string;
    } | null;
    const value = (body?.value ?? "").trim();
    if (body?.value_type !== "email" && body?.value_type !== "person_id") {
      return HttpResponse.json(
        { type: "urn:insight:error:invalid_argument" },
        { status: 400 }
      );
    }
    if (body.value_type === "person_id" && !isPersonId(value)) {
      return HttpResponse.json(
        { type: "urn:insight:error:invalid_argument" },
        { status: 400 }
      );
    }
    const personId =
      body.value_type === "email"
        ? PEOPLE_BY_EMAIL[value.toLowerCase()]?.person_id
        : value.toLowerCase();
    if (!personId) {
      return HttpResponse.json(
        { type: "urn:insight:error:person_not_found" },
        { status: 404 }
      );
    }
    const tree = buildIdentityTree(personId);
    if (!tree) {
      return HttpResponse.json(
        { type: "urn:insight:error:person_not_found" },
        { status: 404 }
      );
    }
    return HttpResponse.json(tree);
  }),
  ...connectorHealthHandlers(),
  ...usageHandlers(),
  ...ingestionHandlers(),
  ...feedbackHandlers(),
  ...aiAssistHandlers(),
];

const INGESTION_GRAINS = new Set(["15m", "1s"]);
const INGESTION_SERIES = new Set(["connector", "stream", "total"]);
const BRONZE_SLUG = /^bronze_[a-z0-9_]{1,120}$/;

function ingestionHandlers() {
  return [
    http.get(`${CONNECTORS_BASE}/ingestion/intensity`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const grain = params.get("grain") ?? "15m";
      const series = params.get("series");
      const scope = params.get("scope");

      const bad =
        !INGESTION_GRAINS.has(grain) ||
        (series !== null && !INGESTION_SERIES.has(series)) ||
        (scope !== null && scope !== "" && !BRONZE_SLUG.test(scope));
      if (bad) {
        return HttpResponse.json(
          {
            status: 400,
            title: "Bad Request",
            detail: "unsupported ingestion parameter",
          },
          { status: 400 }
        );
      }

      return HttpResponse.json(
        buildIngestionIntensity({
          grain: grain as "15m" | "1s",
          series: (series ?? undefined) as never,
          scope,
          from: params.get("from"),
          to: params.get("to"),
        })
      );
    }),
  ];
}

interface MockFeedback {
  feedback_id: string;
  ts: string;
  person_id: string;
  display_name: string;
  username: string;
  message: string;
  path: string;
}

const MOCK_FEEDBACK_LIMIT = 200;

function mockSender(person: (typeof PEOPLE)[number] | undefined) {
  return {
    person_id: person?.person_id ?? "",
    display_name: person?.name ?? "",
    username: person?.email.split("@")[0] ?? "",
  };
}

const feedbackStore: MockFeedback[] = [
  {
    feedback_id: "22222222-2222-2222-2222-222222222222",
    ts: "2026-08-20 09:14:00",
    ...mockSender(PEOPLE[1]),
    message: "The cohort control does not say what it compares against.",
    path: "/portal/overview",
  },
  {
    feedback_id: "33333333-3333-3333-3333-333333333333",
    ts: "2026-08-19 16:02:00",
    ...mockSender(PEOPLE[2]),
    message: "Let me export the people table to a spreadsheet.",
    path: "/portal/people",
  },
];

function feedbackHandlers() {
  return [
    http.post("/api/analytics/v1/feedback", async ({ request }) => {
      const body = (await request.json().catch(() => null)) as {
        message?: string;
        path?: string;
      } | null;
      const message = body?.message?.trim();
      if (!message || [...message].length > FEEDBACK_MESSAGE_MAX) {
        return HttpResponse.json(
          { error: "invalid_argument" },
          { status: 400 }
        );
      }
      feedbackStore.unshift({
        feedback_id: `mock-${feedbackStore.length + 1}`,
        ts: new Date().toISOString().replace("T", " ").slice(0, 19),
        ...mockSender(defaultPerson),
        message,
        path: body?.path ?? "",
      });
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("/api/analytics/v1/feedback", ({ request }) => {
      const params = new URL(request.url).searchParams;
      const since = params.get("since") ?? "";
      const until = params.get("until") ?? "";
      const items = feedbackStore
        .filter((row) => {
          const day = row.ts.slice(0, 10);
          return (!since || day >= since) && (!until || day <= until);
        })
        .sort((a, b) =>
          params.get("direction") === "asc"
            ? a.ts.localeCompare(b.ts)
            : b.ts.localeCompare(a.ts)
        )
        .slice(0, MOCK_FEEDBACK_LIMIT);

      return HttpResponse.json({ since, until, items });
    }),
  ];
}

function syntheticDays(count: number) {
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - i);
    days.push({
      day: day.toISOString().slice(0, 10),
      visits: 2 + ((i * 7) % 9),
      visitors: 1 + ((i * 3) % 5),
    });
  }
  return days;
}

function connectorHealthHandlers() {
  const anchor = new Date();
  const scenarios =
    import.meta.env.VITE_CONNECTOR_SCHEDULE_SCENARIOS === "true"
      ? seedConnectorScheduleScenarios(anchor)
      : null;
  const minutesAgo = (minutes: number) =>
    new Date(anchor.getTime() - minutes * 60_000).toISOString();

  const sync = (
    job_id: string,
    status: string,
    startedMinutesAgo: number | null,
    duration_ms: number | null,
    records_reported: number | null
  ) => ({
    job_id,
    status,
    started_at:
      startedMinutesAgo === null ? null : minutesAgo(startedMinutesAgo),
    duration_ms,
    records_reported,
  });

  const histories: Record<string, ReturnType<typeof sync>[]> = {
    "example-tracker": [
      sync("8414", "failed", 18, 142_000, 0),
      sync("8409", "succeeded", 78, 138_500, 12_400),
    ],
    "example-directory": [sync("8415", "pending", null, null, null)],
    "example-messaging": [
      sync("8402", "succeeded", 24, 41_000, 903),
      sync("8388", "succeeded", 84, 39_100, 874),
    ],
    "example-inbox": [
      sync("8420", "running", 37, null, null),
      sync("8391", "succeeded", 97, 61_000, 2_140),
    ],
    "example-warehouse": [],
    "example-retired": [sync("7801", "succeeded", 60 * 26, 90_000, 55)],
  };

  const summaryRow = (
    connector: string,
    configured: boolean,
    schedule: AppliedSchedule | null,
    sourceId = `${connector}-main`,
    scenario = false
  ) => ({
    connector,
    tenant_id: "00000000-0000-4000-8000-000000000001",
    source_id: sourceId,
    configured,
    ...connectorScheduleMocks.summary(connector, sourceId, schedule, scenario),
    last_sync: histories[connector]?.[0] ?? null,
  });

  return [
    ...(scenarios?.handlers ?? []),
    ...connectorScheduleMocks.handlers,
    http.get(`${CONNECTORS_BASE}/connector-health`, () => {
      const now = new Date();
      return HttpResponse.json({
        as_of: now.toISOString(),
        checked_at: new Date(now.getTime() - 6 * 60_000).toISOString(),
        typical_read_interval_ms: 15 * 60_000,
        history_available: true,
        connectors: [
          ...(scenarios?.rows.map(({ connector, sourceId }) =>
            summaryRow(
              connector,
              true,
              connectorScheduleMocks.read(connector, sourceId).live ?? null,
              sourceId,
              true
            )
          ) ?? []),
          summaryRow("example-tracker", true, {
            suspended: false,
            crons: ["0 22 * * *", "0 10 * * *"],
            timezone: "Europe/Sofia",
            origin: "api",
          }),
          summaryRow("example-directory", true, {
            suspended: false,
            crons: ["0 * * * *"],
            timezone: null,
            origin: "descriptor",
          }),
          summaryRow("example-messaging", true, {
            suspended: false,
            crons: ["0 0 * * *"],
            timezone: "UTC",
            origin: "default",
          }),
          summaryRow("example-inbox", true, {
            suspended: true,
            crons: ["*/30 * * * *"],
            timezone: "Europe/Sofia",
            origin: null,
          }),
          summaryRow("example-warehouse", true, null),
          summaryRow("example-retired", false, null),
        ],
      });
    }),
    http.get(`${CONNECTORS_BASE}/connector-health/:connector/syncs`, ({ params }) => {
      const connector = String(params.connector);
      return HttpResponse.json({
        connector,
        window: 50,
        syncs: histories[connector] ?? [],
      });
    }),
  ];
}

function usageHandlers() {
  return [
    http.get("/api/analytics/v1/usage/config", () =>
      HttpResponse.json({ enabled: true })
    ),
    http.post(
      "/api/analytics/v1/usage/events",
      () => new HttpResponse(null, { status: 204 })
    ),
    http.get("/api/analytics/v1/usage/summary", () => {
      const by_day = syntheticDays(30);
      return HttpResponse.json({
        since: by_day[0]?.day ?? "",
        until: by_day.at(-1)?.day ?? "",
        totals: {
          visits: by_day.reduce((sum, d) => sum + d.visits, 0),
          visitors: 4,
          page_views: 214,
        },
        by_day,
      });
    }),
    http.get("/api/analytics/v1/usage/people", ({ request }) => {
      const by_day = syntheticDays(30);
      const needle = (new URL(request.url).searchParams.get("search") ?? "").toLowerCase();
      const visitors = mockVisitors(by_day).filter(
        (visitor) =>
          visitor.display_name.toLowerCase().includes(needle) ||
          visitor.username.toLowerCase().includes(needle)
      );
      return usageList(request, "visits", visitors);
    }),
    http.get("/api/analytics/v1/usage/pages", ({ request }) =>
      usageList(request, "views", PAGE_ROWS)
    ),
    http.get("/api/analytics/v1/usage/actions", ({ request }) =>
      usageList(request, "opens", ACTION_ROWS)
    ),
  ];
}

function usageList<T extends Record<string, string | number>>(
  request: Request,
  defaultSort: string,
  rows: T[]
) {
  const params = new URL(request.url).searchParams;
  const key = params.get("sort") ?? defaultSort;
  const flip = params.get("direction") === "asc" ? 1 : -1;
  const items = [...rows].sort((a, b) => {
    const left = a[key] ?? 0;
    const right = b[key] ?? 0;
    if (left === right) return 0;
    return left < right ? -flip : flip;
  });

  return HttpResponse.json({
    since: params.get("since") ?? "",
    until: params.get("until") ?? "",
    items,
  });
}

const mockVisitors = (by_day: Array<{ day: string }>) => [
  {
    person_id: defaultPerson?.person_id ?? "",
    display_name: defaultPerson?.name ?? "",
    username: defaultPerson?.email.split("@")[0] ?? "",
    visits: 31,
    page_views: 96,
    last_seen: `${by_day.at(-1)?.day ?? ""} 09:12`,
  },
  {
    person_id: PEOPLE[1]?.person_id ?? "",
    display_name: PEOPLE[1]?.name ?? "",
    username: PEOPLE[1]?.email.split("@")[0] ?? "",
    visits: 18,
    page_views: 64,
    last_seen: `${by_day.at(-1)?.day ?? ""} 08:40`,
  },
  {
    person_id: PEOPLE[2]?.person_id ?? "",
    display_name: PEOPLE[2]?.name ?? "",
    username: PEOPLE[2]?.email.split("@")[0] ?? "",
    visits: 7,
    page_views: 54,
    last_seen: `${by_day.at(-2)?.day ?? ""} 17:05`,
  },
];

const ACTION_ROWS = [
  {
    event_name: "drill",
    target: "pr_cycle_time",
    opens: 34,
    people: 3,
  },
  { event_name: "drill", target: "review_load", opens: 21, people: 3 },
  { event_name: "drill", target: "ai_share", opens: 12, people: 2 },
  { event_name: "session_start", target: "", opens: 57, people: 4 },
];

const PAGE_ROWS = [
  { path: "/portal/overview", views: 88, visitors: 4 },
  { path: "/portal/people", views: 61, visitors: 3 },
  { path: "/portal/manage/connector-health", views: 42, visitors: 2 },
  { path: "/portal/manage/platform-usage", views: 23, visitors: 1 },
  { path: "/dashboards/:id", views: 31, visitors: 3 },
  { path: "/dashboards/q3-hiring-plan", views: 17, visitors: 2 },
  { path: "/dashboards/release-health", views: 12, visitors: 2 },
  { path: "/dashboards/metrics", views: 9, visitors: 2 },
  { path: "/dashboards/metrics/deploy-frequency", views: 6, visitors: 1 },
  { path: "/dashboards/edit/dashboards/release-health", views: 4, visitors: 1 },
  { path: "/dashboards/edit/metrics/deploy-frequency", views: 3, visitors: 1 },
];

function aiAssistHandlers() {
  return [
    http.get(`${AI_BASE}/config`, () =>
      HttpResponse.json({ enabled: true, model: "claude-sonnet-5" })
    ),
    http.get(`${AI_BASE}/credentials`, () => HttpResponse.json(mockCredential)),
    http.put(`${AI_BASE}/credentials`, async ({ request }) => {
      const body = (await request.json()) as { token?: string };
      const token = body.token ?? "";
      mockCredential = { configured: true, hint: token.slice(-4) };
      return HttpResponse.json(mockCredential);
    }),
    http.delete(`${AI_BASE}/credentials`, () => {
      mockCredential = { configured: false, hint: "" };
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${AI_BASE}/settings`, () =>
      HttpResponse.json({
        system_prompt: mockSystemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        is_default: mockSystemPrompt === null,
      })
    ),
    http.put(`${AI_BASE}/settings`, async ({ request }) => {
      const body = (await request.json()) as { system_prompt?: string };
      mockSystemPrompt = body.system_prompt ?? "";
      return HttpResponse.json({
        system_prompt: mockSystemPrompt,
        is_default: false,
      });
    }),
    http.delete(`${AI_BASE}/settings`, () => {
      mockSystemPrompt = null;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${AI_BASE}/context`, () =>
      HttpResponse.json({ items: [...mockContext.values()] })
    ),
    http.post(`${AI_BASE}/context`, async ({ request }) => {
      const body = (await request.json()) as {
        scope: "tenant" | "person";
        title: string;
        body: string;
      };
      mockContextSeq += 1;
      const entry = {
        id: `ctx-${mockContextSeq}`,
        scope: body.scope,
        title: body.title,
        body: body.body,
        updated_at: new Date().toISOString(),
      };
      mockContext.set(entry.id, entry);
      return HttpResponse.json(entry, { status: 201 });
    }),
    http.patch(`${AI_BASE}/context/:id`, async ({ params, request }) => {
      const id = String(params.id);
      const existing = mockContext.get(id);
      if (!existing) return new HttpResponse(null, { status: 404 });
      const body = (await request.json()) as { title?: string; body?: string };
      const updated = {
        ...existing,
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.body === undefined ? {} : { body: body.body }),
        updated_at: new Date().toISOString(),
      };
      mockContext.set(id, updated);
      return HttpResponse.json(updated);
    }),
    http.delete(`${AI_BASE}/context/:id`, ({ params }) => {
      mockContext.delete(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${AI_BASE}/explain`, async ({ request }) => {
      const snapshot = (await request.json()) as {
        label?: string;
        value?: string;
        peer?: string;
      };
      return HttpResponse.json({
        text: [
          `${snapshot.label ?? "This metric"} reads ${snapshot.value ?? "—"} for the period, and the line under it has been flat for three buckets rather than moving in one go.`,
          `${snapshot.peer ?? "There is no cohort comparison"} — treat that as a direction, not a target, since the cohort is small.`,
          "Your own context says meeting-heavy days are deliberate, so part of this shape was chosen rather than drifted into.",
          "Worth checking before concluding anything: the window holds fewer working days than a full month.",
        ].join("\n\n"),
        model: "claude-sonnet-5",
        tenant_context_entries: [...mockContext.values()].filter(
          (e) => e.scope === "tenant"
        ).length,
        person_context_entries: [...mockContext.values()].filter(
          (e) => e.scope === "person"
        ).length,
      });
    }),
  ];
}
