import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DomainLensView, Pending } from "@/components/portal/domain-lens-view";
import { resolveText } from "@/i18n/localized-text";
import { TenantLensView } from "@/components/portal/tenant-lens-view";
import { directionMetricKeys, lensEntry } from "@/lib/portal/lens-configs";
import { DIRECTIONS, lensSlug } from "@/lib/portal/nav-model";

export function DirectionView({ dir, lens }: { dir: string; lens: string }) {
  const { t } = useTranslation();
  const entry = lensEntry(dir, lens);
  const direction = DIRECTIONS.find((d) => d.id === dir);
  const gridKeys = useMemo(() => directionMetricKeys(dir), [dir]);
  if (!direction) {
    return <Pending label={t("directions.pick")} />;
  }
  if (!entry) {
    return (
      <Pending
        label={t("directions.unknown_lens", {
          lens,
          direction: resolveText(t, direction.name),
        })}
      />
    );
  }
  if ("comingSoon" in entry) return <Pending label={entry.comingSoon} />;

  const testId = `page-directions-${dir}-${lensSlug(lens)}`;

  if ("entity" in entry) return <TenantLensView config={entry} data-testid={testId} />;
  return <DomainLensView config={entry} gridKeys={gridKeys} data-testid={testId} />;
}
