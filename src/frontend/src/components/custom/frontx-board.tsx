import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dashboard,
  DashboardRoot,
  loadWidgetParts,
  type DashboardHost,
  type ServedFile,
} from "@gears-frontx/frontx-dashboard-root";

import {
  JSON_HEADERS,
  readJson,
  type DashboardRead,
  type MetricResult,
} from "@/api/custom-client";
import { fetchWithAuth } from "@/api/fetch-with-auth";
import { frontxAnswer, frontxBoard } from "@/lib/custom/frontx-board";
import { dashboardWidgetsQuery } from "@/queries/custom";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { refusal } from "@/components/custom/refusal";

const WIDGET_LIST = "/widgets/widgets.json";

let shown: { key: string; file: ServedFile } = {
  key: "",
  file: { types: [], instances: [] },
};

const host: DashboardHost = {
  loadFile: async (signal) => {
    const { file } = shown;
    return [
      file,
      ...(await loadWidgetParts(WIDGET_LIST, signal, location.href)),
    ];
  },
  request: async ({ method, path, body }, signal) => {
    const res = await fetchWithAuth(path, {
      method,
      signal,
      ...(body === undefined
        ? {}
        : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
    });
    return frontxAnswer(await readJson<MetricResult>(res));
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
      language="en"
      variables={range ? { range } : {}}
      overlayContainer={document.body}
    />
  );
}
