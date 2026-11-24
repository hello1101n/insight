import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { vi } from "vitest";

import * as customClient from "@/api/custom-client";
import { CustomApiError } from "@/api/custom-client";
import { datasetNames } from "@/test/catalogue";

export function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

export function mockCatalogues(): void {
  const none = { items: [], total: 0 };
  vi.mocked(customClient.fetchMetrics).mockResolvedValue(none);
  vi.mocked(customClient.fetchWidgets).mockResolvedValue(none);
  vi.mocked(customClient.fetchDashboards).mockResolvedValue(none);
  vi.mocked(customClient.fetchDatasetNames).mockResolvedValue(datasetNames([]));
  vi.mocked(customClient.fetchMetric).mockRejectedValue(
    new CustomApiError(404, null)
  );
  vi.mocked(customClient.fetchWidget).mockRejectedValue(
    new CustomApiError(404, null)
  );
  vi.mocked(customClient.fetchDataset).mockImplementation(async (name) => ({
    name,
    declaration: { title: name, fields: [] },
  }));
}

export function invalid(
  violations: { field?: string; description: string }[]
): CustomApiError {
  return new CustomApiError(400, {
    detail: "Request validation failed",
    context: {
      field_violations: violations.map((one) => ({
        ...one,
        reason: "INVALID",
      })),
    },
  });
}

export async function writeText(
  user: ReturnType<typeof userEvent.setup>,
  text: string
): Promise<HTMLTextAreaElement> {
  const area = screen.getByLabelText(/as text/i) as HTMLTextAreaElement;
  await user.clear(area);
  await user.paste(text);
  return area;
}
