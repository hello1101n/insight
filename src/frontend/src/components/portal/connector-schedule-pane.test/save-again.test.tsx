import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { ConnectorsApiError } from "@/api/connectors-client";
import { editCustom, mocks, pane, read } from "./fixtures";

function overdueRequest(reset = false) {
  const schedule = mocks.query.data!.schedule;
  schedule.pending_reason = "different_schedule";
  schedule.requested!.updated_at = "2026-01-15T11:40:00Z";
  schedule.reconcile_interval_secs = 600;
  if (reset) {
    schedule.requested!.crons = [];
    schedule.inherited = { crons: ["0 14 * * *"], origin: "annotation" };
  }
  return schedule;
}

it.each([
  { state: "saved schedule", reset: false, payload: ["0 6 * * *"] },
  { state: "reset", reset: true, payload: null },
])(
  "resubmits the overdue $state with its current ETag",
  async ({ reset, payload }) => {
    overdueRequest(reset);
    mocks.save.mockResolvedValue(read());
    render(pane());

    await userEvent.click(screen.getByRole("button", { name: "Save again" }));

    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      etag: '"2"',
      crons: payload,
    });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  }
);

it.each(["awaiting_reconcile", "no_cronworkflow", null] as const)(
  "shows the overdue alert without a retry for %s",
  (reason) => {
    const schedule = overdueRequest();
    schedule.pending_reason = reason;
    if (reason === "awaiting_reconcile") schedule.requested!.crons = [];
    if (reason === "no_cronworkflow") schedule.live = null;
    render(pane());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not applied after 20 minutes."
    );
    expect(screen.queryByRole("button", { name: "Save again" })).toBeNull();
  }
);

it("blocks a second click and shows loading while Save again is in progress", async () => {
  overdueRequest();
  const { promise, resolve } = Promise.withResolvers();
  const view = render(pane());
  mocks.save.mockImplementation(async () => {
    await promise;
    mocks.write.isPending = false;
    view.rerender(pane());
    return read();
  });

  const button = screen.getByRole("button", { name: "Save again" });
  expect(button).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.dblClick(button);
  expect(mocks.save).toHaveBeenCalledTimes(1);

  mocks.write.isPending = true;
  view.rerender(pane());
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  await userEvent.click(button);
  expect(mocks.save).toHaveBeenCalledTimes(1);

  await act(async () => resolve(undefined));
  expect(button).not.toHaveAttribute("aria-busy");
  expect(button).not.toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
});

it("reloads the schedule after a stale retry", async () => {
  overdueRequest();
  const view = render(pane());
  mocks.save.mockRejectedValue(new ConnectorsApiError(412, null));
  mocks.query.refetch.mockImplementation(async () => {
    mocks.query.data = structuredClone(mocks.query.data!);
    mocks.query.data.schedule.revision++;
    mocks.query.data.etag = '"3"';
    view.rerender(pane());
    return { data: mocks.query.data };
  });

  await userEvent.click(screen.getByRole("button", { name: "Save again" }));

  expect(mocks.query.refetch).toHaveBeenCalledTimes(1);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByText(
      "Another save changed this schedule. Review the updated schedule."
    )
  ).toBeInTheDocument();
});

it("shows one load error with Retry when reloading after a stale retry fails", async () => {
  overdueRequest();
  mocks.save.mockRejectedValue(new ConnectorsApiError(412, null));
  const view = render(pane());
  mocks.query.refetch.mockImplementationOnce(async () => {
    mocks.query.isError = true;
    view.rerender(pane());
    return { data: mocks.query.data, error: new Error("Request failed") };
  });

  await userEvent.click(screen.getByRole("button", { name: "Save again" }));

  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.query.refetch).toHaveBeenCalledOnce();
  const line = screen.getByText("Could not load the schedule.");
  await userEvent.click(within(line).getByRole("button", { name: "Retry" }));
  expect(mocks.query.refetch).toHaveBeenCalledTimes(2);
});

it.each([
  {
    status: 409,
    detail:
      "Reset requires the deployment schedule annotation; run reconcile before resetting",
    summary: "Can't reset yet. Try after 12:15 UTC.",
  },
  {
    status: 503,
    detail:
      "The schedule was not changed: the cluster refused the change because the sync job is locked.",
    summary: "Schedule not changed: the cluster refused the change.",
  },
])(
  "shows the editor summary and server reason for a $status retry failure",
  async ({ status, detail, summary }) => {
    const schedule = overdueRequest(status === 409);
    schedule.next_reconcile_at = "2026-01-15T12:15:00Z";
    mocks.save.mockRejectedValue(new ConnectorsApiError(status, { detail }));
    render(pane());

    const retry = screen.getByRole("button", { name: "Save again" });
    await userEvent.click(retry);

    const alert = (await screen.findByText(summary)).closest('[role="alert"]')!;
    expect(within(alert as HTMLElement).getByText(detail)).not.toBeVisible();
    await userEvent.click(within(alert as HTMLElement).getByText("Details"));
    expect(screen.getByText(detail)).toBeVisible();
    expect(retry).not.toHaveAttribute("aria-busy");
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
  }
);

