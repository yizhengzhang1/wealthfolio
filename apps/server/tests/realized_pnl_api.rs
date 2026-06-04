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

    // 0) Set base currency to USD (defaults to "" on a fresh DB).
    let set_settings = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/settings")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"baseCurrency":"USD"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        set_settings.status().is_success(),
        "set settings failed: {:?}",
        set_settings.status()
    );

    // 1) Create an account.
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
    let read_status = read.status();
    let body = to_bytes(read.into_body(), usize::MAX).await.unwrap();
    assert!(
        read_status.is_success(),
        "read failed: {:?}, body: {}",
        read_status,
        String::from_utf8_lossy(&body)
    );
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

/// When an entry's currency has no seeded FX rate to base (e.g. HKD while
/// base is USD with no HKD/USD quote), the handler must NOT 500.  Instead:
///   - HTTP 200
///   - The HKD entry is present with its local value intact and base == 0
///   - A USD entry (identity conversion) still has the correct base
///   - total.base = sum of convertible entries only (HKD contributes 0)
#[tokio::test]
async fn realized_pnl_degrades_gracefully_on_missing_fx_rate() {
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

    // 0) Set base currency to USD.
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/settings")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"baseCurrency":"USD"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(r.status().is_success());

    // 1) Create account.
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/accounts")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"name":"HKD-TEST","accountType":"SECURITIES","currency":"USD","isDefault":true,"isActive":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(r.status().is_success());
    let body = to_bytes(r.into_body(), usize::MAX).await.unwrap();
    let account: Value = serde_json::from_slice(&body).unwrap();
    let account_id = account["id"].as_str().unwrap().to_string();

    // 2) Import a snapshot with one USD entry and one HKD entry.
    //    The test harness seeds NO FX rates, so HKD->USD is missing.
    let import_body = format!(
        r#"{{
            "accountId": "{account_id}",
            "snapshots": [{{
                "date": "2026-06-04",
                "positions": [],
                "cashBalances": {{}},
                "realized": [
                    {{ "underlying": "AAPL", "currency": "USD", "realizedLocal": 500.0 }},
                    {{ "underlying": "0700.HK", "currency": "HKD", "realizedLocal": 12000.0 }}
                ]
            }}]
        }}"#
    );
    let r = app
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
    assert!(r.status().is_success(), "import failed: {:?}", r.status());

    // 3) Read back — must be 200, not 500.
    let r = app
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
    let status = r.status();
    let body = to_bytes(r.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        status,
        axum::http::StatusCode::OK,
        "expected 200 but got {status}: {}",
        String::from_utf8_lossy(&body)
    );

    let resp: Value = serde_json::from_slice(&body).unwrap();
    let entries = resp["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);

    // Find entries by underlying name.
    let hk = entries
        .iter()
        .find(|e| e["underlying"] == "0700.HK")
        .expect("HKD entry missing");
    let aapl = entries
        .iter()
        .find(|e| e["underlying"] == "AAPL")
        .expect("AAPL entry missing");

    // HKD entry: local is preserved, base is 0 (no FX rate).
    assert_eq!(hk["realized"]["local"], 12000.0);
    assert_eq!(hk["realized"]["base"], 0.0);

    // USD entry: identity conversion — local == base.
    assert_eq!(aapl["realized"]["local"], 500.0);
    assert_eq!(aapl["realized"]["base"], 500.0);

    // Total base = 500 (USD) + 0 (HKD, no rate) = 500.
    assert_eq!(resp["total"]["base"], 500.0);
}
