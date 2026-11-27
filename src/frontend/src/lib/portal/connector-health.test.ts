import { describe, expect, it } from "vitest";

import type {
  ConnectorHealth,
  SyncFact,
  SyncStatus,
} from "@/api/connector-health-client";
import {
  STALE_AFTER_INTERVALS,
  UNMEASURED,
  describeAge,
  describeConnector,
  describeDuration,
  describeInstance,
  describeRecording,
  describeSchedule,
  describeSync,
  formatDuration,
  formatRecords,
  formatStarted,
  instanceKey,
  panelIdFor,
} from "@/lib/portal/connector-health";

const MINUTE = 60_000;

describe("the recorded schedule", () => {
  it.each(["api", "annotation", "descriptor", "default"] as const)(
    "keeps the muted schedule line independent of %s origin",
    (origin) => {
      const schedule = { crons: ["0 22 * * *"], origin, suspended: false };

      expect(describeSchedule({ ...schedule, timezone: "UTC" })).toBe("UTC");
      expect(describeSchedule({ ...schedule, timezone: null })).toBe(
        "controller time"
      );
      expect(
        describeSchedule({ ...schedule, timezone: "UTC", suspended: true })
      ).toBe("UTC · suspended");
      expect(
        describeSchedule({ ...schedule, timezone: null, suspended: true })
      ).toBe("controller time · suspended");
    }
  );

  it.each([
    ["Europe/Sofia", "annotation", "Europe/Sofia · suspended"],
    [null, null, "controller time · suspended"],
  ] as const)(
    "shows suspension with timezone %s without origin %s",
    (timezone, origin, text) => {
      expect(
        describeSchedule({
          crons: ["0 22 * * *"],
          timezone,
          origin,
          suspended: true,
        })
      ).toBe(text);
    }
  );
  it.each([
    ["Europe/Sofia", "annotation", "Europe/Sofia"],
    [null, "descriptor", "controller time"],
    [null, "default", "controller time"],
    ["UTC", null, "UTC"],
    [null, null, "controller time"],
    [undefined, undefined, "controller time"],
  ] as const)(
    "describes timezone %s without origin %s",
    (timezone, origin, text) => {
      expect(
        describeSchedule({
          crons: ["0 22 * * *"],
          timezone,
          origin,
          suspended: false,
        })
      ).toBe(text);
    }
  );
});

function sync(over: Partial<SyncFact> = {}): SyncFact {
  return {
    job_id: "8412",
    status: "succeeded",
    started_at: "2026-01-15T09:00:00.000Z",
    duration_ms: 142_000,
    records_reported: 12_400,
    ...over,
  };
}

function row(over: Partial<ConnectorHealth> = {}): ConnectorHealth {
  return {
    connector: "example-tracker",
    configured: true,
    last_sync: sync(),
    ...over,
  };
}

describe("which installation of a connector a row is", () => {
  it("names both halves, because a source id is unique only within a tenant", () => {
    expect(
      describeInstance({ tenant_id: "acme", source_id: "claude-team-second" })
    ).toBe("acme / claude-team-second");
  });

  it("prints absence as absence rather than naming an instance nobody recorded", () => {
    expect(describeInstance({})).toBe(UNMEASURED);
    expect(describeInstance({ tenant_id: null, source_id: null })).toBe(
      UNMEASURED
    );
  });

  it("does not hide the half it does have", () => {
    expect(describeInstance({ tenant_id: "acme" })).toBe(
      `acme / ${UNMEASURED}`
    );
  });

  it("keys two installations of one connector apart", () => {
    const first = instanceKey({
      connector: "claude-team",
      tenant_id: "acme",
      source_id: "main",
    });
    const second = instanceKey({
      connector: "claude-team",
      tenant_id: "acme",
      source_id: "second",
    });

    expect(first).not.toBe(second);
  });

  it("keys an unidentified row apart from an identified one", () => {
    expect(instanceKey({ connector: "alpha" })).not.toBe(
      instanceKey({ connector: "alpha", tenant_id: "acme", source_id: "main" })
    );
  });

  it("keys two identities apart when one carries the separator", () => {
    expect(
      instanceKey({ connector: "alpha", tenant_id: "acme/main", source_id: "" })
    ).not.toBe(
      instanceKey({ connector: "alpha", tenant_id: "acme", source_id: "main" })
    );
  });

  it.each([
    [
      { connector: "a_b", tenant_id: "c" },
      { connector: "a", tenant_id: "b_c" },
    ],
    [
      { connector: "a%5Fb", tenant_id: "c" },
      { connector: "a_b", tenant_id: "c" },
    ],
  ])(
    "panel ids stay distinct when keys differ only by separator or underscore: %o vs %o",
    (first, second) => {
      expect(panelIdFor(first)).not.toBe(panelIdFor(second));
    }
  );
});

