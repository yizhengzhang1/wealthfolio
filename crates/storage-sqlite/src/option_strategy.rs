//! SQLite repository for option-strategy override rows.

use async_trait::async_trait;
use chrono::Utc;
use diesel::prelude::*;
use std::sync::Arc;
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;

use wealthfolio_core::errors::{DatabaseError, Error, Result};
use wealthfolio_core::option_strategy::{
    NewStrategyOverride, OptionStrategyRepository, OverrideMode, StrategyOverride,
    UpdateStrategyOverride,
};

// ── Diesel model ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = crate::schema::option_strategy_overrides)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct StrategyOverrideDB {
    id: String,
    account_id: String,
    underlying: String,
    name: Option<String>,
    strategy_type: Option<String>,
    /// JSON array of OCC leg symbols.
    legs: String,
    /// "group" | "exclude"
    mode: String,
    created_at: String,
    updated_at: String,
}

fn mode_to_str(mode: OverrideMode) -> &'static str {
    match mode {
        OverrideMode::Group => "group",
        OverrideMode::Exclude => "exclude",
    }
}

fn mode_from_str(s: &str) -> OverrideMode {
    match s {
        "exclude" => OverrideMode::Exclude,
        // Default to Group for unknown/legacy values.
        _ => OverrideMode::Group,
    }
}

fn legs_to_json(legs: &[String]) -> String {
    serde_json::to_string(legs).unwrap_or_else(|_| "[]".to_string())
}

