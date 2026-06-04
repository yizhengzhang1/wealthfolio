# Holdings Futu Columns — Backend Realized-P&L Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread a broker-fed realized P&L number from the snapshot import payload onto each `Holding` so that `total_gain = unrealized_gain + realized_gain` for snapshot/broker accounts, while activity-only accounts keep `realized_gain = None`.

**Architecture:** Realized P&L is a new per-position field carried through the import chain `HoldingsPositionInput` (server DTO) → `ManualHoldingInput` (core input) → `Position` (snapshot model, serde-default 0) → `Holding.realized_gain` (set local-only during holdings construction, base 0). The valuation service then converts realized local→base with the same FX factor it already computes for unrealized, sets `realized_gain_pct`, and replaces the old `total_gain = unrealized.clone()` line with `total_gain = unrealized + realized` (and recomputes `total_gain_pct`) at every valuation branch.

**Tech Stack:** Rust (`wealthfolio-core`, `wealthfolio-server`), `rust_decimal::Decimal`, `serde`, `tokio`/`async-trait` test harness with existing `MockFxService` / `MockMarketDataService` / `MockValuationService` / `MockAssetService`.

---

## File Structure

Modified:
- `crates/core/src/portfolio/snapshot/manual_snapshot_service.rs` — add `realized_gain: Decimal` to `ManualHoldingInput`; carry it into the constructed `Position`.
- `crates/core/src/portfolio/snapshot/positions_model.rs` — add `realized_gain: Decimal` field to `Position` (serde-default 0, migration-safe); set it in `Default`, `new`, `new_with_alternative_flag`.
- `crates/core/src/portfolio/holdings/holdings_service.rs` — at holding construction (~L289) set `realized_gain: Some(MonetaryValue { local: snapshot_pos.realized_gain, base: 0 })` instead of `None`; recompute `realized_gain_pct` in the multi-account merge alongside the existing unrealized/total recompute (~L763).
- `crates/core/src/portfolio/holdings/holdings_valuation_service.rs` — add a private helper `apply_realized_and_total_gain(holding, fx_rate_local_to_base)`; call it at the three branches that currently force `realized_gain = None` and `total_gain = unrealized.clone()` (security normal exit ~L401, security expired-option exit ~L256, alternative-asset exit ~L594). The cash branch already sets realized=0 / total=0 correctly and is left unchanged.
- `apps/server/src/api/holdings/dto.rs` — add `realized_gain: Decimal` (`#[serde(default)]`) to `HoldingsPositionInput`.
- `apps/server/src/api/holdings/handlers.rs` — in `import_single_snapshot_impl` (~L771) pass `realized_gain: pos_input.realized_gain` into the `ManualHoldingInput`; in the manual-entry path (~L515) and the CSV-import handler's `ManualHoldingInput` construction, default `realized_gain` to `Decimal::ZERO`.

Created (test files): none new — all tests live in existing `#[cfg(test)]` modules:
- core `Position`/`ManualHoldingInput` tests → `crates/core/src/portfolio/snapshot/snapshot_model_tests.rs` (existing file, `mod tests`).
- holdings carry test → `crates/core/src/portfolio/holdings/holdings_service.rs` (existing `#[cfg(test)] mod tests` at L1042).
- valuation math tests → `crates/core/src/portfolio/holdings/holdings_valuation_service_tests.rs` (existing `mod tests`).
- server DTO deserialization test → new `#[cfg(test)] mod tests` appended to `apps/server/src/api/holdings/dto.rs`.

---

### Task 1: Add `realized_gain` to `Position` (snapshot model, serde-default 0)

**Files:**
- Modify `crates/core/src/portfolio/snapshot/positions_model.rs` (struct `Position` L36-62; `Default` impl L68-86; `new` L228-249; `new_with_alternative_flag` L252-275).
- Test `crates/core/src/portfolio/snapshot/snapshot_model_tests.rs` (existing `mod tests`).

Anchors verified: `Position` struct `crates/core/src/portfolio/snapshot/positions_model.rs:36-62`; the `contract_multiplier` field already uses the same serde-default pattern (`positions_model.rs:60-61`), so we mirror it. `Decimal` implements `Default` → 0, so `#[serde(default)]` needs no custom fn (confirmed: `rust_decimal` is in workspace `Cargo.toml:26`).

