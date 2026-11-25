import { withThemeByClassName } from "@storybook/addon-themes";
import type { Decorator } from "@storybook/react-vite";

export const themeDecorators: Decorator[] = [
  withThemeByClassName({
    themes: { light: "light", dark: "dark" },
    defaultTheme: "light",
  }),
];
