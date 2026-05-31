# Option Strategy Grouping — Backend Override Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist user "option strategy" overrides (group/exclude decisions over option legs) in a new SQLite table, exposed through a core service and dual-surface CRUD (Tauri commands + Axum HTTP) with a matching frontend data-access layer.

**Architecture:** A new `option_strategy_overrides` table (Diesel migration) backs a `wealthfolio-core` domain (`StrategyOverride` model + `OptionStrategyRepository` trait + `OptionStrategyService`). The storage-sqlite crate implements the trait (legs stored as JSON TEXT, writes via `WriteHandle::exec`, reads via `get_connection`). The service is wired into both runtimes (server `AppState`, tauri `ServiceContext`) and surfaced with four commands (`get_option_strategy_overrides` / `create_option_strategy_override` / `update_option_strategy_override` / `delete_option_strategy_override`). The frontend gets a typed adapter, react-query hooks, a query key, and the `StrategyOverride`/`StrategyType` TS types (consumed by later plans 2/3).

**Tech Stack:** Rust (Diesel + SQLite, Axum, Tauri, async-trait, tokio), TypeScript (React, @tanstack/react-query, vitest).

This plan covers ONLY backend override persistence + its frontend data-access layer (spec sections 4.2 and 6.1). The detection algorithm, group-by-underlying changes, and holdings-view rendering are plans 2 and 3. This plan DOES define the `StrategyOverride` and `StrategyType` TS types because plans 2/3 consume them.

---

## Conventions / template files to copy from

Cite these when you implement — copy the patterns exactly:

- Migration shape: `crates/storage-sqlite/migrations/2026-05-19-000001_lots_and_snapshot_positions/{up.sql,down.sql}` (table + index in up.sql; `DROP INDEX IF EXISTS` then `DROP TABLE IF EXISTS` in reverse order in down.sql).
- schema.rs `diesel::table!` block: `crates/storage-sqlite/src/schema.rs:318-338` (the `lots` block) + the `allow_tables_to_appear_in_same_query!` list at the file tail.
- core domain module layout: `crates/core/src/custom_provider/{mod.rs,model.rs,store.rs,service.rs}` (mod.rs re-exports; model = serde structs with `#[serde(rename_all = "camelCase")]`; store = `#[async_trait]` repository trait; service = thin wrapper holding `Arc<dyn Repo>`).
- core module declaration: `crates/core/src/lib.rs:7-29` (`pub mod custom_provider;`).
- storage repository: `crates/storage-sqlite/src/lots.rs` (Diesel record `#[derive(Queryable, Selectable, Insertable)]`, `WriteHandle::exec` for writes, `get_connection(&self.pool)` for reads, `#[cfg(test)] mod tests` with `setup()` using `run_migrations` + `create_pool` + `spawn_writer`).
- storage module declaration: `crates/storage-sqlite/src/lib.rs:33-49`.
- Tauri command: `apps/tauri/src/commands/custom_provider.rs` + `apps/tauri/src/commands/mod.rs:11` + `apps/tauri/src/lib.rs:780-784` (generate_handler region).
- Tauri context wiring: `apps/tauri/src/context/registry.rs:70` (struct field) + `apps/tauri/src/context/providers.rs:171-209` (build) + `:576` (struct literal field).
- Server API: `apps/server/src/api/custom_providers.rs` + `apps/server/src/api.rs:31` (mod) + `:117` (`.merge()`) + `apps/server/src/main_lib.rs:112` (struct field), `:340-363` (build), `:795` (struct literal field).
- Frontend adapter: `apps/frontend/src/adapters/shared/custom-provider.ts`; COMMANDS + switch `apps/frontend/src/adapters/web/core.ts:127-130` + `:858-876`; re-export `apps/frontend/src/adapters/tauri/index.ts:91-92` + `apps/frontend/src/adapters/web/index.ts:199-206`; hook `apps/frontend/src/hooks/use-custom-providers.ts`; query key `apps/frontend/src/lib/query-keys.ts:83`; parity test `apps/frontend/src/adapters/adapter-command-parity.test.ts`.