- [ ] **Step 1: Write failing serde test for the new field defaulting to 0 on old JSON.**
  Append to the `mod tests` block in `crates/core/src/portfolio/snapshot/snapshot_model_tests.rs` (after the existing tests, before the closing `}`):
  ```rust
      #[test]
      fn position_deserializes_realized_gain_default_zero_for_old_snapshot() {
          use crate::portfolio::snapshot::Position;
          use rust_decimal::Decimal;

          // A pre-existing snapshot JSON that predates the realized_gain field.
          let json = r#"{
              "id": "POS-AAPL-acc1",
              "accountId": "acc1",
              "assetId": "AAPL",
              "quantity": "10",
              "averageCost": "100",
              "totalCostBasis": "1000",
              "currency": "USD",
              "inceptionDate": "2024-01-01T00:00:00Z",
              "createdAt": "2024-01-01T00:00:00Z",
              "lastUpdated": "2024-01-01T00:00:00Z"
          }"#;
          let pos: Position = serde_json::from_str(json).unwrap();
          assert_eq!(pos.realized_gain, Decimal::ZERO);
      }

      #[test]
      fn position_deserializes_explicit_realized_gain() {
          use crate::portfolio::snapshot::Position;
          use rust_decimal_macros::dec;

          let json = r#"{
              "id": "POS-AAPL-acc1",
              "accountId": "acc1",
              "assetId": "AAPL",
              "quantity": "10",
              "averageCost": "100",
              "totalCostBasis": "1000",
              "currency": "USD",
              "inceptionDate": "2024-01-01T00:00:00Z",
              "createdAt": "2024-01-01T00:00:00Z",
              "lastUpdated": "2024-01-01T00:00:00Z",
              "realizedGain": "250.5"
          }"#;
          let pos: Position = serde_json::from_str(json).unwrap();
          assert_eq!(pos.realized_gain, dec!(250.5));
      }
  ```
  Note: this file may need `use rust_decimal_macros::dec;` available — it is imported locally inside the test fn above, so no top-of-module change is required.

- [ ] **Step 2: Run it, see it fail (field does not exist yet).**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::snapshot::snapshot_model_tests::tests::position_deserializes
  ```
  Expected: compile error `error[E0609]: no field 'realized_gain' on type 'Position'` (and/or unknown — the struct has no such field yet).

- [ ] **Step 3: Add the field to the `Position` struct.**
  In `crates/core/src/portfolio/snapshot/positions_model.rs`, insert after the `contract_multiplier` field (currently ending at L61, before the closing `}` of the struct at L62):
  ```rust
      /// Cumulative realized P&L for this position in the asset's currency, fed by
      /// the snapshot/broker import path (e.g. IBKR get_account_trades). Zero for
      /// activity-only positions. `#[serde(default)]` keeps old snapshots (which
      /// predate this field) deserializing to zero — migration-safe.
      #[serde(default)]
      pub realized_gain: Decimal,
  ```

- [ ] **Step 4: Set the field in `Default`, `new`, and `new_with_alternative_flag`.**
  In the `Default for Position` impl (L68-86), add `realized_gain: Decimal::ZERO,` after the `contract_multiplier: Decimal::ONE,` line (L83).
  In `new` (L234-248), add `realized_gain: Decimal::ZERO,` after `contract_multiplier: Decimal::ONE,` (L247).
  In `new_with_alternative_flag` (L260-274), add `realized_gain: Decimal::ZERO,` after `contract_multiplier,` (L273).

- [ ] **Step 5: Run the test, see it pass.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::snapshot::snapshot_model_tests::tests::position_deserializes
  ```
  Expected: `test result: ok. 2 passed; 0 failed; ...`.

- [ ] **Step 6: Commit.**
  ```bash
  git add crates/core/src/portfolio/snapshot/positions_model.rs crates/core/src/portfolio/snapshot/snapshot_model_tests.rs
  git commit -m "feat(core): add realized_gain field to Position (serde-default 0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 2: Add `realized_gain` to `ManualHoldingInput` and carry into `Position`

**Files:**
- Modify `crates/core/src/portfolio/snapshot/manual_snapshot_service.rs` (`ManualHoldingInput` struct L19-41; `Position` construction L194-211).
- Test `crates/core/src/portfolio/snapshot/snapshot_model_tests.rs` (existing `mod tests`).

Anchors verified: `ManualHoldingInput` `manual_snapshot_service.rs:19-41`; the `Position { ... }` literal built per holding `manual_snapshot_service.rs:194-211` (sets `contract_multiplier: asset.contract_multiplier()` at L210). `ManualHoldingInput` and `Position` are both re-exported from `crate::portfolio::snapshot` (`snapshot/mod.rs:11,13`).

- [ ] **Step 1: Write a failing test that a `ManualHoldingInput` carries `realized_gain`.**
  This task's behavior (input → Position) is exercised end-to-end by Task 3's holdings test. Here we add a focused construction test that builds a `Position` literal mirroring the service and asserts the field flows. Append to `mod tests` in `crates/core/src/portfolio/snapshot/snapshot_model_tests.rs`:
  ```rust
      #[test]
      fn manual_holding_input_has_realized_gain_field() {
          use crate::portfolio::snapshot::ManualHoldingInput;
          use rust_decimal_macros::dec;

          let input = ManualHoldingInput {
              asset_id: Some("AAPL".to_string()),
              symbol: "AAPL".to_string(),
              exchange_mic: None,
              quantity: dec!(10),
              currency: "USD".to_string(),
              average_cost: dec!(100),
              name: None,
              data_source: None,
              asset_kind: None,
              quote_ccy: None,
              instrument_type: None,
              provider_id: None,
              provider_symbol: None,
              realized_gain: dec!(250.5),
          };
          assert_eq!(input.realized_gain, dec!(250.5));
      }
  ```

- [ ] **Step 2: Run it, see it fail.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::snapshot::snapshot_model_tests::tests::manual_holding_input_has_realized_gain_field
  ```
  Expected: compile error `error[E0560]: struct 'ManualHoldingInput' has no field named 'realized_gain'`.

