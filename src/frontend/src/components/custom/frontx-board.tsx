import { useMemo, useSyncExternalStore } from "react";
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

function hostFor(file: ServedFile): DashboardHost {
  return {
    loadFile: async (signal) => [
      file,
      ...(await loadWidgetParts(WIDGET_LIST, signal, location.href)),
    ],
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
}

const roots = new Map<string, DashboardRoot>();

// WORKAROUND: a DashboardRoot reads its served file once, so each version of a board file gets
// its own root, and the roots stay for the life of the page.
function rootFor(file: ServedFile): DashboardRoot {
  const key = JSON.stringify(file.instances);
  let root = roots.get(key);
  if (!root) {
    root = new DashboardRoot({ host: hostFor(file) });
    roots.set(key, root);
  }
  return root;
}

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
  const board = useMemo(
    () => (widgets.data ? frontxBoard(id, read, widgets.data) : undefined),
    [id, read, widgets.data]
  );
  const root = useMemo(
    () => (board ? rootFor(board.file) : undefined),
    [board]
  );

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
  if (!board || !root) return <CenteredSpinner className="min-h-40" />;

  return (
    <Dashboard
      root={root}
      dashboardId={board.dashboardId}
      theme={theme}
      language="en"
      variables={range ? { range } : {}}
      overlayContainer={document.body}
    />
  );
}