fn legs_from_json(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

impl From<StrategyOverrideDB> for StrategyOverride {
    fn from(r: StrategyOverrideDB) -> Self {
        StrategyOverride {
            legs: legs_from_json(&r.legs),
            mode: mode_from_str(&r.mode),
            id: r.id,
            account_id: r.account_id,
            underlying: r.underlying,
            name: r.name,
            strategy_type: r.strategy_type,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

// ── Repository ──────────────────────────────────────────────────────────────

pub struct OptionStrategySqliteRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl OptionStrategySqliteRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl OptionStrategyRepository for OptionStrategySqliteRepository {
    fn list_for_accounts(&self, account_ids: &[String]) -> Result<Vec<StrategyOverride>> {
        use crate::schema::option_strategy_overrides::dsl;

        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let account_ids: Vec<String> = account_ids.to_vec();
        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<StrategyOverrideDB> = dsl::option_strategy_overrides
            .filter(dsl::account_id.eq_any(&account_ids))
            .order(dsl::created_at.asc())
            .select(StrategyOverrideDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(StrategyOverride::from).collect())
    }

    async fn create(&self, payload: &NewStrategyOverride) -> Result<StrategyOverride> {
        use crate::schema::option_strategy_overrides::dsl;

        let now = Utc::now().to_rfc3339();
        let row = StrategyOverrideDB {
            id: Uuid::new_v4().to_string(),
            account_id: payload.account_id.clone(),
            underlying: payload.underlying.clone(),
            name: payload.name.clone(),
            strategy_type: payload.strategy_type.clone(),
            legs: legs_to_json(&payload.legs),
            mode: mode_to_str(payload.mode).to_string(),
            created_at: now.clone(),
            updated_at: now,
        };

        let row_clone = row.clone();
        self.writer
            .exec(move |conn| {
                diesel::insert_into(dsl::option_strategy_overrides)
                    .values(&row_clone)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await?;

        Ok(StrategyOverride::from(row))
    }

    async fn update(
        &self,
        id: &str,
        payload: &UpdateStrategyOverride,
    ) -> Result<StrategyOverride> {
        use crate::schema::option_strategy_overrides::dsl;

        let id = id.to_string();
        let name = payload.name.clone();
        let strategy_type = payload.strategy_type.clone();
        let legs = payload.legs.as_ref().map(|l| legs_to_json(l));
        let mode = payload.mode.map(|m| mode_to_str(m).to_string());

        let updated_row: StrategyOverrideDB = self
            .writer
            .exec(move |conn| {
                let existing: StrategyOverrideDB = dsl::option_strategy_overrides
                    .filter(dsl::id.eq(&id))
                    .select(StrategyOverrideDB::as_select())
                    .first(conn)
                    .optional()
                    .map_err(StorageError::from)?
                    .ok_or_else(|| {
                        Error::Database(DatabaseError::NotFound(format!(
                            "Strategy override '{}' not found",
                            id
                        )))
                    })?;

                let new_name = name.or(existing.name);
                let new_strategy_type = strategy_type.or(existing.strategy_type);
                let new_legs = legs.unwrap_or(existing.legs);
                let new_mode = mode.unwrap_or(existing.mode);
                let now = Utc::now().to_rfc3339();

                diesel::update(dsl::option_strategy_overrides.filter(dsl::id.eq(&id)))
                    .set((
                        dsl::name.eq(&new_name),
                        dsl::strategy_type.eq(&new_strategy_type),
                        dsl::legs.eq(&new_legs),
                        dsl::mode.eq(&new_mode),
                        dsl::updated_at.eq(&now),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                let reloaded: StrategyOverrideDB = dsl::option_strategy_overrides
                    .filter(dsl::id.eq(&id))
                    .select(StrategyOverrideDB::as_select())
                    .first(conn)
                    .map_err(StorageError::from)?;
                Ok(reloaded)
            })
            .await?;

        Ok(StrategyOverride::from(updated_row))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        use crate::schema::option_strategy_overrides::dsl;

        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(dsl::option_strategy_overrides.filter(dsl::id.eq(&id)))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};
    use diesel::r2d2::{ConnectionManager, Pool};
    use diesel::sqlite::SqliteConnection;
    use tempfile::tempdir;

    async fn setup() -> (
        OptionStrategySqliteRepository,
        Arc<Pool<ConnectionManager<SqliteConnection>>>,
        tempfile::TempDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = OptionStrategySqliteRepository::new(Arc::clone(&pool), writer);
        (repo, pool, dir)
    }

    fn new_override(account_id: &str, underlying: &str, legs: &[&str]) -> NewStrategyOverride {
        NewStrategyOverride {
            account_id: account_id.to_string(),
            underlying: underlying.to_string(),
            name: None,
            strategy_type: Some("vertical".to_string()),
            legs: legs.iter().map(|s| s.to_string()).collect(),
            mode: OverrideMode::Group,
        }
    }

    #[tokio::test]
    async fn create_then_list_round_trips_legs_and_mode() {
        let (repo, _pool, _dir) = setup().await;
        let created = repo
            .create(&new_override(
                "acc1",
                "AAPL",
                &["AAPL250117C00150000", "AAPL250117C00160000"],
            ))
            .await
            .unwrap();
        assert!(!created.id.is_empty());
        assert_eq!(created.legs.len(), 2);
        assert_eq!(created.mode, OverrideMode::Group);

        let listed = repo.list_for_accounts(&["acc1".to_string()]).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].underlying, "AAPL");
        assert_eq!(
            listed[0].legs,
            vec![
                "AAPL250117C00150000".to_string(),
                "AAPL250117C00160000".to_string()
            ]
        );
        assert_eq!(listed[0].strategy_type.as_deref(), Some("vertical"));
    }

    #[tokio::test]
    async fn list_filters_by_account() {
        let (repo, _pool, _dir) = setup().await;
        repo.create(&new_override("acc1", "AAPL", &["AAPL250117C00150000"]))
            .await
            .unwrap();
        repo.create(&new_override("acc2", "MSFT", &["MSFT250117P00300000"]))
            .await
            .unwrap();

        let acc1 = repo.list_for_accounts(&["acc1".to_string()]).unwrap();
        assert_eq!(acc1.len(), 1);
        assert_eq!(acc1[0].underlying, "AAPL");

        let both = repo
            .list_for_accounts(&["acc1".to_string(), "acc2".to_string()])
            .unwrap();
        assert_eq!(both.len(), 2);

        let none = repo.list_for_accounts(&[]).unwrap();
        assert_eq!(none.len(), 0);
    }

    #[tokio::test]
    async fn update_mutates_name_mode_and_legs() {
        let (repo, _pool, _dir) = setup().await;
        let created = repo
            .create(&new_override("acc1", "AAPL", &["AAPL250117C00150000"]))
            .await
            .unwrap();

        let updated = repo
            .update(
                &created.id,
                &UpdateStrategyOverride {
                    name: Some("Bull Call Spread".to_string()),
                    strategy_type: None,
                    legs: Some(vec![
                        "AAPL250117C00150000".to_string(),
                        "AAPL250117C00160000".to_string(),
                    ]),
                    mode: Some(OverrideMode::Exclude),
                },
            )
            .await
            .unwrap();

        assert_eq!(updated.name.as_deref(), Some("Bull Call Spread"));
        assert_eq!(updated.legs.len(), 2);
        assert_eq!(updated.mode, OverrideMode::Exclude);
        // strategy_type was None in the patch → preserved from the original.
        assert_eq!(updated.strategy_type.as_deref(), Some("vertical"));
    }

    #[tokio::test]
    async fn update_unknown_id_errors() {
        let (repo, _pool, _dir) = setup().await;
        let err = repo
            .update("nope", &UpdateStrategyOverride::default())
            .await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn delete_removes_row_and_is_idempotent() {
        let (repo, _pool, _dir) = setup().await;
        let created = repo
            .create(&new_override("acc1", "AAPL", &["AAPL250117C00150000"]))
            .await
            .unwrap();
        repo.delete(&created.id).await.unwrap();
        assert_eq!(repo.list_for_accounts(&["acc1".to_string()]).unwrap().len(), 0);
        // deleting again is Ok.
        repo.delete(&created.id).await.unwrap();
    }
}
