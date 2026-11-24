import type { Decorator } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { I18nextProvider } from "react-i18next";

import { ThemeProvider } from "@/components/theme-provider";
import i18n from "@/i18n";
import { createTestingRouter } from "./test-router";

export const WithProviders: Decorator = (Story, context) => {
  const selectedTheme = context.globals.theme === "dark" ? "dark" : "light";
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
    [],
  );
  const zone: string | undefined = context.parameters.zone;
  const { router, reset } = useMemo(() => createTestingRouter(zone), [zone]);

  useEffect(() => {
    reset();
    router.update({ defaultNotFoundComponent: () => <Story /> });
  }, [router, reset, Story]);

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider key={selectedTheme} defaultTheme={selectedTheme}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};
