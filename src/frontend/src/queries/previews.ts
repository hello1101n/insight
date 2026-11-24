import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  createExperiment,
  deleteExperiment,
  listExperiments,
  listImages,
  type CreateExperimentRequest,
  type Experiment,
  type ExperimentListResponse,
  type ImageListResponse,
} from "@/api/previews-client";
import { useAuth } from "@/auth/use-auth";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import type { Session } from "@/auth/types";

export const PREVIEWS_MANAGE_ROLES = ["previews-admin", "admin"] as const;

const EXPERIMENTS_STALE_TIME = 30 * 1000;

export function canManagePreviews(session: Session | null): boolean {
  if (!session?.experimentsEnabled) return false;
  return session.roles.some((role) =>
    (PREVIEWS_MANAGE_ROLES as readonly string[]).includes(role)
  );
}

export function usePreviewsGate(): boolean {
  const { session } = useAuth();
  return canManagePreviews(session);
}

export function useExperiments(): UseQueryResult<ExperimentListResponse> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: ["previews", "experiments", sessionScope],
    queryFn: listExperiments,
    staleTime: EXPERIMENTS_STALE_TIME,
    enabled: sessionScope != null,
  });
}

const IMAGES_STALE_TIME = 5 * 60 * 1000;

export function useImages(): UseQueryResult<ImageListResponse> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: ["previews", "images", sessionScope],
    queryFn: listImages,
    staleTime: IMAGES_STALE_TIME,
    retry: false,
    enabled: sessionScope != null,
  });
}

const PREVIEWS_KEY = ["previews"] as const;

export function useCreateExperiment(): UseMutationResult<
  Experiment,
  unknown,
  CreateExperimentRequest
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createExperiment,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: PREVIEWS_KEY });
    },
  });
}

export function useDeleteExperiment(): UseMutationResult<
  void,
  unknown,
  string
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteExperiment,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: PREVIEWS_KEY });
    },
  });
}
