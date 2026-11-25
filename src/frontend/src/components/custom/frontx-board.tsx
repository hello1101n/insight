import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Dashboard,
  DashboardRoot,
  loadWidgetParts,
  type DashboardHost,
} from "@gears-frontx/frontx-dashboard-root";

import type { DashboardRead, RunOptions } from "@/api/custom-client";
import {
  frontxAnswer,
  frontxBoard,
  type FrontxBoard as Drawn,
} from "@/lib/custom/frontx-board";
import {
  dashboardWidgetResultQuery,
  dashboardWidgetsQuery,
} from "@/queries/custom";
import { queryClient } from "@/query-client";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { refusal } from "@/components/custom/refusal";

const WIDGET_LIST = "/widgets/widgets.json";

let shown: Pick<Drawn, "file" | "runs"> & { key: string } = {
  key: "",
  file: { types: [], instances: [] },
  runs: new Map(),
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
    const result = await queryClient.query(
      dashboardWidgetResultQuery(
        run.dashboard,
        run.widget,
        body as RunOptions | undefined
      )
    );
    return frontxAnswer(result);
  },
};

let root: DashboardRoot | undefined;

const appRoot = () => (root ??= new DashboardRoot({ host }));

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
  const widgets = useQuery(dashboardWidgetsQuery(id));
  const theme = useAppliedTheme();
  const board = useMemo(() => {
    if (!widgets.data) return undefined;
    const drawn = frontxBoard(id, read, widgets.data);
    return { ...drawn, key: JSON.stringify(drawn.file.instances) };
  }, [id, read, widgets.data]);

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

  return (
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
    />
  );
}
