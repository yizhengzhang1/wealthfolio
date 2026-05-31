use async_trait::async_trait;

use crate::errors::Result;

use super::model::{NewStrategyOverride, StrategyOverride, UpdateStrategyOverride};

/// Repository trait for option-strategy override persistence.
///
/// Read methods are synchronous (shared connection pool); write methods are
/// async because they go through the serialised `WriteHandle`. Mirrors the
/// `CustomProviderRepository` split.
#[async_trait]
pub trait OptionStrategyRepository: Send + Sync {
    /// List all overrides for the given account ids, ordered by created_at.
    /// An empty `account_ids` slice returns an empty Vec.
    fn list_for_accounts(&self, account_ids: &[String]) -> Result<Vec<StrategyOverride>>;

    /// Create a new override. Returns the created record (with assigned id +
    /// timestamps).
    async fn create(&self, payload: &NewStrategyOverride) -> Result<StrategyOverride>;

    /// Update an existing override by id. Returns the updated record. Errors
    /// with `NotFound` if the id does not exist.
    async fn update(&self, id: &str, payload: &UpdateStrategyOverride) -> Result<StrategyOverride>;

    /// Delete an override by id. Idempotent — deleting a missing id is Ok(()).
    async fn delete(&self, id: &str) -> Result<()>;
}
