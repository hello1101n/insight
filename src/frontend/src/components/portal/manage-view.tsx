import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { ConnectorHealthPane } from "@/components/portal/connector-health";
import { IdentitiesView } from "@/components/portal/identities-view";
import { IngestionView } from "@/components/portal/ingestion-view";
import { PlatformUsage } from "@/components/portal/platform-usage";
import { useIsAdmin } from "@/queries/identity-me";
import { AiAssistantBody } from "@/screens/ai-assistant";
import { PreviewsBody } from "@/screens/previews";
import { WhatsNewBody } from "@/screens/whats-new";

export function ManageView({
  item,
  mode,
  connector,
}: {
  item: string | null;
  mode?: string;
  connector?: string;
}) {
  if (item === "connector-health")
    return (
      <AdminGate>
        <ConnectorHealthPane />
      </AdminGate>
    );
  if (item === "identities")
    return (
      <AdminGate>
        <IdentitiesView mode={mode} />
      </AdminGate>
    );
  if (item === "platform-usage")
    return (
      <AdminGate>
        <PlatformUsage />
      </AdminGate>
    );
  if (item === "ingestion")
    return (
      <AdminGate>
        <IngestionView connector={connector} />
      </AdminGate>
    );
  if (item === "ai-assistant") return <AiAssistantBody />;
  if (item === "whats-new") return <WhatsNewBody />;
  if (item === "previews") return <PreviewsBody />;
  return (
    <div className="mx-auto w-full max-w-md p-8">
      <ComingSoon variant="card" state="empty" label="Not built yet" />
    </div>
  );
}

function AdminGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { isAdmin, isPending, isError, retry } = useIsAdmin();
  if (isPending) return <CenteredSpinner />;
  if (isError) {
    return (
      <div className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="error"
          label={t("identities.gate.unverified")}
          onRetry={retry}
        />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="mx-auto w-full max-w-md p-8" role="alert">
        <div className="rounded-lg border p-6 text-center">
          <p className="text-sm font-semibold">{t("identities.gate.title")}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("identities.gate.description")}
          </p>
        </div>
      </div>
    );
  }
  return children;
}
