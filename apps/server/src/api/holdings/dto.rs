use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wealthfolio_core::portfolios::AccountScope;

#[derive(Deserialize)]
pub struct FilterBody {
    pub filter: AccountScope,
}

#[derive(Deserialize)]
pub struct AllocationFilterBody {
    pub filter: AccountScope,
    #[serde(rename = "taxonomyId")]
    pub taxonomy_id: String,
    #[serde(rename = "categoryId")]
    pub category_id: String,
}

#[derive(Deserialize)]
pub struct AccountIdQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Deserialize)]
pub struct AllocationHoldingsQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "taxonomyId")]
    pub taxonomy_id: String,
    #[serde(rename = "categoryId")]
    pub category_id: String,
}

#[derive(Deserialize)]
pub struct HoldingItemQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "assetId")]
    pub asset_id: String,
}

#[derive(Deserialize)]
pub struct AssetHoldingsQuery {
    #[serde(rename = "assetId")]
    pub asset_id: String,
}

#[derive(Deserialize)]
pub struct AssetLotsQuery {
    #[serde(rename = "assetId")]
    pub asset_id: String,
    #[serde(rename = "includeSnapshotPositions", default)]
    pub include_snapshot_positions: bool,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "startDate")]
    pub start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
}

#[derive(Deserialize)]
pub struct HistoryFilterBody {
    pub filter: AccountScope,
    #[serde(rename = "startDate")]
    pub start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
}

#[derive(Deserialize)]
pub struct SnapshotsQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "dateFrom")]
    pub date_from: Option<String>,
    #[serde(rename = "dateTo")]
    pub date_to: Option<String>,
}

#[derive(Deserialize)]
pub struct SnapshotDateQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub date: String,
}

#[derive(Deserialize)]
pub struct DeleteSnapshotQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub date: String,
}

/// Information about a snapshot for UI display
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub snapshot_date: String,
    pub source: String,
    pub position_count: usize,
    pub cash_currency_count: usize,
    pub cash_total_account_currency: String,
}

/// Input for a single holding when saving manual holdings
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingInput {
    /// For existing holdings, pass the known asset ID directly (preferred)
    pub asset_id: Option<String>,
    /// Symbol (e.g., "AAPL", "META.TO") - used when asset_id is not provided
    pub symbol: String,
    pub quantity: String,
    pub currency: String,
    pub average_cost: Option<String>,
    /// Exchange MIC code for new holdings (e.g., "XNAS", "XTSE"). Used when asset_id is not provided.
    pub exchange_mic: Option<String>,
    /// Quote currency resolved during search/review (e.g., GBp)
    pub quote_ccy: Option<String>,
    /// Instrument type resolved during search/review (e.g., EQUITY, CRYPTO)
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this holding, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Asset name for new custom assets
    pub name: Option<String>,
    /// Data source (e.g., "MANUAL" for custom assets) — sets quote mode to manual
    pub data_source: Option<String>,
    /// Asset kind (e.g., "INVESTMENT", "OTHER")
    pub asset_kind: Option<String>,
}

/// Request body for saving manual holdings
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveManualHoldingsRequest {
    pub account_id: String,
    pub holdings: Vec<HoldingInput>,
    pub cash_balances: HashMap<String, String>,
    pub snapshot_date: Option<String>,
}

/// A single position in a holdings snapshot for CSV import
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsPositionInput {
    /// Symbol from CSV (e.g., "AAPL", "GOOGL")
    pub symbol: String,
    /// Quantity held
    pub quantity: String,
    /// Optional average cost per unit
    pub avg_cost: Option<String>,
    /// Currency for this position
    pub currency: String,
    /// Exchange MIC code (e.g., "XNAS", "XTSE") resolved during check step
    pub exchange_mic: Option<String>,
    /// Quote currency resolved during asset review/search
    pub quote_ccy: Option<String>,
    /// Instrument type resolved during asset review/search
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this position, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Resolved asset ID from asset review step
    pub asset_id: Option<String>,
    /// Cumulative realized P&L in the position's currency (broker-fed, e.g.
    /// IBKR). `#[serde(default)]` keeps old payloads (no realizedGain) at zero.
    #[serde(default)]
    pub realized_gain: rust_decimal::Decimal,
}

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

/// A single snapshot from CSV import (one date's worth of holdings)
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsSnapshotInput {
    /// The date of this snapshot (YYYY-MM-DD)
    pub date: String,
    /// Securities held on this date
    pub positions: Vec<HoldingsPositionInput>,
    /// Cash balances by currency (e.g., {"USD": "10000", "EUR": "5000"})
    pub cash_balances: HashMap<String, String>,
    /// Per-underlying realized P&L from the broker ledger (ibkr-sync). Old
    /// payloads without this field deserialize to an empty Vec.
    #[serde(default)]
    pub realized: Vec<RealizedEntryInput>,
}

/// Result of importing holdings CSV
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHoldingsCsvResult {
    /// Number of snapshots successfully imported
    pub snapshots_imported: usize,
    /// Number of snapshots that failed to import
    pub snapshots_failed: usize,
    /// Error messages for failed snapshots (date -> error)
    pub errors: Vec<String>,
}

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

/// Request body for importing holdings CSV
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHoldingsCsvRequest {
    pub account_id: String,
    pub snapshots: Vec<HoldingsSnapshotInput>,
}

/// Request body for checking holdings import
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckHoldingsImportRequest {
    pub account_id: String,
    pub snapshots: Vec<HoldingsSnapshotInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolCheckResult {
    pub symbol: String,
    pub found: bool,
    pub asset_name: Option<String>,
    pub asset_id: Option<String>,
    pub currency: Option<String>,
    pub exchange_mic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckHoldingsImportResult {
    pub existing_dates: Vec<String>,
    pub symbols: Vec<SymbolCheckResult>,
    pub validation_errors: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{HoldingsPositionInput, HoldingsSnapshotInput, RealizedEntryInput};
    use rust_decimal::Decimal;
    use std::str::FromStr;

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
        assert_eq!(input.realized_gain, Decimal::from_str("250.5").unwrap());
    }

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
}
