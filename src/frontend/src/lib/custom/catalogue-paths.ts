export const PREVIEWED = {
  datasets: "/dashboards/datasets/$name",
  metrics: "/dashboards/metrics/$name",
  widgets: "/dashboards/widgets/$name",
} as const;

export type PreviewedKind = keyof typeof PREVIEWED;