describe("what a row says", () => {
  it.each<SyncStatus | null>([
    "pending",
    "running",
    "incomplete",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
    null,
  ])(
    "keeps the state word and tone independent of the schedule for %s",
    (status) => {
      const facts = row({
        last_sync: status == null ? null : sync({ status }),
      });
      const verdict = describeConnector(facts);
      for (const configured of [true, false]) {
        const expected = configured
          ? verdict
          : describeConnector({ ...facts, configured });
        for (const schedule of [
          null,
          { crons: ["0 10 * * *"], timezone: "UTC", suspended: false },
          { crons: ["1 12 * * *"], timezone: "UTC", suspended: false },
          { crons: ["0 0 1 1 *"], timezone: "UTC", suspended: false },
          { crons: ["0 10 * * *"], timezone: "UTC", suspended: true },
          { crons: ["unreadable"], timezone: null, suspended: false },
        ]) {
          expect(describeConnector({ ...facts, configured, schedule })).toEqual(
            expected
          );
        }
      }
    }
  );

  it("gives every recorded status its own word", () => {
    const words: Record<SyncStatus, string> = {
      pending: "queued",
      running: "syncing",
      incomplete: "sync incomplete",
      succeeded: "Ready",
      failed: "sync failed",
      cancelled: "sync cancelled",
      unknown: "state unknown",
    };
    for (const [status, label] of Object.entries(words)) {
      expect(
        describeConnector(
          row({ last_sync: sync({ status: status as SyncStatus }) })
        ).label
      ).toBe(label);
    }
  });

  it.each(["renamed_word", "constructor"])(
    "reads the unrecognised status %s as state unknown",
    (status) => {
      expect(describeSync(sync({ status })).state).toBe("state_unknown");
    }
  );

  it("never says a connector is delivering", () => {
    const statuses: SyncStatus[] = [
      "pending",
      "running",
      "incomplete",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ];
    const labels = statuses.map(
      (status) => describeConnector(row({ last_sync: sync({ status }) })).label
    );
    for (const label of [...labels, "no longer configured", "never synced"]) {
      expect(label).not.toMatch(/deliver|healthy|fresh|up to date/i);
    }
  });

  it("reads configuration before the sync outcome", () => {
    const removed = describeConnector(
      row({ configured: false, last_sync: sync({ status: "failed" }) })
    );
    expect(removed.state).toBe("no_longer_configured");
    expect(removed.tone).not.toBe("failing");
  });

  it("separates never synced from no longer configured", () => {
    expect(describeConnector(row({ last_sync: null })).state).toBe(
      "never_synced"
    );
    expect(
      describeConnector(row({ configured: false, last_sync: null })).state
    ).toBe("no_longer_configured");
  });

  it("gives an unreadable state its own tone, not the quiet one", () => {
    const murky = describeConnector(
      row({ last_sync: sync({ status: "unknown" }) })
    );
    expect(murky.tone).toBe("unknown");
    expect(murky.tone).not.toBe("ok");
    expect(murky.tone).not.toBe("idle");
  });

  it("keeps queued apart from syncing", () => {
    const queued = describeConnector(
      row({ last_sync: sync({ status: "pending" }) })
    );
    const running = describeConnector(
      row({ last_sync: sync({ status: "running" }) })
    );
    expect(queued.state).not.toBe(running.state);
    expect(queued.label).not.toBe(running.label);
  });

  it("reads a status this build has never heard of as unreadable", () => {
    const view = describeConnector(
      row({ last_sync: sync({ status: "materialising" as never }) })
    );
    expect(view.state).toBe("state_unknown");
    expect(view.tone).toBe("unknown");
  });

  it("carries a word for every tone, so colour is never the only signal", () => {
    const statuses: SyncStatus[] = [
      "succeeded",
      "failed",
      "running",
      "unknown",
    ];
    for (const status of statuses) {
      expect(describeSync(sync({ status })).label.length).toBeGreaterThan(0);
    }
  });
});

