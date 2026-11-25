import {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as Sentry from "@sentry/react";
import { Table2 } from "lucide-react";
import {
  Dashboard,
  DashboardRoot,
  loadWidgetParts,
  type CellAction,
  type CellActionTarget,
  type CellFailureReport,
  type DashboardHost,
} from "@gears-frontx/frontx-dashboard-root";

import {
  isBusy,
  type DashboardRead,
  type DashboardWidget,
  type RunOptions,
} from "@/api/custom-client";
import { previousOptions, runOptions } from "@/lib/custom/board-range";
import {
  frontxAnswer,
  frontxBoard,
  type FrontxBoard as Drawn,
} from "@/lib/custom/frontx-board";
import {
  dashboardWidgetResultQuery,
  dashboardWidgetsQuery,
} from "@/queries/custom";
import { useIsAdmin } from "@/queries/identity-me";
import { queryClient } from "@/query-client";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { refusal } from "@/components/custom/refusal";
import { WidgetDrilldown } from "@/components/custom/widget-drilldown";

const WIDGET_LIST = "/widgets/widgets.json";

let shown: Drawn & { id: string; key: string } = {
  id: "",
  key: "",
  dashboardId: "",
  file: { types: [], instances: [] },
  runs: new Map(),
  widgets: new Map(),
};

const host: DashboardHost = {
  loadFile: async (signal) => {
    const { file } = shown;
    return [
      file,
      ...(await loadWidgetParts(WIDGET_LIST, signal, location.href)),
    ];
  },
  request: async ({ path, body }) => {
    const run = shown.runs.get(path);
    if (!run)
      throw new Error("The shown board has no widget that runs at this path.");

    // INVARIANT: a run body is the one runRequest builds plus the range that FrontX adds, so the cache key matches the current renderer's.
    const options = body as RunOptions | undefined;
    const previous = previousOptions(run.widget.body, options);
    const [result, earlier] = await Promise.all([
      queryClient.query(
        dashboardWidgetResultQuery(run.dashboard, run.widget.id, options)
      ),
      // INVARIANT: a failed previous run leaves the stat without a comparison, as the current renderer does.
      previous
        ? queryClient
            .query(
              dashboardWidgetResultQuery(run.dashboard, run.widget.id, previous)
            )
            .catch(() => null)
        : undefined,
    ]);

    const answer = frontxAnswer(result, run.widget.body);
    if (earlier === undefined) return answer;
    return {
      ...answer,
      previous: earlier && frontxAnswer(earlier, run.widget.body),
    };
  },
};

// SAFETY: the report leaves out the reason message. It can quote answer values and host error text, and FrontX writes it to the console.
function reportFailure({
  dashboardId,
  widgetId,
  widgetType,
  role,
  reason,
}: CellFailureReport): void {
  const current = dashboardId === shown.dashboardId;
  // WORKAROUND: Sentry drops an event with the same message and fingerprint as the event before it, so the message names the cell.
  Sentry.captureMessage(`A FrontX dashboard cell failed: ${widgetId}`, {
    level: "error",
    fingerprint: ["frontx-cell-failure", reason.kind],
    tags: {
      "frontx.failure_kind": reason.kind,
      "frontx.role": role,
      "frontx.widget_type": widgetType,
      "insight.dashboard_id": current ? shown.id : undefined,
      "insight.widget_id": current
        ? shown.widgets.get(widgetId)?.id
        : undefined,
    },
  });
}

let root: DashboardRoot | undefined;

const appRoot = () =>
  (root ??= new DashboardRoot({ host, onFailure: reportFailure }));

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function useAppliedTheme(): string {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme ?? "light"
  );
}

interface FrontxBoardProps {
  id: string;
  read: DashboardRead;
  range: string | undefined;
}

export default function FrontxBoard({ id, read, range }: FrontxBoardProps) {
  const { t, i18n } = useTranslation();
  const { isAdmin } = useIsAdmin();
  const widgets = useQuery(dashboardWidgetsQuery(id));
  const theme = useAppliedTheme();
  const [drilldown, setDrilldown] = useState<{
    widget: DashboardWidget;
    open: boolean;
  }>();
  const board = useMemo(() => {
    if (!widgets.data) return undefined;
    const drawn = frontxBoard(id, read, widgets.data, range);
    return { ...drawn, id, key: JSON.stringify(drawn.file.instances) };
  }, [id, read, widgets.data, range]);

  // INVARIANT: a layout effect, so the shown file changes before the dashboard's own effect reads it.
  useLayoutEffect(() => {
    if (!board || board.key === shown.key) return;
    shown = board;
    appRoot().reload();
  }, [board]);

  if (widgets.isError) {
    return (
      <ComingSoon
        variant="card"
        state="error"
        label={refusal(widgets.error, "Couldn't load the widgets.")}
        onRetry={() => void widgets.refetch()}
      />
    );
  }
  if (!board) return <CenteredSpinner className="min-h-40" />;

  const details = ({ widgetId }: CellActionTarget): CellAction[] => {
    const widget = board.widgets.get(widgetId);
    if (!widget) return [];

    const run = queryClient.getQueryState(
      dashboardWidgetResultQuery(id, widget.id, runOptions(widget, range))
        .queryKey
    );
    // INVARIANT: the drilldown sends no query to a warehouse that refused this widget's run as busy.
    if (isBusy(run?.error)) return [];

    return [
      {
        label: "Details",
        icon: <Table2 />,
        onSelect: () => setDrilldown({ widget, open: true }),
      },
    ];
  };

  return (
    <>
      <Dashboard
        root={appRoot()}
        dashboardId={board.dashboardId}
        theme={theme}
        language={i18n.resolvedLanguage ?? "en"}
        texts={{
          dashboard: {
            loading: "Loading",
            cannotBeShown: "Couldn't load this dashboard.",
          },
          frame: {
            loading: "Loading",
            cannotBeShown: "This widget couldn't be loaded.",
            openLarger: (title) => `Expand ${title}`,
            close: t("common.actions.close"),
            retry: t("common.actions.retry"),
          },
        }}
        variables={range ? { range } : {}}
        overlayContainer={document.body}
        cellActions={isAdmin ? details : undefined}
      />
      {isAdmin && drilldown ? (
        <WidgetDrilldown
          dashboard={id}
          widgetId={drilldown.widget.id}
          widget={drilldown.widget.body}
          name={drilldown.widget.name}
          label={drilldown.widget.body.title ?? drilldown.widget.name}
          open={drilldown.open}
          onOpenChange={(open) => setDrilldown({ ...drilldown, open })}
          options={runOptions(drilldown.widget, range)}
        />
      ) : null}
    </>
  );
}
