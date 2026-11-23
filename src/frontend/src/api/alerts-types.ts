export type ComparisonOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";

export type NumberOperator = ComparisonOperator | "between";

export type TextOperator =
  "==" | "!=" | "contains" | "starts_with" | "ends_with" | "in" | "not_in";

export type DateOperator =
  "before" | "after" | "between" | "older_than" | "newer_than";

export type ConditionOperator = NumberOperator | TextOperator | DateOperator;

export type Quantifier =
  | "one"
  | "any"
  | "all"
  | "none"
  | { count: { op: ComparisonOperator; value: number } };

export interface ConditionLeaf {
  column: string;
  op: ConditionOperator;
  value: unknown;
}

export type ConditionNode =
  | ConditionLeaf
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode };

export interface Condition {
  rows: Quantifier;
  where: ConditionNode;
}

export interface Witness {
  matched: number;
  answered: number;
  columns: string[];
  rows: unknown[][];
}

export type AlertOutcome = "breach" | "no_breach" | "unknown";

export type UnknownReason =
  | "no_rows"
  | "many_rows"
  | "column_missing"
  | "null"
  | "non_numeric"
  | "non_text"
  | "non_date"
  | "incomparable"
  | "row_limit"
  | "metric_missing"
  | "compile_failed"
  | "run_failed"
  | "timeout";

export type NotificationStatus = "pending" | "cancelled" | "sent" | "failed";

export type IntegerDigits = string & { readonly __integerDigits: true };

export type AlertNumber = number | IntegerDigits;

export interface AlertDraft {
  name: string;
  metric: string;
  condition: Condition;
  context_columns: string[];
  range?: string | null;
  interval_secs: number;
  destination: string;
  enabled: boolean;
  expected_revision?: number;
}

export interface AlertState {
  last_evaluated_at?: string;
  last_outcome?: AlertOutcome;
  last_reason?: UnknownReason;
  last_witness?: Witness | null;
  last_valid_breached?: boolean;
  breached_since?: string;
}

export interface Alert {
  id: string;
  name: string;
  metric: string;
  condition: Condition;
  context_columns: string[];
  range?: string | null;
  interval_secs: number;
  destination: string;
  enabled: boolean;
  revision: number;
  state: AlertState;
  created_at: string;
  updated_at: string;
}

export interface AlertSummary {
  id: string;
  name: string;
  metric: string;
  enabled: boolean;
}

export interface AlertPage {
  alerts: AlertSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AlertNotification {
  id: string;
  rule_revision: number;
  metric: string;
  metric_name: string | null;
  condition: Condition;
  context_columns: string[];
  witness?: Witness | null;
  evaluated_at: string;
  destination: string;
  status: NotificationStatus;
  attempts: number;
  last_error?: string | null;
  provider_receipt?: string | null;
  created_at: string;
}

export interface NotificationPage {
  notifications: AlertNotification[];
  limit: number;
  offset: number;
}

export interface AlertDestination {
  name: string;
  provider: string;
}

export interface AlertPreviewRequest {
  metric: string;
  range: string | null;
  condition: Condition;
  context_columns: string[];
}

export interface AlertPreview {
  outcome: AlertOutcome;
  reason: UnknownReason | null;
  witness: Witness | null;
}