describe("how long a sync has been going", () => {
  const AS_OF = "2026-01-15T09:22:00.000Z";

  it("a finished sync states what it took", () => {
    const view = describeDuration(sync({ duration_ms: 142_000 }), AS_OF);
    expect(view).toEqual({ text: "2m 22s", inFlight: false });
  });

  it("a running sync states how long it has been going, worded as unfinished", () => {
    const view = describeDuration(
      sync({ status: "running", started_at: "2026-01-15T09:00:00.000Z" }),
      AS_OF
    );
    expect(view).toEqual({ text: "22m 0s so far", inFlight: true });
  });

  it("a running sync ignores a recorded duration rather than printing it", () => {
    const view = describeDuration(
      sync({
        status: "running",
        started_at: "2026-01-15T09:00:00.000Z",
        duration_ms: 0,
      }),
      AS_OF
    );
    expect(view.text).toBe("22m 0s so far");
  });

  it("a queued sync has no start to measure from, so it prints absence", () => {
    const view = describeDuration(
      sync({ status: "pending", started_at: null, duration_ms: null }),
      AS_OF
    );
    expect(view).toEqual({ text: UNMEASURED, inFlight: false });
  });

  it("a start the page cannot date prints absence rather than an epoch span", () => {
    const view = describeDuration(
      sync({ status: "running", started_at: "nonsense" }),
      AS_OF
    );
    expect(view.text).toBe(UNMEASURED);
  });

  it("a start ahead of the answer's own clock prints absence", () => {
    const view = describeDuration(
      sync({ status: "running", started_at: "2026-01-15T10:00:00.000Z" }),
      AS_OF
    );
    expect(view.text).toBe(UNMEASURED);
  });

  it("a status this build cannot read is not treated as running", () => {
    const view = describeDuration(
      sync({ status: "borked", duration_ms: 142_000 }),
      AS_OF
    );
    expect(view).toEqual({ text: "2m 22s", inFlight: false });
  });

  it("a connector that has never synced prints absence", () => {
    expect(describeDuration(null, AS_OF)).toEqual({
      text: UNMEASURED,
      inFlight: false,
    });
    expect(describeDuration(undefined, AS_OF)).toEqual({
      text: UNMEASURED,
      inFlight: false,
    });
  });
});

describe("a contract-legal response with absent keys", () => {
  it("a row with no last_sync key reads as never synced", () => {
    const view = describeConnector({ connector: "a", configured: true });
    expect(view.state).toBe("never_synced");
  });

  it("absent measurements print as absence rather than throwing", () => {
    expect(formatRecords(undefined)).toBe(UNMEASURED);
    expect(formatDuration(undefined)).toBe(UNMEASURED);
    expect(formatStarted(undefined)).toBe(UNMEASURED);
  });

  it("a summary with no checked_at key says nothing has been read", () => {
    const view = describeRecording({
      as_of: "2026-01-15T12:00:00.000Z",
      history_available: true,
    });
    expect(view.state).toBe("never_read");
  });

  it("a sync with no status at all is unreadable, not quiet", () => {
    expect(describeSync({ job_id: "1" } as never).state).toBe("state_unknown");
  });
});

