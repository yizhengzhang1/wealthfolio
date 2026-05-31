import type {
  StrategyOverride,
  NewStrategyOverride,
  UpdateStrategyOverride,
} from "@/lib/types";

import { invoke, logger } from "./platform";

export const getOptionStrategyOverrides = async (
  accountIds: string[],
): Promise<StrategyOverride[]> => {
  try {
    return await invoke<StrategyOverride[]>("get_option_strategy_overrides", { accountIds });
  } catch (error) {
    logger.error("Error fetching option strategy overrides.");
    throw error;
  }
};

export const createOptionStrategyOverride = async (
  payload: NewStrategyOverride,
): Promise<StrategyOverride> => {
  try {
    return await invoke<StrategyOverride>("create_option_strategy_override", { payload });
  } catch (error) {
    logger.error("Error creating option strategy override.");
    throw error;
  }
};

export const updateOptionStrategyOverride = async (
  id: string,
  payload: UpdateStrategyOverride,
): Promise<StrategyOverride> => {
  try {
    return await invoke<StrategyOverride>("update_option_strategy_override", { id, payload });
  } catch (error) {
    logger.error("Error updating option strategy override.");
    throw error;
  }
};

export const deleteOptionStrategyOverride = async (id: string): Promise<void> => {
  try {
    await invoke<void>("delete_option_strategy_override", { id });
  } catch (error) {
    logger.error("Error deleting option strategy override.");
    throw error;
  }
};
