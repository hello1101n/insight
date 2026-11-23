import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth";
import { FullScreenLoading } from "@/components/full-screen-loading";

type AuthGateProps = {
  children: React.ReactNode;
};

export function AuthGate({ children }: AuthGateProps): React.ReactNode {
  const { t } = useTranslation();
  const { status } = useAuth();

  if (status !== "authenticated") {
    return <FullScreenLoading message={t("auth.redirecting")} />;
  }
  return children;
}
