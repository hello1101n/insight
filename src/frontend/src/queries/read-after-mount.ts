import type { UseQueryResult } from "@tanstack/react-query";

export function readAfterMount<T>(query: UseQueryResult<T>): T | undefined {
  return query.isFetchedAfterMount && query.isSuccess ? query.data : undefined;
}
