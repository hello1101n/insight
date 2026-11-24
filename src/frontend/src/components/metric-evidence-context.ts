import { createContext, useContext } from "react";

import type { MetricEvidenceSelection } from "@/api/metric-drilldown-client";

export interface EvidenceDialogTarget {
  selection: MetricEvidenceSelection;
  label: string;
}

export interface EvidencePersonRow {
  entityId: string;
  personId: string | null;
  name: string;
  value: number;
  valueText: string;
  target: EvidenceDialogTarget | null;
}

export interface EvidencePeopleView {
  title: string;
  metricKey: string;
  valueLabel: string;
  rows: readonly EvidencePersonRow[];
  allRecords: EvidenceDialogTarget | null;
}

export type EvidenceDialogState =
  | {
      kind: "records";
      targets: readonly [EvidenceDialogTarget, ...EvidenceDialogTarget[]];
      activeMetricKey: string;
      title?: string;
    }
  | { kind: "people"; view: EvidencePeopleView };

export interface EvidenceDialogOptions {
  title?: string;
  activeMetricKey?: string;
}

export interface EvidenceDialogContextValue {
  openEvidence: (selection: MetricEvidenceSelection, label: string) => void;
  openEvidenceTargets: (
    targets: readonly EvidenceDialogTarget[],
    options?: EvidenceDialogOptions
  ) => void;
  openEvidencePeople: (view: EvidencePeopleView) => void;
}

export const EvidenceScopeContext = createContext<
  readonly EvidenceDialogTarget[]
>([]);

export function useEvidenceScope(): readonly EvidenceDialogTarget[] {
  return useContext(EvidenceScopeContext);
}

export function withOwnTarget(
  scope: readonly EvidenceDialogTarget[],
  own: EvidenceDialogTarget
): EvidenceDialogTarget[] {
  const key = own.selection.metric_key;
  return scope.some((target) => target.selection.metric_key === key)
    ? scope.map((target) =>
        target.selection.metric_key === key ? own : target
      )
    : [own, ...scope];
}

export const EvidenceDialogContext = createContext<
  EvidenceDialogContextValue | undefined
>(undefined);

export function useMetricEvidence(): EvidenceDialogContextValue {
  const context = useContext(EvidenceDialogContext);
  if (!context) {
    throw new Error(
      "useMetricEvidence must be used within MetricEvidenceDialogProvider"
    );
  }
  return context;
}

export function useMetricEvidenceOptional():
  | EvidenceDialogContextValue
  | undefined {
  return useContext(EvidenceDialogContext);
}
