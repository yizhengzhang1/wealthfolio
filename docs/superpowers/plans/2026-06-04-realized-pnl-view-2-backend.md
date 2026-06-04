# Realized P&L View — Backend (Layer ②) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept a per-underlying realized-P&L list on the holdings-snapshot import POST, persist it as a JSON blob in the existing `app_settings` KV table, and serve an FX-converted (local→base) read endpoint `GET /api/v1/realized-pnl?accountId=…`, with a parity Tauri command.

**Architecture:** A new `RealizedEntryInput { underlying, currency, realizedLocal }` (serde-float `Decimal`, camelCase) rides on the existing `HoldingsSnapshotInput` as `realized: Vec<RealizedEntryInput>` (`#[serde(default)]`). The import handler writes the list under key `realized_pnl:{account_id}` via `SettingsService::set_setting_value` (same `app_settings` table the spending/settings modules use — zero migration). A new GET handler in the holdings router resolves the account scope (like `/income`), reads the blob(s), converts each `realizedLocal`→base with `fx_service.convert_currency` (the same path holdings uses), sorts by `|base|` desc, and returns `{ entries, total }`. A `get_realized_pnl` Tauri command mirrors the income command for adapter-command-parity.

**Tech Stack:** Rust, Axum, `rust_decimal` (`serde-float`), Diesel/SQLite via `SettingsService`/`app_settings`, `serde_json`. Tauri command (inspection-verified only — Tauri can't compile in this env).

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `apps/server/src/api/holdings/dto.rs` | Modify | Add `RealizedEntryInput` struct + `realized` field on `HoldingsSnapshotInput`; add the read-endpoint response DTOs (`RealizedPnlResponse`, `RealizedPnlEntry`, `RealizedAmounts`, `RealizedTotal`) + query struct; deserialization unit tests. |
| `apps/server/src/api/holdings/handlers.rs` | Modify | Persist the realized blob in `import_single_snapshot_impl`; add `get_realized_pnl_for_account` handler. |
| `apps/server/src/api/holdings/mod.rs` | Modify | Register `GET /realized-pnl`. |
| `apps/server/tests/realized_pnl_api.rs` | Create | Integration test: import a snapshot with `realized`, then `GET /realized-pnl?accountId` returns the converted/sorted blob. |
| `apps/tauri/src/commands/portfolio.rs` | Modify | Add `get_realized_pnl` Tauri command (parity; inspection-verified only). |
| `apps/tauri/src/lib.rs` | Modify | Register `commands::portfolio::get_realized_pnl` in the invoke handler. |

**Cargo packages / test invocation:**
- Server lib (DTO + handler unit tests): `cargo test -p wealthfolio-server --lib api::holdings`
- Server integration test: `cargo test -p wealthfolio-server --test realized_pnl_api`
- Workspace build (excludes Tauri — webkit2gtk missing): `cargo build --workspace --exclude wealthfolio-app`
- Tauri package name is `wealthfolio-app` (lib `wealthfolio_app_lib`); it CANNOT be compiled here, so Tauri changes are inspection-verified against the income command pattern only.

---

### Task 1: `RealizedEntryInput` on the import payload + response DTOs

**Files:**
- Modify `apps/server/src/api/holdings/dto.rs` (add struct after `HoldingsPositionInput` ends at L180; add `realized` field to `HoldingsSnapshotInput` L185-192; add response DTOs near `ImportHoldingsCsvResult` L194-204; extend `#[cfg(test)] mod tests` L241-270).
- Test: same file, `#[cfg(test)] mod tests`.

Existing anchors (verified):
- `HoldingsPositionInput.realized_gain` uses `#[serde(default)] pub realized_gain: rust_decimal::Decimal` — `dto.rs:176-179`. Mirror this serde-float pattern.
- `HoldingsSnapshotInput` is `dto.rs:183-192` with `date`, `positions`, `cash_balances`.
- Existing tests live at `dto.rs:241-270`.

- [ ] **Step 1: Write failing deserialization tests for `RealizedEntryInput` + the new `realized` field.**
  Append these tests inside the existing `mod tests` block in `apps/server/src/api/holdings/dto.rs` (after `position_input_parses_realized_gain`, before the closing `}` at L270). Update the `use super::…` line at the top of the module (currently `use super::HoldingsPositionInput;` at `dto.rs:243`) to `use super::{HoldingsPositionInput, HoldingsSnapshotInput, RealizedEntryInput};`.

  ```rust
      #[test]
      fn snapshot_input_defaults_realized_to_empty() {
          // Old ibkr-sync payload without the realized field.
          let json = r#"{
              "date": "2026-06-04",
              "positions": [],
              "cashBalances": {}
          }"#;
          let input: HoldingsSnapshotInput = serde_json::from_str(json).unwrap();
          assert!(input.realized.is_empty());
      }

      #[test]
      fn realized_entry_parses_serde_float_local() {
          let json = r#"{
              "underlying": "2015",
              "currency": "HKD",
              "realizedLocal": -57350.5
          }"#;
          let entry: RealizedEntryInput = serde_json::from_str(json).unwrap();
          assert_eq!(entry.underlying, "2015");
          assert_eq!(entry.currency, "HKD");
          assert_eq!(entry.realized_local, Decimal::from_str("-57350.5").unwrap());
      }

      #[test]
      fn snapshot_input_parses_realized_list() {
          let json = r#"{
              "date": "2026-06-04",
              "positions": [],
              "cashBalances": {},
              "realized": [
                  { "underlying": "AAPL", "currency": "USD", "realizedLocal": 250.5 },
                  { "underlying": "2015", "currency": "HKD", "realizedLocal": -57350 }
              ]
          }"#;
          let input: HoldingsSnapshotInput = serde_json::from_str(json).unwrap();
          assert_eq!(input.realized.len(), 2);
          assert_eq!(input.realized[0].underlying, "AAPL");
          assert_eq!(input.realized[1].currency, "HKD");
      }
  ```

- [ ] **Step 2: Run the tests, see them fail (compile error — types not defined yet).**
  Command: `cargo test -p wealthfolio-server --lib api::holdings`
  Expected: compilation fails with `cannot find type RealizedEntryInput` and `no field realized on type HoldingsSnapshotInput` (E0412 / E0609). This confirms the tests exercise the new shape.

- [ ] **Step 3: Add `RealizedEntryInput` + the `realized` field + response DTOs.**
  In `apps/server/src/api/holdings/dto.rs`, immediately after the `HoldingsPositionInput` struct closes (`dto.rs:180`), add:

  ```rust
  /// A single per-underlying realized P&L entry from the ibkr-sync ledger.
  /// `realizedLocal` is a bare JSON number (rust_decimal `serde-float`), matching
  /// the `realizedGain` contract — the sync sends a number, not a string.
  #[derive(Debug, Clone, Deserialize, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedEntryInput {
      /// Underlying symbol (OPT: prefix already stripped by the sync).
      pub underlying: String,
      /// Local currency of the realized amount (single-currency per underlying).
      pub currency: String,
      /// Realized P&L in the underlying's local currency.
      pub realized_local: rust_decimal::Decimal,
  }
  ```

  Then add the `realized` field to `HoldingsSnapshotInput` (between `cash_balances` at `dto.rs:191` and the closing brace at `dto.rs:192`):

  ```rust
      /// Per-underlying realized P&L from the broker ledger (ibkr-sync). Old
      /// payloads without this field deserialize to an empty Vec.
      #[serde(default)]
      pub realized: Vec<RealizedEntryInput>,
  ```

  Then add the read-endpoint response DTOs after `ImportHoldingsCsvResult` (after `dto.rs:204`):

  ```rust
  /// Query for the realized-P&L read endpoint.
  #[derive(Deserialize)]
  pub struct RealizedPnlQuery {
      #[serde(rename = "accountId")]
      pub account_id: Option<String>,
  }

  /// Local + base amounts for one realized entry.
  #[derive(Debug, Clone, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedAmounts {
      pub local: rust_decimal::Decimal,
      pub base: rust_decimal::Decimal,
  }

  /// One per-underlying row in the realized-P&L response.
  #[derive(Debug, Clone, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedPnlEntry {
      pub underlying: String,
      pub currency: String,
      pub realized: RealizedAmounts,
  }

  /// Base-currency total across all entries.
  #[derive(Debug, Clone, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedTotal {
      pub base: rust_decimal::Decimal,
  }

  /// Response of `GET /realized-pnl`.
  #[derive(Debug, Clone, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedPnlResponse {
      /// The base currency the `base`/`total` amounts are expressed in (a user
      /// setting; not assumed to be USD). The frontend uses this to label the
      /// base-currency total instead of hard-coding a symbol.
      pub base_currency: String,
      pub entries: Vec<RealizedPnlEntry>,
      pub total: RealizedTotal,
  }
  ```

  Note: the existing `use rust_decimal::Decimal;` + `use std::str::FromStr;` are already imported inside `mod tests` (`dto.rs:244-245`); the top-of-file does NOT import `Decimal` bare (it uses `rust_decimal::Decimal` fully-qualified), so keep the fully-qualified path in the new structs.

- [ ] **Step 4: Run the tests, see them pass.**
  Command: `cargo test -p wealthfolio-server --lib api::holdings`
  Expected output includes:
  ```
  test api::holdings::dto::tests::snapshot_input_defaults_realized_to_empty ... ok
  test api::holdings::dto::tests::realized_entry_parses_serde_float_local ... ok
  test api::holdings::dto::tests::snapshot_input_parses_realized_list ... ok
  test api::holdings::dto::tests::position_input_defaults_realized_gain_to_zero ... ok
  test api::holdings::dto::tests::position_input_parses_realized_gain ... ok
  test result: ok. 5 passed; 0 failed
  ```

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/api/holdings/dto.rs
  git commit -m "$(cat <<'EOF'
  feat(server): add RealizedEntryInput to snapshot import + realized-pnl response DTOs

  - HoldingsSnapshotInput.realized: Vec<RealizedEntryInput> (#[serde(default)])
  - RealizedEntryInput { underlying, currency, realizedLocal } serde-float number
  - RealizedPnlResponse/Entry/Amounts/Total for the read endpoint

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Persist the realized blob on snapshot import

**Files:**
- Modify `apps/server/src/api/holdings/handlers.rs` (`import_single_snapshot_impl` at `handlers.rs:747-823`; imports at `handlers.rs:24` and the `super::dto` use-list at `handlers.rs:27-31`).
- Test: `apps/server/tests/realized_pnl_api.rs` (created in Step 3 below; the store is exercised end-to-end by the Task 3 integration test, so Task 2 adds a focused store-write assertion there).

Existing anchors (verified):
- `import_single_snapshot_impl(state, account_id, account_currency, base_currency, snapshot_input)` is `handlers.rs:747-823`; it persists positions via `save_manual_snapshot` then `Ok(())` at `handlers.rs:822`.
- `SettingsService` is on `AppState.settings_service` (`main_lib.rs:72`) and impls `SettingsServiceTrait::set_setting_value(key, value)` / `get_setting_value(key) -> Result<Option<String>>` (`settings_service.rs:122-132`), both hitting the `app_settings` table (`storage-sqlite/src/settings/repository.rs:152-199`). There is no delete method, so "clear" = store `"[]"`.
- The handler already imports `Json`, `Arc`, `Decimal`, `HoldingsSnapshotInput`. The `SettingsServiceTrait` is NOT yet in scope in this file.

Design note (key naming): use `format!("realized_pnl:{}", account_id)`. The blob value is `serde_json::to_string(&snapshot_input.realized)` — i.e. a JSON array of `RealizedEntryInput`. Empty list → still serialize (`"[]"`), which clears prior data on the next import. Write it AFTER `save_manual_snapshot` succeeds (so a failed snapshot import does not overwrite a good blob).

- [ ] **Step 1: Bring `SettingsServiceTrait` into scope and add the store write.**
  In `apps/server/src/api/holdings/handlers.rs`, extend the core import block. The existing `wealthfolio_core::{ accounts::{…}, lots::…, portfolio::{…} }` use is `handlers.rs:10-22`; add a sibling import line right after `use crate::{error::ApiResult, main_lib::AppState};` (`handlers.rs:24`):

  ```rust
  use wealthfolio_core::settings::SettingsServiceTrait;
  ```

  (Verify the path resolves: `SettingsServiceTrait` is defined in `crates/core/src/settings/settings_service.rs:12` and re-exported from `wealthfolio_core::settings` — confirm with `grep -rn "pub use.*SettingsServiceTrait\|pub trait SettingsServiceTrait" crates/core/src/settings/`. If it is only at `wealthfolio_core::settings::settings_service::SettingsServiceTrait`, use that full path instead.)

  Then, in `import_single_snapshot_impl`, replace the final `Ok(())` at `handlers.rs:822` (right after the `save_manual_snapshot(...).await.map_err(...)?;` block ending at `handlers.rs:820`) with:

  ```rust
      // Persist the per-underlying realized P&L blob in app_settings KV.
      // Empty list still writes "[]" so a re-import clears stale entries.
      let realized_key = format!("realized_pnl:{}", account_id);
      let realized_json = serde_json::to_string(&snapshot_input.realized)
          .map_err(|e| anyhow::anyhow!("Failed to serialize realized P&L: {}", e))?;
      state
          .settings_service
          .set_setting_value(&realized_key, &realized_json)
          .await
          .map_err(|e| anyhow::anyhow!("Failed to store realized P&L: {}", e))?;

      Ok(())
  ```

- [ ] **Step 2: Confirm it compiles (no behavior change observable until the read endpoint exists).**
  Command: `cargo build -p wealthfolio-server`
  Expected: `Finished` with no errors. (A pure compile check; the store is asserted via the Task 3 integration test, which round-trips import → read.)

- [ ] **Step 3: Commit.**
  ```bash
  git add apps/server/src/api/holdings/handlers.rs
  git commit -m "$(cat <<'EOF'
  feat(server): persist realized P&L blob to app_settings on snapshot import

  Writes serde_json of snapshot.realized under "realized_pnl:{account_id}"
  via SettingsService after positions persist; empty list writes "[]" to clear.

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: `GET /realized-pnl` read endpoint (FX-convert, sort, total) + integration test

**Files:**
- Create `apps/server/tests/realized_pnl_api.rs` (integration test; model on `apps/server/tests/income_summary_api.rs:1-59`).
- Modify `apps/server/src/api/holdings/handlers.rs` (add `get_realized_pnl_for_account`; extend `super::dto` use-list at `handlers.rs:27-31`).
- Modify `apps/server/src/api/holdings/mod.rs` (register route; router is `mod.rs:14-58`).

Existing anchors (verified):
- Account-scope-aware GET pattern: `get_income_summary_for_account` at `performance.rs:286-310` (Some(accountId)→`account_ids_for_purpose`; None→all active income accounts). For holdings, the equivalent helper is `holdings_account_ids(state, ids)` at `handlers.rs:46-57`, filtering by `AccountPurpose::Holdings`. Use it so scope matches the holdings surface the realized data belongs to.
- `resolve_scope` for the all-accounts default: list active accounts via `state.account_service.get_active_accounts()` filtered by `account_supports_purpose(&account.account_type, AccountPurpose::Holdings)` (mirror `performance.rs:293-302`, swapping `Income`→`Holdings`).
- FX: `state.fx_service.convert_currency(amount, from, to)` (`fx_traits.rs:57-62`); returns `amount` unchanged when `from == to` (`fx_service.rs:320-322`) and errors if the pair is missing.
- Base currency: `state.base_currency.read().unwrap().clone()` (used throughout, e.g. `handlers.rs:63`, `handlers.rs:698`).
- Blob read: `state.settings_service.get_setting_value(&key)? -> Option<String>` (`settings_service.rs:122`), returns `None` for a missing key.
- `AppState` import + `Json`/`Query` extractors already in scope at top of `handlers.rs`.

Endpoint contract (SHARED — do not deviate):
```
GET /api/v1/realized-pnl?accountId=...   (accountId optional → all holdings accounts)
-> RealizedPnlResponse {
     entries: [{ underlying, currency, realized: { local, base } }],   // sorted by |base| desc
     total: { base }
   }
```
Multi-account merge: read each resolved account's blob, accumulate per underlying. Sum `base`; sum `local` only while currency is consistent for that underlying — if a later account's entry for the same underlying has a different currency, keep the first currency and stop summing local for it (single account is the norm; this is the conservative edge-case handling from the spec). Drop the `OPT:`-stripping concern — the sync already strips it before sending.

- [ ] **Step 1: Write the failing integration test.**
  Create `apps/server/tests/realized_pnl_api.rs`. It imports a snapshot carrying `realized` (all USD so FX is identity against the default base USD — see openQuestions on seeding non-USD rates), then GETs the endpoint and asserts converted values, descending `|base|` order, and the total.

  ```rust
  use std::{net::SocketAddr, time::Duration};

  use axum::{
      body::{to_bytes, Body},
      http::Request,
  };
  use serde_json::Value;
  use tempfile::tempdir;
  use tower::ServiceExt;
  use wealthfolio_server::{api::app_router, build_state, config::Config};

  fn test_config(db_path: String, addons_root: String) -> Config {
      Config {
          listen_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
          db_path,
          cors_allow: vec!["*".to_string()],
          request_timeout: Duration::from_secs(30),
          static_dir: "dist".to_string(),
          addons_root,
          raw_secret_key: vec![7; 32],
          secrets_encryption_key: [7; 32],
          auth: None,
      }
  }

  #[tokio::test]
  async fn realized_pnl_roundtrips_import_to_read() {
      let temp_dir = tempdir().unwrap();
      let db_path = temp_dir
          .path()
          .join("app.db")
          .to_string_lossy()
          .into_owned();
      let addons_root = temp_dir
          .path()
          .join("addons")
          .to_string_lossy()
          .into_owned();
      let config = test_config(db_path, addons_root);
      let state = build_state(&config).await.unwrap();
      let app = app_router(state, &config);

      // 1) Create an account (base currency defaults to USD on a fresh DB).
      let create_account = app
          .clone()
          .oneshot(
              Request::builder()
                  .method("POST")
                  .uri("/api/v1/accounts")
                  .header("content-type", "application/json")
                  .body(Body::from(
                      r#"{"name":"IBKR","accountType":"SECURITIES","currency":"USD","isDefault":true,"isActive":true}"#,
                  ))
                  .unwrap(),
          )
          .await
          .unwrap();
      assert!(
          create_account.status().is_success(),
          "account create failed: {:?}",
          create_account.status()
      );
      let body = to_bytes(create_account.into_body(), usize::MAX)
          .await
          .unwrap();
      let account: Value = serde_json::from_slice(&body).unwrap();
      let account_id = account["id"].as_str().unwrap().to_string();

      // 2) Import a snapshot carrying a USD realized list (FX is identity vs USD base).
      let import_body = format!(
          r#"{{
              "accountId": "{account_id}",
              "snapshots": [{{
                  "date": "2026-06-04",
                  "positions": [],
                  "cashBalances": {{}},
                  "realized": [
                      {{ "underlying": "AAPL", "currency": "USD", "realizedLocal": 250.5 }},
                      {{ "underlying": "TSLA", "currency": "USD", "realizedLocal": -1200 }}
                  ]
              }}]
          }}"#
      );
      let import = app
          .clone()
          .oneshot(
              Request::builder()
                  .method("POST")
                  .uri("/api/v1/snapshots/import")
                  .header("content-type", "application/json")
                  .body(Body::from(import_body))
                  .unwrap(),
          )
          .await
          .unwrap();
      assert!(
          import.status().is_success(),
          "import failed: {:?}",
          import.status()
      );

      // 3) Read it back.
      let read = app
          .clone()
          .oneshot(
              Request::builder()
                  .method("GET")
                  .uri(format!("/api/v1/realized-pnl?accountId={account_id}"))
                  .body(Body::empty())
                  .unwrap(),
          )
          .await
          .unwrap();
      assert!(read.status().is_success(), "read failed: {:?}", read.status());
      let body = to_bytes(read.into_body(), usize::MAX).await.unwrap();
      let resp: Value = serde_json::from_slice(&body).unwrap();

      let entries = resp["entries"].as_array().unwrap();
      assert_eq!(entries.len(), 2);
      // Sorted by |base| desc: TSLA (1200) before AAPL (250.5).
      assert_eq!(entries[0]["underlying"], "TSLA");
      assert_eq!(entries[0]["currency"], "USD");
      assert_eq!(entries[0]["realized"]["local"], -1200.0);
      assert_eq!(entries[0]["realized"]["base"], -1200.0);
      assert_eq!(entries[1]["underlying"], "AAPL");
      assert_eq!(entries[1]["realized"]["base"], 250.5);
      // Total base = 250.5 + (-1200) = -949.5
      assert_eq!(resp["total"]["base"], -949.5);
  }
  ```

  Note: confirm the account-create endpoint shape before running — `grep -rn "accountType\|isActive\|fn create_account" apps/server/src/api/accounts.rs` and adjust the JSON keys/`accountType` value if the DTO differs. The exact account-create payload is the only fragile part; the realized round-trip is the assertion that matters.

- [ ] **Step 2: Run the test, see it fail (404 — route not registered).**
  Command: `cargo test -p wealthfolio-server --test realized_pnl_api`
  Expected: the `read failed: 404 Not Found` assertion panics (`/realized-pnl` not yet routed), OR a compile/route-missing failure. This confirms the test reaches the unimplemented endpoint.

- [ ] **Step 3: Implement the handler.**
  In `apps/server/src/api/holdings/handlers.rs`, extend the `super::dto` import list (`handlers.rs:27-31`) to add the new types:

  ```rust
  use super::dto::{
      AccountIdQuery, AllocationFilterBody, AllocationHoldingsQuery, AssetHoldingsQuery,
      AssetLotsQuery, CheckHoldingsImportRequest, CheckHoldingsImportResult, DeleteSnapshotQuery,
      FilterBody, HistoryFilterBody, HistoryQuery, HoldingItemQuery, HoldingsSnapshotInput,
      ImportHoldingsCsvRequest, ImportHoldingsCsvResult, RealizedAmounts, RealizedEntryInput,
      RealizedPnlEntry, RealizedPnlQuery, RealizedPnlResponse, RealizedTotal,
      SaveManualHoldingsRequest, SnapshotDateQuery, SnapshotInfo, SnapshotsQuery, SymbolCheckResult,
  };
  ```

  Then add the handler (place it after `import_single_snapshot_impl` ends at `handlers.rs:823`):

  ```rust
  /// GET /realized-pnl?accountId=... — per-underlying realized P&L (closed +
  /// open), FX-converted to base, sorted by |base| desc, with a base total.
  /// accountId omitted → all holdings-purpose accounts.
  pub async fn get_realized_pnl_for_account(
      State(state): State<Arc<AppState>>,
      Query(q): Query<RealizedPnlQuery>,
  ) -> ApiResult<Json<RealizedPnlResponse>> {
      let base = state.base_currency.read().unwrap().clone();

      let account_ids: Vec<String> = if let Some(id) = q.account_id {
          holdings_account_ids(&state, std::slice::from_ref(&id))?
      } else {
          state
              .account_service
              .get_active_accounts()?
              .into_iter()
              .filter(|account| {
                  account_supports_purpose(&account.account_type, AccountPurpose::Holdings)
              })
              .map(|account| account.id)
              .collect()
      };

      // Merge per underlying across the resolved accounts.
      // Accumulator: underlying -> (currency, local_sum, local_consistent, base_sum)
      use std::collections::HashMap;
      let mut acc: HashMap<String, (String, Decimal, bool, Decimal)> = HashMap::new();

      for account_id in &account_ids {
          let key = format!("realized_pnl:{}", account_id);
          let Some(blob) = state.settings_service.get_setting_value(&key)? else {
              continue;
          };
          let entries: Vec<RealizedEntryInput> = serde_json::from_str(&blob)
              .map_err(|e| anyhow::anyhow!("Corrupt realized_pnl blob for {}: {}", account_id, e))?;
          for entry in entries {
              let base_amount = state
                  .fx_service
                  .convert_currency(entry.realized_local, &entry.currency, &base)
                  .map_err(anyhow::Error::from)?;
              let slot = acc.entry(entry.underlying.clone()).or_insert((
                  entry.currency.clone(),
                  Decimal::ZERO,
                  true,
                  Decimal::ZERO,
              ));
              if slot.2 && slot.0 == entry.currency {
                  slot.1 += entry.realized_local;
              } else {
                  // Mixed currency for one underlying across accounts: keep first
                  // currency, stop trusting the local sum (base is still correct).
                  slot.2 = false;
              }
              slot.3 += base_amount;
          }
      }

      let mut entries: Vec<RealizedPnlEntry> = acc
          .into_iter()
          .map(|(underlying, (currency, local, _consistent, base_sum))| RealizedPnlEntry {
              underlying,
              currency,
              realized: RealizedAmounts {
                  local,
                  base: base_sum,
              },
          })
          .collect();

      // Sort by |base| desc.
      entries.sort_by(|a, b| b.realized.base.abs().cmp(&a.realized.base.abs()));

      let total_base: Decimal = entries.iter().map(|e| e.realized.base).sum();

      Ok(Json(RealizedPnlResponse {
          base_currency: base,
          entries,
          total: RealizedTotal { base: total_base },
      }))
  }
  ```

  (`base` is the base-currency string read at the top of the handler, e.g.
  `let base = state.base_currency.read().unwrap().clone();` — it is moved into the
  response after the conversions are done, so read/clone it once and reuse the
  clone for `convert_currency` calls and the response field.)

  `convert_currency` returns `wealthfolio_core` `Result` (`anyhow`-compatible); `.map_err(anyhow::Error::from)?` bridges it to the handler's `ApiResult` (which already accepts `anyhow::Error` via `?` elsewhere in this file, e.g. `handlers.rs:695` uses `?` on `state.account_service.get_account`). If the `?`/`From` chain does not compile for the fx error, wrap as `.map_err(|e| anyhow::anyhow!("FX convert failed: {}", e))?`.

- [ ] **Step 4: Register the route.**
  In `apps/server/src/api/holdings/mod.rs`, inside `router()` (`mod.rs:14-58`), add after the `/snapshots/import/check` route (`mod.rs:54-57`, just before the closing `)` of the final `.route(...)`):

  ```rust
          .route(
              "/realized-pnl",
              get(handlers::get_realized_pnl_for_account),
          )
  ```

  (`get` is already imported at `mod.rs:8`.)

- [ ] **Step 5: Run the integration test, see it pass.**
  Command: `cargo test -p wealthfolio-server --test realized_pnl_api`
  Expected:
  ```
  test realized_pnl_roundtrips_import_to_read ... ok
  test result: ok. 1 passed; 0 failed
  ```
  Also re-run the lib tests to confirm no regression: `cargo test -p wealthfolio-server --lib api::holdings` → `5 passed`.

- [ ] **Step 6: Build the workspace (sans Tauri) to confirm nothing else broke.**
  Command: `cargo build --workspace --exclude wealthfolio-app`
  Expected: `Finished` with no errors.

- [ ] **Step 7: Commit.**
  ```bash
  git add apps/server/src/api/holdings/handlers.rs apps/server/src/api/holdings/mod.rs apps/server/tests/realized_pnl_api.rs
  git commit -m "$(cat <<'EOF'
  feat(server): add GET /realized-pnl read endpoint (fx-convert, sort, total)

  Reads realized_pnl:{account} blob(s) for the resolved holdings accounts,
  converts local->base via fx_service, merges per underlying, sorts by |base|
  desc, returns {entries, total}. Integration test round-trips import -> read.

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: `get_realized_pnl` Tauri command (adapter-command-parity)

