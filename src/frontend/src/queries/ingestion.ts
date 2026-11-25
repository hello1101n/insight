import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  getIngestionIntensity,
  type IngestionIntensity,
  type IngestionIntensityRequest,
} from "@/api/ingestion-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";

export function useIngestionIntensity(
  req: IngestionIntensityRequest,
  opts?: { refetchInterval?: number },
): UseQueryResult<IngestionIntensity> {
  const { session } = useAuth();
  return useQuery({
    queryKey: [
      "ingestion",
      "intensity",
      sessionAuthorizationScope(session),
      req.grain,
      req.series ?? "",
      req.scope ?? "",
      req.from ?? "",
      req.to ?? "",
      req.lookbackDays ?? "",
    ],
    queryFn: () => getIngestionIntensity(req),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: opts?.refetchInterval,
  });
}
