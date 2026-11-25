import { createFileRoute } from "@tanstack/react-router";
import {
  ChartArea,
  ChartColumn,
  ChartLine,
  ChartPie,
  Hash,
  LayoutGrid,
  Table2,
} from "lucide-react";

import type { Widget, WidgetListed } from "@/api/custom-client";
import { CatalogueCard } from "@/components/custom/catalogue-card";
import { DefinitionList } from "@/components/custom/definition-list";
import { NewLink } from "@/components/custom/editor/edit-link";
import { useDefinitionCatalogue } from "@/hooks/use-definition-catalogue";
import { useAssistantAvailable } from "@/lib/portal/use-assistant-available";

export const Route = createFileRoute("/_shell/dashboards/widgets/")({
  component: WidgetsCatalogue,
});

interface Kind {
  label: string;
  icon: typeof Hash;
}

const KIND: Record<Widget["type"], Kind> = {
  table: { label: "Table", icon: Table2 },
  line: { label: "Line chart", icon: ChartLine },
  bar: { label: "Bar chart", icon: ChartColumn },
  area: { label: "Area chart", icon: ChartArea },
  stat: { label: "Figure", icon: Hash },
  pie: { label: "Pie chart", icon: ChartPie },
};

function kindOf(type: string): Kind {
  const known: Partial<Record<string, Kind>> = KIND;

  return known[type] ?? { label: type, icon: LayoutGrid };
}

function WidgetsCatalogue() {
  const catalogue = useDefinitionCatalogue("widgets");
  const assistant = useAssistantAvailable();

  return (
    <DefinitionList
      data-testid="page-custom-widgets"
      title="Widgets"
      items={catalogue.items}
      isLoading={catalogue.isLoading}
      isError={catalogue.isError}
      onRetry={catalogue.refetch}
      search={{ label: "Search widgets", ...catalogue.search }}
      paging={catalogue.paging}
      create={<NewLink kind="widgets" noun="widget" />}
      empty={{
        icon: LayoutGrid,
        title: "No widgets yet",
        description: assistant ? "Ask the assistant for one." : undefined,
      }}
      renderRow={(item) => <WidgetCard item={item} />}
    />
  );
}

function WidgetCard({ item }: { item: WidgetListed }) {
  const kind = kindOf(item.body.type);

  return (
    <CatalogueCard
      kind="widgets"
      id={item.id}
      name={item.name}
      title={item.body.title || item.name}
      icon={kind.icon}
      facts={[kind.label, item.metric_name ?? "Missing metric"]}
      truncatedFactIndex={1}
      updatedAt={item.updated_at}
    />
  );
}