describe("an unmeasured value is not a zero", () => {
  it("prints absence as absence", () => {
    expect(formatDuration(null)).toBe(UNMEASURED);
    expect(formatRecords(null)).toBe(UNMEASURED);
    expect(formatStarted(null)).toBe(UNMEASURED);
  });

  it("prints a measured zero as zero", () => {
    expect(formatRecords(0)).toBe("0");
    expect(formatDuration(0)).toBe("0s");
  });

  it("prints an unparseable stamp as absence rather than as an epoch", () => {
    expect(formatStarted("not a date")).toBe(UNMEASURED);
  });

  it("reads durations at the scale they arrive in", () => {
    expect(formatDuration(900)).toBe("<1s");
    expect(formatDuration(1_500)).toBe("2s");
    expect(formatDuration(22_049)).toBe("22s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_930_000)).toBe("1h 5m");
  });

  it("never carries sixty of the unit below", () => {
    expect(formatDuration(119_600)).toBe("2m 0s");
    expect(formatDuration(59_950)).toBe("1m 0s");
    expect(formatDuration(3_599_600)).toBe("1h 0m");
  });

  it("prints a malformed measurement as absence, not as a number", () => {
    expect(formatDuration(-5_000)).toBe(UNMEASURED);
    expect(formatRecords(-1)).toBe(UNMEASURED);
    expect(formatDuration(Number.NaN)).toBe(UNMEASURED);
  });

  it("refuses a stamp that is not a real timestamp", () => {
    for (const junk of ["2026", "0", "yesterday", "2026-13-45T99:99:99Z"]) {
      expect(formatStarted(junk)).toBe(UNMEASURED);
    }
    expect(formatStarted("2026-01-15T09:00:00.000Z")).toBe(
      "15 Jan 2026 · 09:00:00"
    );
  });
});

describe("what the page says about its own freshness", () => {
  const summary = (
    over: Partial<Parameters<typeof describeRecording>[0]> = {}
  ) => ({
    as_of: "2026-01-15T12:00:00.000Z",
    checked_at: "2026-01-15T11:59:00.000Z",
    typical_read_interval_ms: 15 * MINUTE,
    history_available: true,
    ...over,
  });

  const checkedAgo = (ms: number) =>
    new Date(Date.parse("2026-01-15T12:00:00.000Z") - ms).toISOString();

  it("says nothing has been read rather than implying health", () => {
    const view = describeRecording(summary({ history_available: false }));
    expect(view.state).toBe("never_read");
    expect(view.label).not.toMatch(/healthy|ok|fine/i);
  });

  it("presents recent facts as current", () => {
    expect(describeRecording(summary()).state).toBe("current");
  });

  it("tolerates one missed read but not three", () => {
    const interval = 15 * MINUTE;
    expect(
      describeRecording(
        summary({ checked_at: checkedAgo(interval * STALE_AFTER_INTERVALS) })
      ).state
    ).toBe("current");
    expect(
      describeRecording(
        summary({
          checked_at: checkedAgo(interval * STALE_AFTER_INTERVALS + 1),
        })
      ).state
    ).toBe("stopped");
  });

  it("states the age without claiming a stop it cannot support", () => {
    const view = describeRecording(
      summary({
        typical_read_interval_ms: null,
        checked_at: checkedAgo(6 * 60 * MINUTE),
      })
    );
    expect(view.state).toBe("unmeasured");
    expect(view.label).toMatch(/last checked 6 h ago/i);
    expect(view.label).not.toMatch(/stopped/i);
    expect(view.detail).toMatch(/too few reads/i);
  });

  it("treats a zero measured interval as no measurement at all", () => {
    const view = describeRecording(
      summary({
        typical_read_interval_ms: 0,
        checked_at: checkedAgo(6 * 60 * MINUTE),
      })
    );
    expect(view.state).toBe("unmeasured");
  });

  it("still says the age is long, so the fact is not hidden", () => {
    const view = describeRecording(
      summary({
        typical_read_interval_ms: null,
        checked_at: checkedAgo(200 * 24 * 60 * MINUTE),
      })
    );
    expect(view.label).toMatch(/200 d ago/);
  });

  it("does not cry stopped because a burst shortened the interval", () => {
    const view = describeRecording(
      summary({
        typical_read_interval_ms: 1_000,
        checked_at: checkedAgo(5 * MINUTE),
      })
    );
    expect(view.state).toBe("current");
  });

  it("does not let a long measured interval hide a stopped recorder", () => {
    const view = describeRecording(
      summary({
        typical_read_interval_ms: 30 * 24 * 60 * MINUTE,
        checked_at: checkedAgo(4 * 60 * MINUTE),
      })
    );
    expect(view.state).toBe("stopped");
  });

  it("dates nothing when the two clocks disagree", () => {
    const view = describeRecording(
      summary({ checked_at: "2026-01-16T00:00:00.000Z" })
    );
    expect(view.state).toBe("unreadable");
    expect(view.label).not.toMatch(/just now/i);
  });

  it("dates nothing when a stamp will not parse", () => {
    expect(describeRecording(summary({ checked_at: "nope" })).state).toBe(
      "unreadable"
    );
  });
});

describe("ages read coarsely", () => {
  it("does not pretend to a precision a periodic read does not have", () => {
    expect(describeAge(5_000)).toBe("just now");
    expect(describeAge(5 * MINUTE)).toBe("5 min ago");
    expect(describeAge(3 * 60 * MINUTE)).toBe("3 h ago");
    expect(describeAge(50 * 60 * MINUTE)).toBe("2 d ago");
  });
});
