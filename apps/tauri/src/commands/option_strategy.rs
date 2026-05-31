use tauri::State;
use wealthfolio_core::option_strategy::{
    NewStrategyOverride, StrategyOverride, UpdateStrategyOverride,
};

use crate::context::ServiceContext;
use std::sync::Arc;

use super::error::CommandResult;

#[tauri::command]
pub async fn get_option_strategy_overrides(
    context: State<'_, Arc<ServiceContext>>,
    account_ids: Vec<String>,
) -> CommandResult<Vec<StrategyOverride>> {
    Ok(context
        .option_strategy_service
        .list_for_accounts(&account_ids)?)
}

#[tauri::command]
pub async fn create_option_strategy_override(
    context: State<'_, Arc<ServiceContext>>,
    payload: NewStrategyOverride,
) -> CommandResult<StrategyOverride> {
    Ok(context.option_strategy_service.create(payload).await?)
}

#[tauri::command]
pub async fn update_option_strategy_override(
    context: State<'_, Arc<ServiceContext>>,
    id: String,
    payload: UpdateStrategyOverride,
) -> CommandResult<StrategyOverride> {
    Ok(context
        .option_strategy_service
        .update(&id, payload)
        .await?)
}

#[tauri::command]
pub async fn delete_option_strategy_override(
    context: State<'_, Arc<ServiceContext>>,
    id: String,
) -> CommandResult<()> {
    Ok(context.option_strategy_service.delete(&id).await?)
}
