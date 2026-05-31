use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use std::sync::Arc;
use wealthfolio_core::option_strategy::{
    NewStrategyOverride, StrategyOverride, UpdateStrategyOverride,
};

use crate::error::ApiResult;
use crate::main_lib::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/option-strategy-overrides", get(get_option_strategy_overrides))
        .route("/option-strategy-overrides", post(create_option_strategy_override))
        .route(
            "/option-strategy-overrides/{id}",
            put(update_option_strategy_override),
        )
        .route(
            "/option-strategy-overrides/{id}",
            delete(delete_option_strategy_override),
        )
}

async fn get_option_strategy_overrides(
    State(state): State<Arc<AppState>>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<Vec<StrategyOverride>>> {
    let account_ids: Vec<String> = raw
        .as_deref()
        .map(|q| {
            q.split('&')
                .filter_map(|p| p.strip_prefix("accountIds="))
                .map(|v| v.to_string())
                .collect()
        })
        .unwrap_or_default();
    let overrides = state
        .option_strategy_service
        .list_for_accounts(&account_ids)?;
    Ok(Json(overrides))
}

async fn create_option_strategy_override(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewStrategyOverride>,
) -> ApiResult<Json<StrategyOverride>> {
    let created = state.option_strategy_service.create(payload).await?;
    Ok(Json(created))
}

async fn update_option_strategy_override(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateStrategyOverride>,
) -> ApiResult<Json<StrategyOverride>> {
    let updated = state.option_strategy_service.update(&id, payload).await?;
    Ok(Json(updated))
}

async fn delete_option_strategy_override(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.option_strategy_service.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