Build/test commands: `cargo test -p wealthfolio-core`, `cargo test -p wealthfolio-storage-sqlite`, `pnpm --filter frontend test`, `pnpm type-check`, `pnpm lint`.

---

## Task 1 — Diesel migration: `option_strategy_overrides` table

**Files:**
- Create `crates/storage-sqlite/migrations/2026-05-31-000001_option_strategy_overrides/up.sql`
- Create `crates/storage-sqlite/migrations/2026-05-31-000001_option_strategy_overrides/down.sql`
- Modify `crates/storage-sqlite/src/schema.rs` (add `diesel::table!` block after the `lots` block ~line 338; add `option_strategy_overrides,` to the `allow_tables_to_appear_in_same_query!` list at file tail)

Steps:

- [ ] Create `up.sql` with EXACTLY this DDL (verbatim from spec section 4.2):
  ```sql
  CREATE TABLE option_strategy_overrides (
    id           TEXT PRIMARY KEY NOT NULL,
    account_id   TEXT NOT NULL,
    underlying   TEXT NOT NULL,
    name         TEXT,
    strategy_type TEXT,
    legs         TEXT NOT NULL,    -- JSON 数组
    mode         TEXT NOT NULL,    -- 'group' | 'exclude'
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_option_strategy_overrides_account ON option_strategy_overrides(account_id);
  ```

- [ ] Create `down.sql` (reverse order — index first, then table):
  ```sql
  DROP INDEX IF EXISTS idx_option_strategy_overrides_account;
  DROP TABLE IF EXISTS option_strategy_overrides;
  ```

- [ ] Add the table to `crates/storage-sqlite/src/schema.rs` immediately after the `lots (id) { ... }` block (which ends at line 338). Insert this block (column types match the DDL: nullable for `name`/`strategy_type`):
  ```rust
  diesel::table! {
      option_strategy_overrides (id) {
          id -> Text,
          account_id -> Text,
          underlying -> Text,
          name -> Nullable<Text>,
          strategy_type -> Nullable<Text>,
          legs -> Text,
          mode -> Text,
          created_at -> Text,
          updated_at -> Text,
      }
  }
  ```

- [ ] In the same file, add `option_strategy_overrides,` to the `diesel::allow_tables_to_appear_in_same_query!` macro list at the tail of the file (alphabetical-ish; place it next to `market_data_providers,`). This is required for the schema to compile.

- [ ] Run `cargo build -p wealthfolio-storage-sqlite` — expected: compiles (no test yet). If it fails, the schema block is malformed.

- [ ] Commit:
  ```
  git add crates/storage-sqlite/migrations/2026-05-31-000001_option_strategy_overrides crates/storage-sqlite/src/schema.rs
  git commit -m "feat(storage): add option_strategy_overrides migration and schema

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 2 — core domain model (`StrategyOverride`, payloads, `OverrideMode`)

**Files:**
- Create `crates/core/src/option_strategy/mod.rs`
- Create `crates/core/src/option_strategy/model.rs`
- Modify `crates/core/src/lib.rs` (add `pub mod option_strategy;` in the module list, lines 7-29)

The model mirrors the frontend `StrategyOverride` shape (spec section 4.2). Field naming serializes to camelCase. `legs` is a `Vec<String>` of OCC symbols; `strategy_type` and `name` are optional. `mode` is `'group' | 'exclude'`.

Steps:

- [ ] Create `crates/core/src/option_strategy/model.rs` with the domain types. (No DB derives here — those live in storage-sqlite.) Write COMPLETE code:
  ```rust
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
  ```

- [ ] Create `crates/core/src/option_strategy/mod.rs`:
  ```rust
  pub mod model;
  pub mod service;
  pub mod store;

  pub use model::*;
  pub use service::OptionStrategyService;
  pub use store::OptionStrategyRepository;
  ```
  (Note: `service.rs` and `store.rs` are created in Tasks 3 and 4; mod.rs references them now so create those tasks before building this crate.)

- [ ] Add the module declaration to `crates/core/src/lib.rs` — insert `pub mod option_strategy;` between `pub mod lots;` (line 20) and `pub mod planning;` (line 21), keeping alphabetical order.

- [ ] (Do not build yet — `mod.rs` references `service`/`store` which Tasks 3-4 create. Build happens at end of Task 4.) Commit the model + module decl now:
  ```
  git add crates/core/src/option_strategy/model.rs crates/core/src/option_strategy/mod.rs crates/core/src/lib.rs
  git commit -m "feat(core): add option_strategy domain model and module decl

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 3 — core repository trait `OptionStrategyRepository`