- [ ] **Step 3: Add the field to `ManualHoldingInput`.**
  In `crates/core/src/portfolio/snapshot/manual_snapshot_service.rs`, add to the struct (after `provider_symbol` at L40, before the closing `}` at L41):
  ```rust
      /// Cumulative realized P&L in the asset's currency from the broker/snapshot
      /// feed. Defaults to zero for manual entry and CSV import.
      pub realized_gain: Decimal,
  ```

- [ ] **Step 4: Carry it into the built `Position`.**
  In `save_manual_snapshot`, the `Position { ... }` literal (L194-211), add after `contract_multiplier: asset.contract_multiplier(),` (L210, before the closing `};` at L211):
  ```rust
              realized_gain: holding.realized_gain,
  ```

- [ ] **Step 5: Run the test, see it pass.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::snapshot::snapshot_model_tests::tests::manual_holding_input_has_realized_gain_field
  ```
  Expected: `test result: ok. 1 passed; ...`.

- [ ] **Step 6: Confirm the whole core crate still compiles (other `ManualHoldingInput` constructors must set the field — they live in the server, fixed in Task 6; in-core there are none beyond the service).**
  ```bash
  cargo build -p wealthfolio-core 2>&1 | tail -5
  ```
  Expected: `Finished` (no errors). If a struct-literal error appears for `ManualHoldingInput` inside the core crate, add `realized_gain: Decimal::ZERO,` to that literal.

- [ ] **Step 7: Commit.**
  ```bash
  git add crates/core/src/portfolio/snapshot/manual_snapshot_service.rs crates/core/src/portfolio/snapshot/snapshot_model_tests.rs
  git commit -m "feat(core): carry realized_gain from ManualHoldingInput into Position

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 3: Carry `Position.realized_gain` onto `Holding.realized_gain` (local set, base 0)

**Files:**
- Modify `crates/core/src/portfolio/holdings/holdings_service.rs` (holding construction L289-290; multi-account merge pct recompute L756-768).
- Test `crates/core/src/portfolio/holdings/holdings_service.rs` (existing `#[cfg(test)] mod tests` at L1042; helpers `test_position` L1356, `test_service` L1375, `MockValuationService` L1235 — which sets only `market_value`, never touches `realized_gain`).

Anchors verified: holding view literal sets `realized_gain: None` at `holdings_service.rs:289`; `snapshot_pos` is a `snapshot::Position` (`holdings_service.rs:169-174,230`); `MockValuationService::calculate_holdings_live_valuation` only mutates `market_value` (`holdings_service.rs:1241-1254`), so a value set pre-valuation survives into `get_holdings` output; merge recomputes `unrealized_gain_pct`/`total_gain_pct` from base at `holdings_service.rs:763-764` but does **not** recompute `realized_gain_pct`.

