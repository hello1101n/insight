import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

export interface PersonCoverageProps {
  unmeasured: string[];
  inactive: string[];
}

function list(titles: string[], t: TFunction): string {
  if (titles.length < 2) return titles[0] ?? "";
  if (titles.length === 2) {
    return t("people.section.list_pair", { left: titles[0], right: titles[1] });
  }
  return t("people.section.list_many", {
    head: titles.slice(0, -1).join(", "),
    last: titles[titles.length - 1],
  });
}

export function PersonCoverage({ unmeasured, inactive }: PersonCoverageProps) {
  const { t } = useTranslation();
  if (unmeasured.length === 0 && inactive.length === 0) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {unmeasured.length > 0 ? (
        <>
          {t("people.section.coverage_unmeasured", { sections: list(unmeasured, t) })}{" "}
        </>
      ) : null}
      {inactive.length > 0 ? (
        <>{t("people.section.coverage_inactive", { sections: list(inactive, t) })}</>
      ) : null}
    </p>
  );
}