**Files:**
- Create `crates/core/src/option_strategy/store.rs`

The trait mirrors `CustomProviderRepository` (sync reads, async writes). Spec section 4.2 names the methods: `list_for_accounts` / `create` / `update` / `delete`.

Steps:

- [ ] Create `crates/core/src/option_strategy/store.rs` with COMPLETE code:
  ```rust
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
  ```

- [ ] (Build deferred to Task 4 — `mod.rs` still references `service`.) No commit yet; bundled with Task 4's commit since the crate won't build until the service exists.

---

## Task 4 — core service `OptionStrategyService`

**Files:**
- Create `crates/core/src/option_strategy/service.rs`

A thin wrapper around the repository, mirroring `CustomProviderService::new(...)`. Validation: reject empty `account_id`/`underlying` and empty `legs` on create.

Steps:

- [ ] Create `crates/core/src/option_strategy/service.rs` with COMPLETE code:
  ```rust
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
  ```

- [ ] Run `cargo build -p wealthfolio-core` — expected: compiles cleanly (model + store + service + mod + lib all present now). If `ValidationError`/`Result` import errors, confirm `crate::errors::{Result, ValidationError}` exist (they do: `crates/core/src/errors.rs:174-179`).

- [ ] Commit the trait + service together:
  ```
  git add crates/core/src/option_strategy/store.rs crates/core/src/option_strategy/service.rs
  git commit -m "feat(core): add OptionStrategyRepository trait and OptionStrategyService

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 5 — storage-sqlite repository (TDD: failing test first)

**Files:**
- Create `crates/storage-sqlite/src/option_strategy.rs`
- Modify `crates/storage-sqlite/src/lib.rs` (add `pub mod option_strategy;` in the repository-impl list, after `pub mod market_data;` line 43)

The Diesel record uses `legs: String` (JSON TEXT). `mode` and `strategy_type` are TEXT; map `OverrideMode` to/from `"group"`/`"exclude"`. Writes via `WriteHandle::exec` (no sync outbox — overrides are local, like `lots.rs`), reads via `get_connection`. Copy the test-`setup()` harness from `lots.rs:920-933`.

Steps:

- [ ] Add `pub mod option_strategy;` to `crates/storage-sqlite/src/lib.rs` immediately after `pub mod market_data;` (line 43).

- [ ] Create `crates/storage-sqlite/src/option_strategy.rs` with the FULL implementation AND a failing-first test module. Write COMPLETE code:
  ```rust
  //! SQLite repository for option-strategy override rows.

  use async_trait::async_trait;
  use chrono::Utc;
  use diesel::prelude::*;
  use std::sync::Arc;
  use uuid::Uuid;

  use crate::db::{get_connection, DbPool, WriteHandle};
  use crate::errors::StorageError;

  use wealthfolio_core::errors::{Error, Result};
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
                          Error::NotFound(format!("Strategy override '{}' not found", id))
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

          let listed = repo
              .list_for_accounts(&["acc1".to_string()])
              .await_list();
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
  ```
  NOTE: the helper `.await_list()` in the first test is a deliberate typo to force a compile-fail (TDD red). The real method is synchronous `.unwrap()`. Fix it in the next step.

- [ ] Run `cargo test -p wealthfolio-storage-sqlite option_strategy` — expected: COMPILE FAIL on `.await_list()` (the deliberate red). This confirms the test file is wired in.

- [ ] Fix the red: replace `.await_list();` with `.unwrap();` in the `create_then_list_round_trips_legs_and_mode` test (`list_for_accounts` is synchronous, returns `Result<Vec<_>>`):
  ```rust
          let listed = repo.list_for_accounts(&["acc1".to_string()]).unwrap();
  ```

- [ ] Run `cargo test -p wealthfolio-storage-sqlite option_strategy` — expected: all 5 tests PASS.

- [ ] Commit:
  ```
  git add crates/storage-sqlite/src/option_strategy.rs crates/storage-sqlite/src/lib.rs
  git commit -m "feat(storage): implement OptionStrategySqliteRepository with tests

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 6 — wire service into Tauri `ServiceContext`

