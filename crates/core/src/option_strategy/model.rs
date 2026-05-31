use serde::{Deserialize, Serialize};

/// Whether an override explicitly groups legs into a strategy, or forces them
/// to stay loose (excluded from auto-detection). Matches the frontend
/// `StrategyOverride.mode` union 'group' | 'exclude'.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverrideMode {
    Group,
    Exclude,
}

/// A persisted user override for option-strategy grouping (spec 4.2).
///
/// The detection algorithm runs live on the frontend; only user edits are
/// stored here. `legs` holds the OCC symbols of the member legs (stock legs
/// use their bare ticker). `strategy_type` mirrors the frontend `StrategyType`
/// union and is opaque to the backend (stored/returned as-is).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyOverride {
    pub id: String,
    pub account_id: String,
    pub underlying: String,
    pub name: Option<String>,
    pub strategy_type: Option<String>,
    pub legs: Vec<String>,
    pub mode: OverrideMode,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for creating a new override. `id`/timestamps are assigned by the
/// service.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewStrategyOverride {
    pub account_id: String,
    pub underlying: String,
    pub name: Option<String>,
    pub strategy_type: Option<String>,
    pub legs: Vec<String>,
    pub mode: OverrideMode,
}

/// Payload for updating an existing override. Only `name`, `strategy_type`,
/// `legs`, and `mode` are mutable. Each field is optional (partial update).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStrategyOverride {
    pub name: Option<String>,
    pub strategy_type: Option<String>,
    pub legs: Option<Vec<String>>,
    pub mode: Option<OverrideMode>,
}
