import { CustomApiError } from "@/api/custom-client";

interface FieldViolation {
  field?: string;
  description?: string;
}

interface PreconditionViolation {
  subject?: string;
  description?: string;
}

interface Refusal {
  detail?: string;
  context?: {
    field_violations?: FieldViolation[];
    violations?: PreconditionViolation[];
  };
}

function named(about: string, said: string): string {
  return about === "" ? said : `${about}: ${said}`;
}

export function refusals(error: unknown, fallback: string): string[] {
  if (error === undefined || error === null) return [];
  if (!(error instanceof CustomApiError)) return [fallback];

  const body = error.body as Refusal | null;
  const fields = (body?.context?.field_violations ?? []).map((violation) => ({
    about: violation.field ?? "",
    said: violation.description ?? "",
  }));
  const preconditions = (body?.context?.violations ?? []).map((violation) => ({
    about: violation.subject ?? "",
    said: violation.description ?? "",
  }));

  const said = [...fields, ...preconditions]
    .filter((one) => one.said !== "")
    .map((one) => named(one.about, one.said));

  return said.length > 0 ? said : [body?.detail ?? fallback];
}