**Files:**
- Modify `apps/tauri/src/context/registry.rs` (add struct field next to `custom_provider_service`, ~line 70)
- Modify `apps/tauri/src/context/providers.rs` (build the repo + service ~line 209; add to struct literal ~line 576)

Steps:

- [ ] In `apps/tauri/src/context/registry.rs`, add a field to the `ServiceContext` struct immediately after the `custom_provider_service` field (line 70):
  ```rust
      pub option_strategy_service: Arc<wealthfolio_core::option_strategy::OptionStrategyService>,
  ```

- [ ] In `apps/tauri/src/context/providers.rs`, after the `custom_provider_service` build block (ends ~line 209), add the repository + service construction:
  ```rust
      // Option strategy override service
      let option_strategy_repository = Arc::new(
          wealthfolio_storage_sqlite::option_strategy::OptionStrategySqliteRepository::new(
              pool.clone(),
              writer.clone(),
          ),
      );
      let option_strategy_service = Arc::new(
          wealthfolio_core::option_strategy::OptionStrategyService::new(
              option_strategy_repository.clone(),
          ),
      );
  ```

- [ ] In the same file, add `option_strategy_service,` to the `ServiceContext { ... }` struct literal immediately after `custom_provider_service,` (line 576).

- [ ] Run `cargo build -p wealthfolio-tauri --lib` — expected: compiles (the command module from Task 7 isn't required for this to build, since `ServiceContext` just holds the service). If it fails on `pool`/`writer` not in scope, confirm those bindings exist earlier in `setup_services` (they do — used by `custom_provider_repository`).

- [ ] Commit:
  ```
  git add apps/tauri/src/context/registry.rs apps/tauri/src/context/providers.rs
  git commit -m "feat(tauri): wire OptionStrategyService into ServiceContext

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 7 — Tauri commands

**Files:**
- Create `apps/tauri/src/commands/option_strategy.rs`
- Modify `apps/tauri/src/commands/mod.rs` (add `pub mod option_strategy;` after `pub mod market_data;` line 21, keeping order)
- Modify `apps/tauri/src/lib.rs` (add four entries to `generate_handler!` after the custom provider block, line 784)

Command names MUST be EXACTLY (spec 6.1): `get_option_strategy_overrides`, `create_option_strategy_override`, `update_option_strategy_override`, `delete_option_strategy_override`.

Steps:

- [ ] Create `apps/tauri/src/commands/option_strategy.rs` with COMPLETE code (copy the `State<Arc<ServiceContext>>` + `CommandResult` shape from `commands/custom_provider.rs`):
  ```rust
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
  ```

- [ ] Add `pub mod option_strategy;` to `apps/tauri/src/commands/mod.rs` after `pub mod market_data;` (line 21).

- [ ] In `apps/tauri/src/lib.rs`, add the four commands to the `tauri::generate_handler![ ... ]` macro right after the custom provider block (`commands::custom_provider::test_custom_provider_source,` line 784):
  ```rust
              // Option strategy override commands
              commands::option_strategy::get_option_strategy_overrides,
              commands::option_strategy::create_option_strategy_override,
              commands::option_strategy::update_option_strategy_override,
              commands::option_strategy::delete_option_strategy_override,
  ```

- [ ] Run `cargo build -p wealthfolio-tauri --lib` — expected: compiles. If a `#[tauri::command]` macro errors on an arg type, confirm `NewStrategyOverride`/`UpdateStrategyOverride`/`StrategyOverride` derive `Serialize + Deserialize` (Task 2 did).

- [ ] Commit:
  ```
  git add apps/tauri/src/commands/option_strategy.rs apps/tauri/src/commands/mod.rs apps/tauri/src/lib.rs
  git commit -m "feat(tauri): add option strategy override commands

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 8 — wire service into server `AppState`

**Files:**
- Modify `apps/server/src/main_lib.rs` (struct field ~line 112; build ~line 363; struct literal ~line 795)

Steps:

- [ ] In `apps/server/src/main_lib.rs`, add a field to the `AppState` struct immediately after `custom_provider_service` (line 112):
  ```rust
      pub option_strategy_service: Arc<wealthfolio_core::option_strategy::OptionStrategyService>,
  ```

- [ ] After the `custom_provider_service` build block (ends ~line 363), add the repository + service construction:
  ```rust
      let option_strategy_repository = Arc::new(
          wealthfolio_storage_sqlite::option_strategy::OptionStrategySqliteRepository::new(
              pool.clone(),
              writer.clone(),
          ),
      );
      let option_strategy_service = Arc::new(
          wealthfolio_core::option_strategy::OptionStrategyService::new(
              option_strategy_repository.clone(),
          ),
      );
  ```

- [ ] Add `option_strategy_service,` to the `AppState { ... }` struct literal immediately after `custom_provider_service,` (line 795).

- [ ] Run `cargo build -p wealthfolio-server` — expected: compiles (the API module from Task 9 isn't needed for AppState to build). If `pool`/`writer` not in scope, confirm those bindings exist (they do — used by `custom_provider_repository`).

- [ ] Commit:
  ```
  git add apps/server/src/main_lib.rs
  git commit -m "feat(server): wire OptionStrategyService into AppState

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 9 — server Axum router

**Files:**
- Create `apps/server/src/api/option_strategy.rs`
- Modify `apps/server/src/api.rs` (add `mod option_strategy;` after `mod net_worth;` line 44, keeping order; add `.merge(option_strategy::router())` to the `protected_api` chain after `.merge(custom_providers::router())` line 117)

HTTP contract (spec 6.1): GET `/option-strategy-overrides?accountIds=...`, POST `/option-strategy-overrides`, PUT `/option-strategy-overrides/{id}`, DELETE `/option-strategy-overrides/{id}` → 204.

Steps:

- [ ] Create `apps/server/src/api/option_strategy.rs` with COMPLETE code (copy router/handler shape from `api/custom_providers.rs`; GET reads repeated `accountIds` query params):
  ```rust
  use axum::{
      extract::{Path, Query, State},
      routing::{delete, get, post, put},
      Json, Router,
  };
  use serde::Deserialize;
  use std::sync::Arc;
  use wealthfolio_core::option_strategy::{
      NewStrategyOverride, StrategyOverride, UpdateStrategyOverride,
  };

  use crate::error::ApiResult;
  use crate::main_lib::AppState;

  #[derive(Debug, Deserialize)]
  struct ListQuery {
      /// Repeated `accountIds` query params, e.g. ?accountIds=a&accountIds=b
      #[serde(default, rename = "accountIds")]
      account_ids: Vec<String>,
  }

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
      Query(query): Query<ListQuery>,
  ) -> ApiResult<Json<Vec<StrategyOverride>>> {
      let overrides = state
          .option_strategy_service
          .list_for_accounts(&query.account_ids)?;
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
  ) -> ApiResult<()> {
      state.option_strategy_service.delete(&id).await?;
      Ok(())
  }
  ```
  NOTE on `Query<Vec<String>>`: axum's default `Query` uses `serde_urlencoded`, which does NOT collect repeated keys into a `Vec`. The frontend (Task 11) sends `accountIds` as repeated params; to make `ListQuery.account_ids` populate, the GET handler must parse the raw query manually. Replace the `Query(query): Query<ListQuery>` extractor with `axum::extract::RawQuery` parsing in the next step — do NOT rely on the derived `Query<Vec>`.

- [ ] Fix the GET handler to robustly parse repeated `accountIds`. Replace the `ListQuery` struct + `get_option_strategy_overrides` handler with raw-query parsing:
  ```rust
  use axum::extract::RawQuery;

  async fn get_option_strategy_overrides(
      State(state): State<Arc<AppState>>,
      RawQuery(raw): RawQuery,
  ) -> ApiResult<Json<Vec<StrategyOverride>>> {
      let account_ids: Vec<String> = raw
          .as_deref()
          .map(|q| {
              url::form_urlencoded::parse(q.as_bytes())
                  .filter(|(k, _)| k == "accountIds")
                  .map(|(_, v)| v.into_owned())
                  .collect()
          })
          .unwrap_or_default();
      let overrides = state
          .option_strategy_service
          .list_for_accounts(&account_ids)?;
      Ok(Json(overrides))
  }
  ```
  Remove the now-unused `Query`/`Deserialize`/`ListQuery` items. Confirm `url` is a dependency of `apps/server` — if not, fall back to manual split: `q.split('&').filter_map(|p| p.strip_prefix("accountIds=")).map(|v| v.to_string()).collect()`. Verify with `grep -n '^url' apps/server/Cargo.toml`; if absent use the split fallback (no new dependency).

- [ ] Add `mod option_strategy;` to `apps/server/src/api.rs` after `mod net_worth;` (line 44).

- [ ] Add `.merge(option_strategy::router())` to the `protected_api` builder chain immediately after `.merge(custom_providers::router())` (line 117).

- [ ] Run `cargo build -p wealthfolio-server` — expected: compiles. If `RawQuery` import fails, it lives at `axum::extract::RawQuery`. If the `url` crate is missing, use the split fallback from the prior step.

- [ ] Commit:
  ```
  git add apps/server/src/api/option_strategy.rs apps/server/src/api.rs
  git commit -m "feat(server): add option strategy override router

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 10 — frontend TS types (`StrategyType`, `StrategyOverride`)

**Files:**
- Modify `apps/frontend/src/lib/types.ts` (append the types at the end of the file)

These types are consumed by plans 2/3 (`StrategyGroupRow.strategyType`, `detect-strategies.ts`). Field names match the Rust camelCase serialization from Task 2. `StrategyType` is the exact union from spec section 4.1.

Steps:

- [ ] Append to `apps/frontend/src/lib/types.ts` (after the final `DriftReport` interface):
  ```typescript

  // ─── Option strategy grouping (P2) ────────────────────────────────────────────

  /** Detected/overridable option strategy kinds (spec 4.1). */
  export type StrategyType =
    | "vertical"
    | "calendar"
    | "diagonal"
    | "straddle"
    | "strangle"
    | "covered-call"
    | "protective-put"
    | "collar"
    | "butterfly"
    | "iron-condor"
    | "iron-butterfly"
    | "custom";

  /** Persisted user override for option-strategy grouping (spec 4.2). */
  export interface StrategyOverride {
    id: string;
    accountId: string;
    underlying: string;
    name: string | null;
    strategyType: StrategyType | null;
    legs: string[];
    mode: "group" | "exclude";
    createdAt: string;
    updatedAt: string;
  }

  /** Payload for creating a new strategy override. */
  export interface NewStrategyOverride {
    accountId: string;
    underlying: string;
    name?: string | null;
    strategyType?: StrategyType | null;
    legs: string[];
    mode: "group" | "exclude";
  }

  /** Partial-update payload for an existing strategy override. */
  export interface UpdateStrategyOverride {
    name?: string | null;
    strategyType?: StrategyType | null;
    legs?: string[];
    mode?: "group" | "exclude";
  }
  ```

- [ ] Run `pnpm --filter frontend type-check` (or `pnpm type-check`) — expected: PASS (new types are self-contained, no new errors).

- [ ] Commit:
  ```
  git add apps/frontend/src/lib/types.ts
  git commit -m "feat(frontend): add StrategyType and StrategyOverride types

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 11 — frontend adapter (shared + web COMMANDS/switch + re-exports)

**Files:**
- Create `apps/frontend/src/adapters/shared/option-strategy.ts`
- Modify `apps/frontend/src/adapters/web/core.ts` (add four COMMANDS entries after the custom-providers block ~line 130; add switch cases for create/update/delete after the custom-provider switch block ~line 881)
- Modify `apps/frontend/src/adapters/tauri/index.ts` (add `export * from "../shared/option-strategy";` after the custom-provider re-export ~line 92)
- Modify `apps/frontend/src/adapters/web/index.ts` (add the four named exports after the custom-provider block ~line 206)

Steps:

- [ ] Create `apps/frontend/src/adapters/shared/option-strategy.ts` (copy the `invoke` + `logger` pattern from `shared/custom-provider.ts`). The argument names (`accountIds`, `payload`, `id`) MUST match the Tauri command parameter names (snake→camel: Tauri `account_ids` ↔ JS `accountIds`, `id` ↔ `id`):
  ```typescript
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
  ```
  NOTE: `shared/custom-provider.ts` imports `invoke, logger` from `"./platform"`. Confirm `apps/frontend/src/adapters/shared/platform.ts` exists and re-exports `invoke`/`logger` (it must — custom-provider uses it). Use the same import path.

- [ ] In `apps/frontend/src/adapters/web/core.ts`, add four entries to the `COMMANDS` map immediately after the custom-providers block (after `test_custom_provider_source` line 131). The web GET uses `accountIds` repeated query params (handled in switch below); list path has no trailing slash:
  ```typescript
    // Option strategy overrides
    get_option_strategy_overrides: { method: "GET", path: "/option-strategy-overrides" },
    create_option_strategy_override: { method: "POST", path: "/option-strategy-overrides" },
    update_option_strategy_override: { method: "PUT", path: "/option-strategy-overrides" },
    delete_option_strategy_override: { method: "DELETE", path: "/option-strategy-overrides" },
  ```

- [ ] In the same file, add switch cases immediately after the `test_custom_provider_source` case (line 881). `get_*` builds repeated `accountIds` query params; `create_*` sends the inner payload as body; `update_*`/`delete_*` append the id to the path (copy the `update_custom_provider`/`delete_custom_provider` pattern):
  ```typescript
      case "get_option_strategy_overrides": {
        const { accountIds } = (payload ?? {}) as { accountIds?: string[] };
        if (accountIds && accountIds.length > 0) {
          const params = new URLSearchParams();
          for (const id of accountIds) params.append("accountIds", id);
          url += `?${params.toString()}`;
        }
        break;
      }
      case "create_option_strategy_override": {
        const { payload: op } = payload as { payload: Record<string, unknown> };
        body = JSON.stringify(op);
        break;
      }
      case "update_option_strategy_override": {
        const { id, payload: op } = payload as {
          id: string;
          payload: Record<string, unknown>;
        };
        url += `/${encodeURIComponent(id)}`;
        body = JSON.stringify(op);
        break;
      }
      case "delete_option_strategy_override": {
        const { id } = payload as { id: string };
        url += `/${encodeURIComponent(id)}`;
        break;
      }
  ```

- [ ] In `apps/frontend/src/adapters/tauri/index.ts`, add after the custom-provider re-export (line 92):
  ```typescript

  // Option Strategy Override Commands
  export * from "../shared/option-strategy";
  ```

- [ ] In `apps/frontend/src/adapters/web/index.ts`, add after the custom-provider export block (line 206):
  ```typescript

  // Option Strategy Override Commands
  export {
    getOptionStrategyOverrides,
    createOptionStrategyOverride,
    updateOptionStrategyOverride,
    deleteOptionStrategyOverride,
  } from "../shared/option-strategy";
  ```

- [ ] Run `pnpm --filter frontend test adapter-command-parity` — expected: PASS. Both parity tests must stay green: the web test checks every invoked command exists in `COMMANDS` (the four new entries cover it); the Tauri test checks every invoked command is registered in `lib.rs` `generate_handler!` (Task 7 registered all four).

- [ ] Run `pnpm --filter frontend type-check` — expected: PASS.

- [ ] Commit:
  ```
  git add apps/frontend/src/adapters/shared/option-strategy.ts apps/frontend/src/adapters/web/core.ts apps/frontend/src/adapters/tauri/index.ts apps/frontend/src/adapters/web/index.ts
  git commit -m "feat(frontend): add option strategy override adapter and command routing

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 12 — frontend react-query hook + query key

**Files:**
- Modify `apps/frontend/src/lib/query-keys.ts` (add `OPTION_STRATEGIES` key after `CUSTOM_PROVIDERS` line 83)
- Create `apps/frontend/src/hooks/use-option-strategies.ts`

Steps:

- [ ] In `apps/frontend/src/lib/query-keys.ts`, add the key immediately after `CUSTOM_PROVIDERS: "CUSTOM_PROVIDERS",` (line 83):
  ```typescript
    OPTION_STRATEGIES: "OPTION_STRATEGIES",
  ```

- [ ] Create `apps/frontend/src/hooks/use-option-strategies.ts` (copy the query+mutation+invalidate+toast pattern from `hooks/use-custom-providers.ts`):
  ```typescript
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
  ```
  NOTE: confirm the four adapter functions are exported from `@/adapters` — they will be, via the `index.ts` re-exports added in Task 11 (the `@/adapters` barrel resolves to `adapters/tauri/index.ts` or `adapters/web/index.ts` per build target). Confirm `@wealthfolio/ui/components/ui/use-toast` import path matches `use-custom-providers.ts` (it does).

- [ ] Run `pnpm --filter frontend type-check` — expected: PASS.

- [ ] Run `pnpm --filter frontend test adapter-command-parity` once more — expected: PASS (the hook adds another reference to the four commands; parity must still hold). Also run `pnpm lint` on the touched frontend files.

- [ ] Commit:
  ```
  git add apps/frontend/src/lib/query-keys.ts apps/frontend/src/hooks/use-option-strategies.ts
  git commit -m "feat(frontend): add option strategy override react-query hooks

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 13 — full verification pass

**Files:** none (verification only)

Steps:

- [ ] Run `cargo test -p wealthfolio-core` — expected: PASS (no new core tests, but the crate must compile with the new module).

- [ ] Run `cargo test -p wealthfolio-storage-sqlite option_strategy` — expected: all 5 repository tests PASS.

- [ ] Run `cargo build -p wealthfolio-tauri --lib` and `cargo build -p wealthfolio-server` — expected: both compile.

- [ ] Run `pnpm --filter frontend test` — expected: PASS, with `adapter-command-parity.test.ts` green (proves the four command names exist in BOTH the web `COMMANDS` map and the Tauri `generate_handler!` registry).

- [ ] Run `pnpm type-check` and `pnpm lint` — expected: both PASS for the touched files.

- [ ] If everything is green, the backend override-persistence surface is complete and ready for plan 2 (detection algorithm) and plan 3 (rendering) to consume `StrategyOverride`/`StrategyType` and the `useOptionStrategies` hooks.
