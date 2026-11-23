import type { Plugin } from "vite";

const KIT = "@gears-frontx/ui-kit";

// WORKAROUND: the first sheet to name a layer fixes its order, and kit chunks load before Tailwind's.
const ORDER = "@layer properties, theme, base, components, utilities;";

// WORKAROUND: unlayered kit CSS beats layered Tailwind utilities; drop once the kit ships layered CSS (#2705).
export function uiKitLayer(): Plugin {
  return {
    name: "ui-kit-layer",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.includes(KIT) || !file.endsWith(".css")) return null;
      return { code: `${ORDER}\n@layer components {\n${code}\n}`, map: null };
    },
  };
}