**Files:**
- Modify `apps/tauri/src/commands/portfolio.rs` (add command; mirror `get_income_summary` at `portfolio.rs:460-489`).
- Modify `apps/tauri/src/lib.rs` (register in invoke handler; income is registered at `lib.rs:506`).
- Test: `apps/frontend/src/adapters/adapter-command-parity.test.ts` (existing; verifies every adapter-invoked command exists in BOTH the web `COMMANDS` map and the Tauri registry).

Why this task exists: `adapter-command-parity.test.ts:89-104` reads `apps/tauri/src/lib.rs`, extracts `commands::<mod>::<name>` registrations, and asserts that EVERY command invoked from `adapters/shared`, `adapters/tauri`, or `features/*/adapters` is registered. The frontend plan adds an adapter that calls `invoke("get_realized_pnl", { filter })`; without a Tauri registration the parity test (Tauri half) fails. The income endpoint has BOTH a server route AND a Tauri command (`get_income_summary`, `portfolio.rs:460`, registered `lib.rs:506`), so realized-pnl mirrors it. The backend plan owns this command. **Cannot compile here (webkit2gtk missing) — inspection-verified against the income command only.**

Existing anchors (verified):
- `get_income_summary` Tauri command: `portfolio.rs:460-489`. Signature `state: State<'_, Arc<ServiceContext>>, filter: Option<AccountScopeInput>`. Resolves via `input.into_account_filter()?` → `resolve_scope(&af, &state).await?` → `income_account_ids(&state, &resolved.account_ids)?`; falls back to all active income accounts; returns `Vec::new()` when empty.
- `ServiceContext` accessors: `settings_service()` (`registry.rs:99`), `fx_service()` (`registry.rs:155`), `account_service()` (`registry.rs:131`), `portfolio_service()` (`registry.rs:229`); base currency via `state.get_base_currency()` (used at `portfolio.rs:200`).
- `holdings_account_ids(state, ids)` Tauri helper: `portfolio.rs:93-105` (filters `AccountPurpose::Holdings`).
- `SettingsServiceTrait::get_setting_value` is available on `state.settings_service()` (the trait object is `Arc<dyn settings::SettingsServiceTrait>`).
- `AccountScopeInput` + `into_account_filter`: `portfolio.rs:43-52`.