- [ ] **Step 1: Write a failing test that `Position.realized_gain` lands on `Holding.realized_gain.local`.**
  Append to the `#[cfg(test)] mod tests` block in `crates/core/src/portfolio/holdings/holdings_service.rs` (after the last test, before the module's closing `}`):
  ```rust
      #[tokio::test]
      async fn realized_gain_from_position_carries_onto_holding() {
          let account_id = "acc-1";
          let asset_id = "AAPL";

          let asset = test_asset(asset_id, "AAPL", InstrumentType::Equity);

          let mut position = test_position(account_id, asset_id);
          position.realized_gain = dec!(250.5);

          let snapshot = AccountStateSnapshot {
              account_id: account_id.to_string(),
              currency: "USD".to_string(),
              positions: HashMap::from([(asset_id.to_string(), position)]),
              ..Default::default()
          };
          let service = test_service(
              snapshot,
              vec![asset],
              HashMap::from([(asset_id.to_string(), dec!(100))]),
          );

          let holdings = service.get_holdings(account_id, "USD").await.unwrap();
          assert_eq!(holdings.len(), 1);
          let realized = holdings[0]
              .realized_gain
              .as_ref()
              .expect("realized_gain should be Some for snapshot-fed holding");
          assert_eq!(realized.local, dec!(250.5));
          // Base is 0 here: this test stubs valuation with MockValuationService,
          // which does not run the FX conversion (that is Task 4).
          assert_eq!(realized.base, dec!(0));
      }
  ```

- [ ] **Step 2: Run it, see it fail.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings::holdings_service::tests::realized_gain_from_position_carries_onto_holding
  ```
  Expected: assertion failure `realized_gain should be Some for snapshot-fed holding` (panic), because the construction sets `realized_gain: None`.
  (If the `position.realized_gain` assignment errors, Task 1 was not applied — stop and fix Task 1.)

- [ ] **Step 3: Set `realized_gain` from the position at holding construction.**
  In `crates/core/src/portfolio/holdings/holdings_service.rs`, replace the `realized_gain: None,` line at L289 with:
  ```rust
                  realized_gain: Some(MonetaryValue {
                      local: snapshot_pos.realized_gain,
                      base: Decimal::ZERO,
                  }),
  ```
  Leave `realized_gain_pct: None,` (L290) as-is — pct is computed in the valuation layer (Task 4).

- [ ] **Step 4: Run the test, see it pass.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings::holdings_service::tests::realized_gain_from_position_carries_onto_holding
  ```
  Expected: `test result: ok. 1 passed; ...`.

- [ ] **Step 5: Recompute `realized_gain_pct` in the multi-account merge (parity with unrealized/total).**
  In the merge pct-recompute loop (`holdings_service.rs:762-768`), inside the `if cost_base > Decimal::ZERO {` branch, add after the `total_gain_pct` line (L764):
  ```rust
                  h.realized_gain_pct = h.realized_gain.as_ref().map(|v| v.base / cost_base);
  ```
  and in the matching `else {` branch (L765-768), after `h.total_gain_pct = None;` (L767), add:
  ```rust
                  h.realized_gain_pct = None;
  ```
  Note: this only affects aggregated/portfolio-scope holdings; single-account holdings keep the per-holding `realized_gain_pct` from Task 4. The existing merge already sums `realized_gain` at L718 — do not change that.

- [ ] **Step 6: Run the holdings-service test module to confirm no regression.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings::holdings_service::tests
  ```
  Expected: all tests pass (`test result: ok. N passed; 0 failed; ...`).

- [ ] **Step 7: Commit.**
  ```bash
  git add crates/core/src/portfolio/holdings/holdings_service.rs
  git commit -m "feat(core): carry Position.realized_gain onto Holding (local set, merge pct)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 4: Valuation — convert realized to base, set pct, and total = unrealized + realized

**Files:**
- Modify `crates/core/src/portfolio/holdings/holdings_valuation_service.rs` (security expired-option exit L256-259; security normal exit L401-404; alternative-asset exit L594-597; add helper in the `impl HoldingsValuationService` block, e.g. after `get_fx_rate_or_fallback` L74).
- Test `crates/core/src/portfolio/holdings/holdings_valuation_service_tests.rs` (existing `mod tests`; helpers `create_holding` L460, `setup_test_env` L571, `assert_monetary_value_approx` L522, `assert_decimal_approx` L550, `TOLERANCE` L590).

Anchors verified: all three branches currently do `holding.realized_gain = None; holding.realized_gain_pct = None; holding.total_gain = holding.unrealized_gain.clone(); holding.total_gain_pct = holding.unrealized_gain_pct;` — at `holdings_valuation_service.rs:256-259`, `:401-404`, `:594-597`. Each branch has already computed `fx_rate_local_to_base` and stored it in `holding.fx_rate` (security `:203`, alternative `:451`). The cash branch (`:647-654`) already sets realized=0 / total=0 and is intentionally left alone. The `apply_factor_to_optional_monetary_value` normalization at `holdings_service.rs:443` already scales `realized_gain` for minor-currency assets, so no extra normalization work is needed.

Realized base = `realized_local * fx_rate_local_to_base` (same factor as cost basis at `:207`). Realized pct = `realized_base / cost_basis_base` with the same guard pattern as unrealized (`:316-323`). Total = component-wise sum of `unrealized_gain` and `realized_gain`; total pct = `total_base / cost_basis_base`.

- [ ] **Step 1: Write a failing test for non-zero realized on a base-currency security.**
  Append to `mod tests` in `crates/core/src/portfolio/holdings/holdings_valuation_service_tests.rs` (after `test_empty_holdings_list`, before the module's closing `}`):
  ```rust
      #[tokio::test]
      async fn realized_gain_sets_base_pct_and_total_base_currency() {
          let (_fx, market_data_service, valuation_service) = setup_test_env();

          let latest_quote = create_quote("2024-01-10", dec!(150.0), "CAD");
          let prev_quote = create_quote("2024-01-09", dec!(145.0), "CAD");
          market_data_service.add_quote_pair("XYZ.TO", latest_quote, Some(prev_quote));

          let mut holding = create_holding(
              "h1",
              HoldingType::Security,
              "XYZ.TO",
              dec!(10),
              "CAD",
              "CAD",
              Some(dec!(1400.0)),
              Some("XYZ Corp"),
          );
          // Simulate what holdings_service produces pre-valuation: realized in local,
          // base 0, pct None.
          holding.realized_gain = Some(MonetaryValue {
              local: dec!(200.0),
              base: dec!(0.0),
          });
          let mut holdings = vec![holding];

          valuation_service
              .calculate_holdings_live_valuation(&mut holdings)
              .await
              .unwrap();
          let h = &holdings[0];

          // unrealized = 1500 - 1400 = 100 (local==base, fx 1.0)
          assert_monetary_value_approx(
              h.unrealized_gain.as_ref(),
              dec!(100.0),
              dec!(100.0),
              TOLERANCE,
              "Unrealized",
          );
          // realized base = 200 * 1.0
          assert_monetary_value_approx(
              h.realized_gain.as_ref(),
              dec!(200.0),
              dec!(200.0),
              TOLERANCE,
              "Realized",
          );
          // realized pct = 200 / 1400
          assert_decimal_approx(
              h.realized_gain_pct,
              dec!(0.1429),
              TOLERANCE,
              "Realized Pct",
          );
          // total = unrealized + realized = 300
          assert_monetary_value_approx(
              h.total_gain.as_ref(),
              dec!(300.0),
              dec!(300.0),
              TOLERANCE,
              "Total",
          );
          // total pct = 300 / 1400
          assert_decimal_approx(
              h.total_gain_pct,
              dec!(0.2143),
              TOLERANCE,
              "Total Pct",
          );
      }

      #[tokio::test]
      async fn realized_gain_converts_with_fx_like_unrealized() {
          let (fx, market_data_service, valuation_service) = setup_test_env();
          let usd_cad = fx.get_latest_exchange_rate("USD", "CAD").unwrap(); // 1.3

          let latest_quote = create_quote("2024-01-10", dec!(100.0), "USD");
          let prev_quote = create_quote("2024-01-09", dec!(95.0), "USD");
          market_data_service.add_quote_pair("AAPL", latest_quote, Some(prev_quote));

          let mut holding = create_holding(
              "h2",
              HoldingType::Security,
              "AAPL",
              dec!(20),
              "USD",
              "CAD",
              Some(dec!(1800.0)),
              Some("Apple Inc."),
          );
          holding.realized_gain = Some(MonetaryValue {
              local: dec!(100.0),
              base: dec!(0.0),
          });
          let mut holdings = vec![holding];

          valuation_service
              .calculate_holdings_live_valuation(&mut holdings)
              .await
              .unwrap();
          let h = &holdings[0];

          // realized base = 100 USD * 1.3 = 130 CAD (same factor as cost basis)
          assert_monetary_value_approx(
              h.realized_gain.as_ref(),
              dec!(100.0),
              dec!(100.0) * usd_cad,
              TOLERANCE,
              "Realized FX",
          );
          // unrealized base = (2000-1800)*1.3 = 260; total base = 260 + 130 = 390
          let expected_total_base = dec!(200.0) * usd_cad + dec!(100.0) * usd_cad;
          assert_monetary_value_approx(
              h.total_gain.as_ref(),
              dec!(300.0),
              expected_total_base,
              TOLERANCE,
              "Total FX",
          );
      }

      #[tokio::test]
      async fn none_realized_keeps_total_equal_to_unrealized() {
          // Regression guard: activity-only holdings (realized_gain stays None)
          // must keep total_gain == unrealized_gain.
          let (_fx, market_data_service, valuation_service) = setup_test_env();

          market_data_service.add_quote_pair(
              "XYZ.TO",
              create_quote("2024-01-10", dec!(150.0), "CAD"),
              Some(create_quote("2024-01-09", dec!(145.0), "CAD")),
          );

          let mut holdings = vec![create_holding(
              "h1",
              HoldingType::Security,
              "XYZ.TO",
              dec!(10),
              "CAD",
              "CAD",
              Some(dec!(1400.0)),
              Some("XYZ Corp"),
          )]; // realized_gain defaults to None in create_holding

          valuation_service
              .calculate_holdings_live_valuation(&mut holdings)
              .await
              .unwrap();
          let h = &holdings[0];

          assert!(h.realized_gain.is_none(), "realized should stay None");
          assert!(h.realized_gain_pct.is_none(), "realized pct should stay None");
          assert_monetary_value_approx(
              h.total_gain.as_ref(),
              dec!(100.0),
              dec!(100.0),
              TOLERANCE,
              "Total == Unrealized when realized None",
          );
          assert_decimal_approx(
              h.total_gain_pct,
              dec!(0.0714),
              TOLERANCE,
              "Total pct == Unrealized pct",
          );
      }
  ```

- [ ] **Step 2: Run the new tests, see them fail.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings::holdings_valuation_service_tests::tests::realized_gain_sets_base_pct_and_total_base_currency portfolio::holdings::holdings_valuation_service_tests::tests::realized_gain_converts_with_fx_like_unrealized
  ```
  Expected: both fail at `Realized` / `Total` assertions — current code forces `realized_gain = None` and `total_gain = unrealized.clone()`, so realized base/pct and total are wrong (`MonetaryValue was None` panic for realized; total = 100/260 not 300/390). The third test `none_realized_keeps_total_equal_to_unrealized` passes already (it is the regression baseline).

- [ ] **Step 3: Add the shared helper.**
  In `crates/core/src/portfolio/holdings/holdings_valuation_service.rs`, inside `impl HoldingsValuationService` (the block starting at L28), add after `get_fx_rate_or_fallback` (which ends at L74):
  ```rust
      /// Converts an already-set local realized gain to base using the same
      /// local->base FX factor used for cost basis / unrealized, sets
      /// `realized_gain_pct`, then sets `total_gain = unrealized + realized` and
      /// recomputes `total_gain_pct`. A `None` `realized_gain` (activity-only
      /// holdings) leaves total equal to unrealized — the prior behavior.
      fn apply_realized_and_total_gain(holding: &mut Holding, fx_rate_local_to_base: Decimal) {
          if let Some(realized) = holding.realized_gain.as_mut() {
              realized.base = realized.local * fx_rate_local_to_base;
          }

          let cost_basis_base = holding
              .cost_basis
              .as_ref()
              .map(|c| c.base)
              .unwrap_or(Decimal::ZERO);

          holding.realized_gain_pct = holding.realized_gain.as_ref().map(|realized| {
              if cost_basis_base != dec!(0) {
                  (realized.base / cost_basis_base).round_dp(4)
              } else if realized.base != dec!(0) {
                  dec!(1.0)
              } else {
                  Decimal::ZERO
              }
          });

          let realized = holding
              .realized_gain
              .clone()
              .unwrap_or_else(MonetaryValue::zero);

          holding.total_gain = holding.unrealized_gain.as_ref().map(|unrealized| MonetaryValue {
              local: unrealized.local + realized.local,
              base: unrealized.base + realized.base,
          });

          holding.total_gain_pct = holding.total_gain.as_ref().map(|total| {
              if cost_basis_base != dec!(0) {
                  (total.base / cost_basis_base).round_dp(4)
              } else if total.base != dec!(0) {
                  dec!(1.0)
              } else {
                  Decimal::ZERO
              }
          });
      }
  ```
  This is an associated fn (no `&self`) so it can be called inside each branch without borrow conflicts.

- [ ] **Step 4: Replace the forced-None block at the security normal exit (L401-404).**
  Replace lines `holdings_valuation_service.rs:401-404`:
  ```rust
          holding.realized_gain = None;
          holding.realized_gain_pct = None;
          holding.total_gain = holding.unrealized_gain.clone();
          holding.total_gain_pct = holding.unrealized_gain_pct;
  ```
  with:
  ```rust
          Self::apply_realized_and_total_gain(holding, fx_rate_local_to_base);
  ```
  `fx_rate_local_to_base` is in scope here (computed at L199-203).

- [ ] **Step 5: Replace the forced-None block at the security expired-option exit (L256-259).**
  Replace lines `holdings_valuation_service.rs:256-259`:
  ```rust
              holding.realized_gain = None;
              holding.realized_gain_pct = None;
              holding.total_gain = holding.unrealized_gain.clone();
              holding.total_gain_pct = holding.unrealized_gain_pct;
  ```
  with:
  ```rust
              Self::apply_realized_and_total_gain(holding, fx_rate_local_to_base);
  ```
  (Same `fx_rate_local_to_base` from L203; the expired branch returns at L260 before reaching L401, so it needs its own call.)

- [ ] **Step 6: Replace the forced-None block at the alternative-asset exit (L594-597).**
  Replace lines `holdings_valuation_service.rs:594-597`:
  ```rust
          holding.realized_gain = None;
          holding.realized_gain_pct = None;
          holding.total_gain = holding.unrealized_gain.clone();
          holding.total_gain_pct = holding.unrealized_gain_pct;
  ```
  with:
  ```rust
          Self::apply_realized_and_total_gain(holding, fx_rate_local_to_base);
  ```
  `fx_rate_local_to_base` is in scope (computed at L446-451).

- [ ] **Step 7: Run the three new tests, see them pass.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings::holdings_valuation_service_tests::tests::realized_gain_sets_base_pct_and_total_base_currency portfolio::holdings::holdings_valuation_service_tests::tests::realized_gain_converts_with_fx_like_unrealized portfolio::holdings::holdings_valuation_service_tests::tests::none_realized_keeps_total_equal_to_unrealized
  ```
  Expected: `test result: ok. 3 passed; 0 failed; ...`.

- [ ] **Step 8: Run the full valuation + cash test module to confirm no regression (cash branch untouched; existing `test_cash_valuation_base_currency` still expects realized=0/total=0).**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings::holdings_valuation_service_tests::tests
  ```
  Expected: all tests pass. In particular `test_security_valuation_base_currency` (which asserts `holding.realized_gain.is_none()` at L684 and `total_gain == unrealized`) still passes because that holding's `realized_gain` is `None`, so the helper leaves total == unrealized.

- [ ] **Step 9: Commit.**
  ```bash
  git add crates/core/src/portfolio/holdings/holdings_valuation_service.rs crates/core/src/portfolio/holdings/holdings_valuation_service_tests.rs
  git commit -m "feat(core): value realized P&L to base, set pct, total = unrealized + realized

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 5: Server DTO — accept `realizedGain` on `HoldingsPositionInput`

**Files:**
- Modify `apps/server/src/api/holdings/dto.rs` (`HoldingsPositionInput` struct L153-176).
- Test: new `#[cfg(test)] mod tests` appended to `apps/server/src/api/holdings/dto.rs`.

Anchors verified: `HoldingsPositionInput` `apps/server/src/api/holdings/dto.rs:153-176`, `#[serde(rename_all = "camelCase")]` (L154), `Deserialize, Serialize` derived (L153). The crate `wealthfolio-server` depends on `rust_decimal` with `serde-float` (`apps/server/Cargo.toml:48`), so a JSON number deserializes into `Decimal`. `Decimal: Default` → 0, so `#[serde(default)]` needs no custom fn. The ibkr-sync sends camelCase `realizedGain` (Layer ③, separate plan).

- [ ] **Step 1: Write a failing deserialization test (old payload → 0; new payload → value).**
  Append at the end of `apps/server/src/api/holdings/dto.rs`:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::HoldingsPositionInput;
      use rust_decimal::Decimal;
      use rust_decimal_macros::dec;

      #[test]
      fn position_input_defaults_realized_gain_to_zero() {
          // Old ibkr-sync / CSV payload without realizedGain.
          let json = r#"{
              "symbol": "AAPL",
              "quantity": "10",
              "currency": "USD"
          }"#;
          let input: HoldingsPositionInput = serde_json::from_str(json).unwrap();
          assert_eq!(input.realized_gain, Decimal::ZERO);
      }

      #[test]
      fn position_input_parses_realized_gain() {
          let json = r#"{
              "symbol": "AAPL",
              "quantity": "10",
              "currency": "USD",
              "realizedGain": 250.5
          }"#;
          let input: HoldingsPositionInput = serde_json::from_str(json).unwrap();
          assert_eq!(input.realized_gain, dec!(250.5));
      }
  }
  ```

- [ ] **Step 2: Run it, see it fail.**
  ```bash
  cargo test -p wealthfolio-server --lib api::holdings::dto::tests
  ```
  Expected: compile error `error[E0609]: no field 'realized_gain' on type 'HoldingsPositionInput'`.

- [ ] **Step 3: Add the field to `HoldingsPositionInput`.**
  In `apps/server/src/api/holdings/dto.rs`, add a `use` for `Decimal` at the top of the file if not present, then add the field inside `HoldingsPositionInput` (after `asset_id: Option<String>` at L175, before the struct's closing `}` at L176):
  ```rust
      /// Cumulative realized P&L in the position's currency (broker-fed, e.g.
      /// IBKR). `#[serde(default)]` keeps old payloads (no realizedGain) at zero.
      #[serde(default)]
      pub realized_gain: rust_decimal::Decimal,
  ```
  (Use the fully-qualified `rust_decimal::Decimal` to avoid touching imports; the test uses its own `use`.)

- [ ] **Step 4: Run the test, see it pass.**
  ```bash
  cargo test -p wealthfolio-server --lib api::holdings::dto::tests
  ```
  Expected: `test result: ok. 2 passed; 0 failed; ...`.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/api/holdings/dto.rs
  git commit -m "feat(server): accept realizedGain on HoldingsPositionInput (serde-default 0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 6: Server handler — wire `realizedGain` through the import path; default elsewhere

**Files:**
- Modify `apps/server/src/api/holdings/handlers.rs` (CSV/broker import `ManualHoldingInput` construction L771-785; manual-entry `ManualHoldingInput` construction L515-523).

Anchors verified: the import path builds `ManualHoldingInput { ... }` from each `pos_input: &HoldingsPositionInput` at `handlers.rs:771-785` (no realized field today); the manual-entry path builds `ManualHoldingInput { ... }` at `handlers.rs:515-523` from a `HoldingInput` (which has no realized concept). After Task 2, `ManualHoldingInput` has a required `realized_gain` field, so both literals must set it or the crate will not compile.

- [ ] **Step 1: Confirm the compile break (no test needed — the type change is the failing signal).**
  ```bash
  cargo build -p wealthfolio-server 2>&1 | tail -8
  ```
  Expected: `error[E0063]: missing field 'realized_gain' in initializer of 'ManualHoldingInput'` at both `handlers.rs:515` and `handlers.rs:771` (after Tasks 2 are merged).

- [ ] **Step 2: Wire `realized_gain` through the import path.**
  In `handlers.rs`, in the `import_single_snapshot_impl` loop, add to the `ManualHoldingInput { ... }` literal (after `provider_symbol: pos_input.provider_symbol.clone(),` at L784, before the closing `});` at L785):
  ```rust
              realized_gain: pos_input.realized_gain,
  ```

- [ ] **Step 3: Default `realized_gain` to zero on the manual-entry path.**
  In `handlers.rs`, in the manual-entry `ManualHoldingInput { ... }` literal (the block at L515-523, after its last field, before the closing `});`), add:
  ```rust
              realized_gain: rust_decimal::Decimal::ZERO,
  ```
  (Manual entry has no broker realized feed; zero is correct. Verify whether `Decimal` is already imported in this file — `handlers.rs` uses `Decimal` elsewhere per the `average_cost` parse at L508/L765, so a plain `Decimal::ZERO` likely compiles; if the import is module-local, use the fully-qualified form shown.)

- [ ] **Step 4: Build the server crate, confirm it compiles.**
  ```bash
  cargo build -p wealthfolio-server 2>&1 | tail -5
  ```
  Expected: `Finished` with no `E0063` errors.

- [ ] **Step 5: Run the server holdings tests to confirm nothing broke.**
  ```bash
  cargo test -p wealthfolio-server --lib api::holdings
  ```
  Expected: `test result: ok. ...` (the DTO tests from Task 5 plus any others).

- [ ] **Step 6: Commit.**
  ```bash
  git add apps/server/src/api/holdings/handlers.rs
  git commit -m "feat(server): thread realizedGain through holdings import; default on manual entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 7: Full-layer verification

**Files:** none (verification only).

- [ ] **Step 1: Build the whole workspace.**
  ```bash
  cargo build 2>&1 | tail -5
  ```
  Expected: `Finished` with no errors.

- [ ] **Step 2: Run the core holdings + snapshot test surface for this layer.**
  ```bash
  cargo test -p wealthfolio-core --lib portfolio::holdings portfolio::snapshot
  ```
  Expected: `test result: ok. ...; 0 failed; ...` across all matched modules.

- [ ] **Step 3: Run the server holdings tests.**
  ```bash
  cargo test -p wealthfolio-server --lib api::holdings
  ```
  Expected: `test result: ok. ...; 0 failed; ...`.

- [ ] **Step 4: Clippy on touched crates (match project lint expectations).**
  ```bash
  cargo clippy -p wealthfolio-core -p wealthfolio-server 2>&1 | tail -15
  ```
  Expected: no new warnings introduced by these changes (pre-existing warnings, if any, are out of scope).

- [ ] **Step 5: Final review of the INVARIANT.**
  Confirm by reading the new tests that for a snapshot-fed holding `total_gain == unrealized_gain + realized_gain` and for an activity-only (`realized_gain == None`) holding `total_gain == unrealized_gain`. No commit needed — this is a checkpoint.