it.each(["observation", "status", "reason", "revision", "updated_at"] as const)(
  "keeps a failed retry only while the request is unchanged: %s",
  async (field) => {
    overdueRequest();
    mocks.save.mockRejectedValue(new Error("Synthetic write failure"));
    const view = render(pane());

    await userEvent.click(screen.getByRole("button", { name: "Save again" }));
    const message = "Could not save the schedule. Try again.";
    expect(await screen.findByText(message)).toBeInTheDocument();

    const initial = mocks.query.data!;
    const next = structuredClone(initial);
    switch (field) {
      case "observation":
        next.schedule.live!.observed_at = "2026-01-15T12:00:30Z";
        break;
      case "status":
        next.schedule.status = "paused";
        next.schedule.live!.suspended = true;
        next.schedule.pending_reason = null;
        break;
      case "reason":
        next.schedule.pending_reason = "no_cronworkflow";
        next.schedule.live = null;
        break;
      case "revision":
        next.schedule.revision++;
        next.etag = '"3"';
        break;
      case "updated_at":
        next.schedule.requested!.updated_at = "2026-01-15T11:41:00Z";
        break;
    }
    mocks.query.data = next;
    view.rerender(pane());

    if (field === "observation") {
      expect(screen.getByText(message)).toBeInTheDocument();
    } else {
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      mocks.query.data = initial;
      view.rerender(pane());
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    }
  }
);

function appliedRequest(): ReturnType<typeof read> {
  const next = structuredClone(mocks.query.data!);
  next.schedule.status = "applied";
  next.schedule.pending_reason = null;
  next.schedule.live!.crons = next.schedule.requested!.crons;
  next.schedule.live!.origin = "api";
  return next;
}

it("omits the retry conflict when the reloaded request is already applied", async () => {
  overdueRequest();
  mocks.save.mockRejectedValue(new ConnectorsApiError(412, null));
  const view = render(pane());
  mocks.query.refetch.mockImplementation(async () => {
    mocks.query.data = appliedRequest();
    view.rerender(pane());
    return { data: mocks.query.data };
  });

  await userEvent.click(screen.getByRole("button", { name: "Save again" }));

  expect(screen.getByText("Set by admin")).toBeInTheDocument();
  expect(
    screen.queryByText(/Another save changed this schedule/)
  ).not.toBeInTheDocument();
});

it("announces application after a successful retry at the revision of a failed editor save", async () => {
  overdueRequest();
  mocks.save.mockRejectedValueOnce(new Error("Synthetic editor failure"));
  const view = render(pane());
  await editCustom();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Your input is kept/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.toast).not.toHaveBeenCalled();

  mocks.save.mockImplementationOnce(async () => {
    mocks.query.data = appliedRequest();
    view.rerender(pane());
    return mocks.query.data;
  });
  await userEvent.click(screen.getByRole("button", { name: "Save again" }));

  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
    type: "success",
    title: expect.stringMatching(/^Schedule applied/),
  });
});

it("focuses Edit after a successful retry", async () => {
  overdueRequest();
  const view = render(pane());
  const { promise, resolve } = Promise.withResolvers<ReturnType<typeof read>>();
  mocks.save.mockImplementationOnce(async () => {
    const result = await promise;
    mocks.query.data = result;
    view.rerender(pane());
    return result;
  });
  const retry = screen.getByRole("button", { name: "Save again" });
  await userEvent.click(retry);
  mocks.write.isPending = true;
  view.rerender(pane());
  const edit = screen.getByRole("button", { name: "Edit" });
  expect(edit).toBeDisabled();

  await act(async () => resolve(appliedRequest()));
  expect(edit).toBeDisabled();
  mocks.write.isPending = false;
  view.rerender(pane());

  expect(retry).not.toBeInTheDocument();
  expect(edit).toHaveFocus();
});

it("keeps the loaded pending schedule and actions above a background read error", async () => {
  overdueRequest();
  const view = render(pane());
  const retry = await screen.findByRole("button", { name: "Save again" });
  const badge = screen.getByText("Pending");
  const alert = screen.getByRole("alert");
  const edit = screen.getByRole("button", { name: "Edit" });
  mocks.query.isError = true;
  view.rerender(pane());

  expect(screen.queryByText("Not loaded")).not.toBeInTheDocument();
  expect(badge).toBeVisible();
  expect(screen.getByText("0 6 * * *")).toBeVisible();
  expect(alert).toBeVisible();
  expect(retry).toBeEnabled();
  expect(edit).toBeEnabled();
  const line = screen.getByText("Could not load the schedule.");
  expect(alert.compareDocumentPosition(line)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );
  await userEvent.click(within(line).getByRole("button", { name: "Retry" }));
  expect(mocks.query.refetch).toHaveBeenCalledOnce();
});

it("keeps the retry error when the editor closes without changing the request", async () => {
  overdueRequest();
  mocks.save.mockRejectedValue(new Error("Synthetic write failure"));
  render(pane());

  await userEvent.click(screen.getByRole("button", { name: "Save again" }));
  const message = "Could not save the schedule. Try again.";
  expect(await screen.findByText(message)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.getByText(message)).toBeInTheDocument();
});
