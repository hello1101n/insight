import type {
  MetricEvidenceColumn,
  MetricEvidenceRow,
  MetricEvidenceSort,
} from "@/api/metric-drilldown-client";

interface WidgetBase {
  metric: string;
  title?: string;
  detail?: string;
}

export interface TableWidget extends WidgetBase {
  type: "table";
  columns: string[];
}

export interface Target {
  value: number;
  label?: string;
}

export interface SeriesWidget extends WidgetBase {
  type: "line" | "area";
  x: string;
  y: string;
  series?: string;
  target?: Target;
}

export interface BarWidget extends WidgetBase {
  type: "bar";
  x: string;
  y: string;
  series?: string;
  labels?: boolean;
  horizontal?: boolean;
  stack?: "percent";
  target?: Target;
}

export type Better = "higher" | "lower" | "neutral";

export interface StatWidget extends WidgetBase {
  type: "stat";
  value: string;
  label?: string;
  compare?: { better?: Better };
}

export interface PieWidget extends WidgetBase {
  type: "pie";
  label: string;
  value: string;
}

export interface HeatmapWidget extends WidgetBase {
  type: "heatmap";
  x: string;
  y?: string;
  value: string;
}

export interface FunnelWidget extends WidgetBase {
  type: "funnel";
  stages: string[];
}

export interface TreemapWidget extends WidgetBase {
  type: "treemap";
  label: string;
  value: string;
  group?: string;
}

export interface ScatterWidget extends WidgetBase {
  type: "scatter";
  x: string;
  y: string;
  size?: string;
  series?: string;
  label?: string;
}

export type Widget =
  | TableWidget
  | SeriesWidget
  | BarWidget
  | StatWidget
  | PieWidget
  | HeatmapWidget
  | FunnelWidget
  | TreemapWidget
  | ScatterWidget;

export interface MetricRead {
  field?: string;
  column?: string;
  json?: string;
}

export interface MetricDefinition {
  dataset?: string;
  table?: string;
  database?: string;
  time?: MetricRead;
  max_range?: string;
  fields: (MetricRead & {
    type: string;
    agg?: string;
    as_name: string;
    divide?: [string, string];
  })[];
  group_by?: string[];
  filters?: (MetricRead & {
    type: string;
    op: string;
    value: unknown;
  })[];
  order_by?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
}

export interface EffectiveClock {
  field: string;
  from: "metric" | "dataset";
}

export interface Listed {
  id: string;
  name: string;
}

export interface MetricListed extends Listed {
  updated_at: string;
  body: MetricDefinition;
}

export interface WidgetListed extends Listed {
  updated_at: string;
  body: Widget;
  metric_name: string | null;
}

export interface DatasetListed extends Listed {
  title: string | null;
  fields: number;
  updated_at: string;
}

export type DashboardAccess = "owner" | "editor" | "viewer" | "ownerless";

export type FolderAccess = "owner" | "editor" | "viewer" | "ownerless";

export type DashboardVisibility = "private" | "people" | "everyone";

export interface DashboardListed extends Listed {
  owner_person_id: string | null;
  owner_name?: string | null;
  access: DashboardAccess;
  updated_at?: string;
  visibility?: DashboardVisibility;
  title?: string | null;
  tags?: string[];
}

export interface ListedPage<T extends Listed = Listed> {
  items: T[];
  total: number;
}

export interface DefinitionResponse<T> {
  id: string;
  name: string;
  body: T;
  clock?: EffectiveClock;
  tags?: string[];
  updated_at?: string;
  access?: DashboardAccess;
}

export interface DashboardResponse extends DefinitionResponse<Dashboard> {
  owner_person_id: string | null;
  owner_name?: string | null;
  access: DashboardAccess;
  visibility?: DashboardVisibility;
  folders?: Folder[];
  carries?: boolean;
}

export interface DashboardRead {
  name: string;
  body: Dashboard;
  tags: string[];
  updatedAt?: string;
  ownerPersonId: string | null;
  ownerName: string | null;
  access: DashboardAccess;
  visibility: DashboardVisibility | null;
  folders: Folder[];
  carries: boolean;
}

export interface DashboardWidget {
  id: string;
  name: string;
  body: Widget;
  clock?: EffectiveClock | null;
  percents?: string[];
}

export type GrantLevel = "viewer" | "editor";

export type Grantee = string;

export interface Grant {
  grantee: Grantee;
  level: GrantLevel;
  granted_by: string;
  created_at: string;
}

export interface OrphanedDashboard extends Listed {
  owner_person_id: string;
  updated_at: string;
}

export interface OrphanedFolder extends Listed {
  owner_person_id: string;
  updated_at: string;
}

export interface TagSummary {
  name: string;
  dashboards: number;
}

export interface TagList {
  tags: TagSummary[];
}

export interface Folder {
  id: string;
  name: string;
}

export interface FolderSummary extends Folder {
  owner_person_id: string | null;
  access: FolderAccess;
  dashboards: number;
}

export interface FolderList {
  folders: FolderSummary[];
  unfiled: number;
}

export interface PinList {
  pins: Listed[];
}

export type FolderFilter = string;

export interface StoredMetric {
  name: string;
  definition: MetricDefinition;
  clock?: EffectiveClock;
}

export interface StoredWidget {
  name: string;
  widget: Widget;
}

export type FieldType = "string" | "int" | "float" | "bool" | "datetime";

export type FieldRole = "dimension" | "measurable" | "time";

export interface DeclaredField {
  name: string;
  path: string;
  type: FieldType;
  role?: FieldRole;
  description?: string;
  absent_value?: string;
  person?: "email" | "id";
  default_clock?: boolean;
}

export interface DatasetDeclaration {
  title: string;
  description?: string;
  fields: DeclaredField[];
  row_identity?: string[];
}

export interface Dataset {
  name: string;
  declaration: DatasetDeclaration;
}

export interface DatasetRecord {
  id: string;
  received_at: string;
  raw_data: unknown;
}

export interface Holder extends Listed {
  kind: "metrics" | "widgets" | "dashboards";
}

export interface Dependents {
  holders: Holder[];
  hidden: number;
}

export interface RecordPage {
  limit?: number;
  offset?: number;
  orderBy?: string;
  descending?: boolean;
}

export interface DatasetRecords {
  records: DatasetRecord[];
  total: number;
  limit: number;
}

export interface MetricResult {
  columns: string[];
  rows: unknown[][];
  percents?: string[];
}

export type DrilldownSort = MetricEvidenceSort;

export interface DrilldownRequest {
  range?: string;
  bucket?: boolean;
  sort?: DrilldownSort;
  limit?: number;
  cursor?: string;
}

export interface DrilldownColumn extends MetricEvidenceColumn {
  sortable: boolean;
  percent: boolean;
  exact: boolean;
}

export type DrilldownRow = Pick<MetricEvidenceRow, "values">;

export interface DrilldownPage {
  selection: {
    metric: string;
    range?: string;
    bucket?: boolean;
    sort: DrilldownSort;
  };
  columns: DrilldownColumn[];
  rows: DrilldownRow[];
  next_cursor: string | null;
}

export type DashboardItem =
  { widget: string } | { heading: string } | { text: string };

export interface Dashboard {
  title: string;
  items?: DashboardItem[];
  widgets?: string[];
  time_ranges?: string[];
  default_range?: string;
}

export interface ChatCreated {
  metric?: Listed | null;
  widgets: Listed[];
  dashboard?: Listed | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  reply: string;
  result?: MetricResult;
  created?: ChatCreated;
  updated?: ChatCreated;
}
