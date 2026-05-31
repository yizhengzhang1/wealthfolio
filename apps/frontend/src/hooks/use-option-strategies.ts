import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getOptionStrategyOverrides,
  createOptionStrategyOverride,
  updateOptionStrategyOverride,
  deleteOptionStrategyOverride,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { NewStrategyOverride, UpdateStrategyOverride } from "@/lib/types";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function useOptionStrategies(accountIds: string[]) {
  return useQuery({
    queryKey: [QueryKeys.OPTION_STRATEGIES, accountIds],
    queryFn: () => getOptionStrategyOverrides(accountIds),
    enabled: accountIds.length > 0,
  });
}

export function useCreateOptionStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: NewStrategyOverride) => createOptionStrategyOverride(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OPTION_STRATEGIES] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create strategy group",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useUpdateOptionStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { id: string; payload: UpdateStrategyOverride }) =>
      updateOptionStrategyOverride(variables.id, variables.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OPTION_STRATEGIES] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update strategy group",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useDeleteOptionStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteOptionStrategyOverride(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OPTION_STRATEGIES] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to remove strategy group",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