Return-type note: the Tauri command must return the SAME JSON shape as the server (`RealizedPnlResponse`). `RealizedPnlResponse`/`RealizedPnlEntry`/`RealizedAmounts`/`RealizedTotal` live in `apps/server/src/api/holdings/dto.rs` (server crate) and are NOT visible to the Tauri crate. Define a mirror set of `#[derive(Serialize)] #[serde(rename_all="camelCase")]` structs locally in `portfolio.rs` (same field names/types) — the parity test only checks command registration + invoke wiring, not shared Rust types; the JSON contract is what must match. Keep the structs minimal and adjacent to the command.

- [ ] **Step 1: Add the command + local response structs in `apps/tauri/src/commands/portfolio.rs`.**
  Append after `get_income_summary` (`portfolio.rs:489`):

  ```rust
  #[derive(Debug, Clone, serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedAmountsDto {
      pub local: rust_decimal::Decimal,
      pub base: rust_decimal::Decimal,
  }

  #[derive(Debug, Clone, serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedPnlEntryDto {
      pub underlying: String,
      pub currency: String,
      pub realized: RealizedAmountsDto,
  }

  #[derive(Debug, Clone, serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedTotalDto {
      pub base: rust_decimal::Decimal,
  }

  #[derive(Debug, Clone, serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RealizedPnlResponseDto {
      pub base_currency: String,
      pub entries: Vec<RealizedPnlEntryDto>,
      pub total: RealizedTotalDto,
  }

  #[derive(serde::Deserialize)]
  struct RealizedEntryRow {
      underlying: String,
      currency: String,
      #[serde(rename = "realizedLocal")]
      realized_local: rust_decimal::Decimal,
  }

  #[tauri::command]
  pub async fn get_realized_pnl(
      state: State<'_, Arc<ServiceContext>>,
      filter: Option<AccountScopeInput>,
  ) -> Result<RealizedPnlResponseDto, String> {
      debug!("Fetching realized P&L...");
      let base = state.get_base_currency();

      let account_ids: Vec<String> = if let Some(input) = filter {
          let af = input.into_account_filter()?;
          let resolved = resolve_scope(&af, &state).await?;
          holdings_account_ids(&state, &resolved.account_ids)?
      } else {
          state
              .account_service()
              .get_active_accounts()
              .map_err(|e| format!("Failed to fetch active accounts: {}", e))?
              .into_iter()
              .filter(|account| {
                  account_supports_purpose(&account.account_type, AccountPurpose::Holdings)
              })
              .map(|account| account.id)
              .collect()
      };

      use rust_decimal::Decimal;
      use std::collections::HashMap;
      let mut acc: HashMap<String, (String, Decimal, bool, Decimal)> = HashMap::new();

      for account_id in &account_ids {
          let key = format!("realized_pnl:{}", account_id);
          let blob = state
              .settings_service()
              .get_setting_value(&key)
              .map_err(|e| e.to_string())?;
          let Some(blob) = blob else { continue };
          let rows: Vec<RealizedEntryRow> =
              serde_json::from_str(&blob).map_err(|e| e.to_string())?;
          for row in rows {
              let base_amount = state
                  .fx_service()
                  .convert_currency(row.realized_local, &row.currency, &base)
                  .map_err(|e| e.to_string())?;
              let slot = acc.entry(row.underlying.clone()).or_insert((
                  row.currency.clone(),
                  Decimal::ZERO,
                  true,
                  Decimal::ZERO,
              ));
              if slot.2 && slot.0 == row.currency {
                  slot.1 += row.realized_local;
              } else {
                  slot.2 = false;
              }
              slot.3 += base_amount;
          }
      }

      let mut entries: Vec<RealizedPnlEntryDto> = acc
          .into_iter()
          .map(|(underlying, (currency, local, _c, base_sum))| RealizedPnlEntryDto {
              underlying,
              currency,
              realized: RealizedAmountsDto { local, base: base_sum },
          })
          .collect();
      entries.sort_by(|a, b| b.realized.base.abs().cmp(&a.realized.base.abs()));
      let total_base: Decimal = entries.iter().map(|e| e.realized.base).sum();

      Ok(RealizedPnlResponseDto {
          base_currency: base,
          entries,
          total: RealizedTotalDto { base: total_base },
      })
  }
  ```

  (`base` from `let base = state.get_base_currency();` is borrowed by the
  `convert_currency(&base)` calls in the loop and then moved into
  `base_currency` at the end — fine, the moves don't overlap.)

  Verify imports already present in `portfolio.rs` cover `account_supports_purpose`, `AccountPurpose`, `AccountScopeInput`, `ServiceContext`, `State`, `Arc`, `debug` (the income command uses all of them at `portfolio.rs:460-489`, so they are in scope). `get_setting_value`/`convert_currency` require `SettingsServiceTrait`/`FxServiceTrait` in scope — the `ServiceContext` accessors return `Arc<dyn …Trait>`, so the methods are callable without extra `use` as long as the traits are imported where the accessors' return types are named; if the build (run by the integrator on a Tauri-capable machine) reports the trait method is not found, add `use wealthfolio_core::settings::SettingsServiceTrait;` and `use wealthfolio_core::fx::FxServiceTrait;` at the top of `portfolio.rs`.

- [ ] **Step 2: Register the command in `apps/tauri/src/lib.rs`.**
  Add after `commands::portfolio::get_income_summary,` (`lib.rs:506`):

  ```rust
              commands::portfolio::get_realized_pnl,
  ```

- [ ] **Step 3: Verify parity statically (no Tauri compile).**
  The parity test reads `lib.rs` text and the adapter `invoke(...)` calls. The frontend plan adds `invoke("get_realized_pnl", { filter })` in `adapters/shared`. Confirm the registration regex `commands::[a-z_]+::([a-zA-Z0-9_]+)` (`adapter-command-parity.test.ts:13`) matches the new line:
  Command: `grep -n "commands::portfolio::get_realized_pnl" apps/tauri/src/lib.rs`
  Expected: one match. (The full parity test runs in the frontend layer after its adapter exists: `pnpm --filter @wealthfolio/frontend test adapter-command-parity` — coordinated there; the Tauri half passes once both this registration and the web `COMMANDS` entry exist.)

- [ ] **Step 4: Inspection-verify the command body against the income command.**
  Re-read `portfolio.rs:460-489` and the new `get_realized_pnl` side by side; confirm: same `State` arg type, same `Option<AccountScopeInput>` filter, same `resolve_scope` + `*_account_ids` pattern, same empty-fallback shape. Do NOT attempt `cargo build -p wealthfolio-app` (webkit2gtk missing). Optionally run `cargo build --workspace --exclude wealthfolio-app` again to confirm the server/core crates still build (the Tauri file is excluded).

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/tauri/src/commands/portfolio.rs apps/tauri/src/lib.rs
  git commit -m "$(cat <<'EOF'
  feat(tauri): add get_realized_pnl command for adapter-command-parity

  Mirrors get_income_summary: scope-resolved, reads realized_pnl:{account}
  blobs, fx-converts local->base, returns {entries, total}. Inspection-verified
  only (Tauri can't compile in CI env; parity test reads lib.rs registration).

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Done criteria

- `cargo test -p wealthfolio-server --lib api::holdings` → 5 passed (3 new DTO tests + 2 pre-existing).
- `cargo test -p wealthfolio-server --test realized_pnl_api` → 1 passed (import→read round-trip).
- `cargo build --workspace --exclude wealthfolio-app` → Finished, no errors.
- `apps/tauri/src/lib.rs` contains `commands::portfolio::get_realized_pnl` (parity registration), inspection-verified against `get_income_summary`.
