import { useTranslation } from "react-i18next";

export function ConnectorScheduleDetails({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer">
        {t("common.actions.details")}
      </summary>
      <p className="mt-1">{text}</p>
    </details>
  );
}
