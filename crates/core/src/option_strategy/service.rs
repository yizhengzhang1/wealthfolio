use std::sync::Arc;

use log::info;

use crate::errors::{Result, ValidationError};

use super::model::{NewStrategyOverride, StrategyOverride, UpdateStrategyOverride};
use super::store::OptionStrategyRepository;

pub struct OptionStrategyService {
    repo: Arc<dyn OptionStrategyRepository>,
}

impl OptionStrategyService {
    pub fn new(repo: Arc<dyn OptionStrategyRepository>) -> Self {
        Self { repo }
    }

    /// List overrides for the given account ids.
    pub fn list_for_accounts(&self, account_ids: &[String]) -> Result<Vec<StrategyOverride>> {
        self.repo.list_for_accounts(account_ids)
    }

    /// Create a new override.
    pub async fn create(&self, payload: NewStrategyOverride) -> Result<StrategyOverride> {
        if payload.account_id.trim().is_empty() {
            return Err(ValidationError::InvalidInput("accountId cannot be empty".into()).into());
        }
        if payload.underlying.trim().is_empty() {
            return Err(ValidationError::InvalidInput("underlying cannot be empty".into()).into());
        }
        if payload.legs.is_empty() {
            return Err(ValidationError::InvalidInput("legs cannot be empty".into()).into());
        }
        let created = self.repo.create(&payload).await?;
        info!("Created option strategy override: {}", created.id);
        Ok(created)
    }

    /// Update an existing override by id.
    pub async fn update(
        &self,
        id: &str,
        payload: UpdateStrategyOverride,
    ) -> Result<StrategyOverride> {
        if let Some(legs) = &payload.legs {
            if legs.is_empty() {
                return Err(
                    ValidationError::InvalidInput("legs cannot be empty".into()).into(),
                );
            }
        }
        let updated = self.repo.update(id, &payload).await?;
        info!("Updated option strategy override: {}", id);
        Ok(updated)
    }

    /// Delete an override by id.
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.repo.delete(id).await?;
        info!("Deleted option strategy override: {}", id);
        Ok(())
    }
}
