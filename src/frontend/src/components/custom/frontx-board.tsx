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
import { frontxBoard } from "@/lib/custom/frontx-board";
import { dashboardWidgetsQuery } from "@/queries/custom";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";

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
      const result = await readJson<MetricResult>(res);
      const at = Object.fromEntries(
        result.columns.map((name, index) => [name, index])
      );

      return { ...result, at };
    },
  };
}

// One root per board file: the root reads its served file once and keeps it.
const roots = new Map<string, DashboardRoot>();

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

export default function FrontxBoardPage(props: FrontxBoardProps) {
  // Set by vite.frontx-widgets.ts from FRONTX_WIDGETS_DIR.
  if (!import.meta.env.VITE_FRONTX_WIDGETS_SET) {
    return (
      <ComingSoon
        variant="card"
        state="error"
        label="FRONTX_WIDGETS_DIR is not set. Build the FrontX widget bundles, set it to their dist folder and restart the dev server."
      />
    );
  }
  return <FrontxBoard {...props} />;
}

function FrontxBoard({ id, read, range }: FrontxBoardProps) {
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

  if (!board || !root) return <CenteredSpinner className="min-h-40" />;

  return (
    <div data-testid="frontx-board">
      <Dashboard
        root={root}
        dashboardId={board.dashboardId}
        theme={theme}
        language="en"
        variables={range ? { range } : {}}
        overlayContainer={document.body}
      />
    </div>
  );
}
