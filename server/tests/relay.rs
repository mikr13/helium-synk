use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use synk_server::{App, Credentials, Envelope};
use tempfile::TempDir;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup() -> (TempDir, App, Credentials) {
    let temp = tempfile::tempdir().unwrap();
    let app = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    let credentials = app
        .issue_device("Test A", "http://127.0.0.1:4318")
        .await
        .unwrap();
    (temp, app, credentials)
}
fn envelope(c: &Credentials, counter: i64) -> Envelope {
    Envelope {
        protocol_version: 1,
        operation_id: Uuid::new_v4().to_string(),
        account_id: c.account_id.clone(),
        device_id: c.device_id.clone(),
        counter,
        domain: "diagnostic".into(),
        key_epoch: 1,
        nonce: STANDARD.encode([0; 12]),
        ciphertext: STANDARD.encode([0; 32]),
    }
}
async fn request(
    app: &App,
    c: Option<&Credentials>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(c) = c {
        req = req.header("authorization", format!("Bearer {}", c.token));
    }
    let req = if let Some(body) = body {
        req.header("content-type", "application/json")
            .body(Body::from(body.to_string()))
    } else {
        req.body(Body::empty())
    }
    .unwrap();
    let response = synk_server::router(app.clone()).oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn push(app: &App, c: &Credentials, envelopes: &[Envelope]) -> (StatusCode, Value) {
    request(
        app,
        Some(c),
        "POST",
        "/v1/sync/push",
        Some(json!({"envelopes": envelopes, "expected_epoch": app.server_epoch})),
    )
    .await
}

#[tokio::test]
async fn authenticates_and_revokes_credentials() {
    let (_temp, app, c) = setup().await;
    assert_eq!(
        request(&app, None, "GET", "/v1/sync/pull", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, Some(&c), "GET", "/v1/sync/pull", None)
            .await
            .0,
        StatusCode::OK
    );
    app.revoke(&c.device_id).await.unwrap();
    assert_eq!(
        request(&app, Some(&c), "GET", "/v1/sync/pull", None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn retry_is_idempotent_but_conflicting_id_or_counter_is_rejected() {
    let (_temp, app, c) = setup().await;
    let e = envelope(&c, 1);
    let (status, first) = push(&app, &c, std::slice::from_ref(&e)).await;
    assert_eq!(status, StatusCode::OK);
    let (_, second) = push(&app, &c, std::slice::from_ref(&e)).await;
    assert_eq!(first, second);
    let mut changed = e.clone();
    changed.ciphertext = STANDARD.encode([1; 32]);
    assert_eq!(push(&app, &c, &[changed]).await.0, StatusCode::CONFLICT);
    assert_eq!(
        push(&app, &c, &[envelope(&c, 1)]).await.0,
        StatusCode::CONFLICT
    );
    let (_, page) = request(&app, Some(&c), "GET", "/v1/sync/pull?cursor=0", None).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn failed_batch_rolls_back_all_new_records() {
    let (_temp, app, c) = setup().await;
    let e = envelope(&c, 1);
    push(&app, &c, std::slice::from_ref(&e)).await;
    let mut changed = e;
    changed.ciphertext = STANDARD.encode([1; 32]);
    assert_eq!(
        push(&app, &c, &[envelope(&c, 2), changed]).await.0,
        StatusCode::CONFLICT
    );
    let (_, page) = request(&app, Some(&c), "GET", "/v1/sync/pull", None).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn persists_records_epoch_credentials_and_monotonic_sequence_after_reopen() {
    let (temp, app, c) = setup().await;
    let epoch = app.server_epoch.clone();
    let account = app.account_id.clone();
    let (_, response) = push(&app, &c, &[envelope(&c, 1)]).await;
    let first_seq = response["acknowledgements"][0]["sequence"]
        .as_i64()
        .unwrap();
    app.pool.close().await;
    let reopened = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    assert_eq!(reopened.server_epoch, epoch);
    assert_eq!(reopened.account_id, account);
    let (status, page) = request(&reopened, Some(&c), "GET", "/v1/sync/pull", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    let (_, response) = push(&reopened, &c, &[envelope(&c, 2)]).await;
    assert!(
        response["acknowledgements"][0]["sequence"]
            .as_i64()
            .unwrap()
            > first_seq
    );
}
#[tokio::test]
async fn rejects_wrong_author_unsupported_domain_bad_nonce_and_stale_epoch() {
    let (_temp, app, c) = setup().await;
    for key_version in [false, true] {
        let mut unsupported = envelope(&c, 1);
        if key_version {
            unsupported.key_epoch = 0;
        } else {
            unsupported.protocol_version = 2;
        }
        assert_eq!(
            push(&app, &c, &[unsupported]).await.0,
            StatusCode::UPGRADE_REQUIRED
        );
    }
    let other = app
        .issue_device("Test B", "http://127.0.0.1:4318")
        .await
        .unwrap();
    assert_eq!(
        push(&app, &c, &[envelope(&other, 1)]).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut e = envelope(&c, 1);
    e.domain = "bookmarks".into();
    assert_eq!(push(&app, &c, &[e]).await.0, StatusCode::BAD_REQUEST);
    let mut e = envelope(&c, 2);
    e.nonce = STANDARD.encode([0; 8]);
    assert_eq!(push(&app, &c, &[e]).await.0, StatusCode::BAD_REQUEST);
    let result = request(
        &app,
        Some(&c),
        "POST",
        "/v1/sync/push",
        Some(json!({"envelopes": [envelope(&c, 3)], "expected_epoch": "old"})),
    )
    .await;
    assert_eq!(result.0, StatusCode::CONFLICT);
}
#[tokio::test]
async fn pages_without_skipping_and_rejects_ahead_cursor() {
    let (_temp, app, c) = setup().await;
    let batch: Vec<_> = (1..=100).map(|counter| envelope(&c, counter)).collect();
    assert_eq!(push(&app, &c, &batch).await.0, StatusCode::OK);
    assert_eq!(push(&app, &c, &[envelope(&c, 101)]).await.0, StatusCode::OK);
    let (_, page) = request(&app, Some(&c), "GET", "/v1/sync/pull", None).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 100);
    assert_eq!(page["has_more"], true);
    let cursor = page["next_cursor"].as_i64().unwrap();
    let (_, next) = request(
        &app,
        Some(&c),
        "GET",
        &format!("/v1/sync/pull?cursor={cursor}"),
        None,
    )
    .await;
    assert_eq!(next["records"].as_array().unwrap().len(), 1);
    assert_eq!(next["has_more"], false);
    assert_eq!(
        request(&app, Some(&c), "GET", "/v1/sync/pull?cursor=999", None)
            .await
            .0,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn uses_full_durability_and_never_stores_plain_credentials() {
    let (_temp, app, c) = setup().await;
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let token: String = sqlx::query_scalar("SELECT token_hash FROM devices WHERE id = ?")
        .bind(&c.device_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(synchronous, 2);
    assert_ne!(token, c.token);
}

#[tokio::test]
async fn relays_encrypted_bookmark_records_without_reading_their_contents() {
    let (_temp, app, c) = setup().await;
    let mut e = envelope(&c, 1);
    e.domain = "bookmark".into();
    let (status, result) = push(&app, &c, std::slice::from_ref(&e)).await;
    assert_eq!(status, StatusCode::OK);
    let (_, retry) = push(&app, &c, std::slice::from_ref(&e)).await;
    assert_eq!(result, retry);
    let (_, page) = request(&app, Some(&c), "GET", "/v1/sync/pull?cursor=0", None).await;
    assert_eq!(page["records"][0]["envelope"]["domain"], "bookmark");
    assert_eq!(page["records"][0]["envelope"]["ciphertext"], e.ciphertext);
}

#[tokio::test]
async fn byte_bounded_pages_preserve_every_large_record_and_cursor() {
    let (_temp, app, c) = setup().await;
    let records: Vec<Envelope> = (1..=10)
        .map(|counter| {
            let mut e = envelope(&c, counter);
            e.domain = "bookmark".into();
            e.ciphertext = STANDARD.encode(vec![0; 65_536]);
            e
        })
        .collect();
    assert_eq!(push(&app, &c, &records).await.0, StatusCode::OK);
    let mut cursor = 0;
    let mut received = Vec::new();
    let mut pages = 0;
    loop {
        let (status, page) = request(
            &app,
            Some(&c),
            "GET",
            &format!("/v1/sync/pull?cursor={cursor}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
        pages += 1;
        for record in page["records"].as_array().unwrap() {
            received.push(record["sequence"].as_i64().unwrap());
        }
        cursor = page["next_cursor"].as_i64().unwrap();
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
    }
    assert!(pages > 1);
    assert_eq!(received, (1..=10).collect::<Vec<_>>());
    assert_eq!(cursor, 10);
}

#[tokio::test]
async fn disk_full_rejects_without_committing_or_acknowledging_and_allows_an_identical_retry() {
    let (_temp, app, c) = setup().await;
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    sqlx::query(&format!("PRAGMA max_page_count = {pages}"))
        .execute(&app.pool)
        .await
        .unwrap();
    let mut e = envelope(&c, 1);
    e.domain = "bookmark".into();
    e.ciphertext = STANDARD.encode(vec![0; 65_536]);
    let (status, body) = push(&app, &c, std::slice::from_ref(&e)).await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE);
    assert!(body["error"].as_str().unwrap().contains("storage is full"));
    assert!(body.get("acknowledgements").is_none());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operations")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("PRAGMA max_page_count = 1073741823")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        push(&app, &c, std::slice::from_ref(&e)).await.0,
        StatusCode::OK
    );
}

async fn status(app: &App, c: &Credentials) -> Value {
    let (code, value) = request(app, Some(c), "GET", "/v1/status", None).await;
    assert_eq!(code, StatusCode::OK);
    value
}
async fn ack(app: &App, c: &Credentials, epoch: &str, cursor: i64) -> (StatusCode, Value) {
    request(
        app,
        Some(c),
        "POST",
        "/v1/sync/ack",
        Some(json!({"server_epoch":epoch,"cursor":cursor})),
    )
    .await
}
#[tokio::test]
async fn exact_byte_quota_persists_and_identical_retry_does_not_consume_budget() {
    let (temp, app, c) = setup().await;
    let e = envelope(&c, 1);
    let bytes = serde_json::to_vec(&e).unwrap().len() as i64;
    app.configure_limits(synk_server::Limits {
        max_journal_bytes: bytes - 1,
        max_operations: 10,
        max_devices: 64,
    })
    .await
    .unwrap();
    assert_eq!(
        push(&app, &c, std::slice::from_ref(&e)).await.0,
        StatusCode::INSUFFICIENT_STORAGE
    );
    assert_eq!(status(&app, &c).await["journal_bytes"], 0);
    app.configure_limits(synk_server::Limits {
        max_journal_bytes: bytes,
        max_operations: 1,
        max_devices: 64,
    })
    .await
    .unwrap();
    let (code, first) = push(&app, &c, std::slice::from_ref(&e)).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(push(&app, &c, std::slice::from_ref(&e)).await.1, first);
    assert_eq!(
        push(&app, &c, &[envelope(&c, 2)]).await.0,
        StatusCode::INSUFFICIENT_STORAGE
    );
    let s = status(&app, &c).await;
    assert_eq!(s["journal_bytes"], bytes);
    assert_eq!(s["journal_operations"], 1);
    app.pool.close().await;
    let reopened = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    assert_eq!(status(&reopened, &c).await["journal_bytes"], bytes);
    assert_eq!(status(&reopened, &c).await["max_journal_bytes"], bytes);
    // Lowering a limit below existing usage preserves records and exact retries.
    reopened
        .configure_limits(synk_server::Limits {
            max_journal_bytes: 1,
            max_operations: 1,
            max_devices: 1,
        })
        .await
        .unwrap();
    assert_eq!(push(&reopened, &c, std::slice::from_ref(&e)).await.1, first);
}
#[tokio::test]
async fn quota_failure_rolls_back_the_entire_batch_and_usage_then_concurrent_inserts_stay_bounded()
{
    let (_temp, app, c) = setup().await;
    app.configure_limits(synk_server::Limits {
        max_journal_bytes: 1_000_000,
        max_operations: 1,
        max_devices: 64,
    })
    .await
    .unwrap();
    let a = envelope(&c, 1);
    let b = envelope(&c, 2);
    let (code, response) = push(&app, &c, &[a.clone(), b.clone()]).await;
    assert_eq!(code, StatusCode::INSUFFICIENT_STORAGE);
    assert!(response.get("acknowledgements").is_none());
    assert_eq!(status(&app, &c).await["journal_bytes"], 0);
    assert_eq!(status(&app, &c).await["journal_operations"], 0);
    let first = [a];
    let second = [b];
    let (left, right) = tokio::join!(push(&app, &c, &first), push(&app, &c, &second));
    assert!(matches!(
        (left.0, right.0),
        (StatusCode::OK, StatusCode::INSUFFICIENT_STORAGE)
            | (StatusCode::INSUFFICIENT_STORAGE, StatusCode::OK)
    ));
    assert_eq!(status(&app, &c).await["journal_operations"], 1);
}
#[tokio::test]
async fn installation_limit_counts_revoked_authors_and_validates_configuration() {
    let (_temp, app, c) = setup().await;
    let limits = synk_server::Limits {
        max_journal_bytes: 1_000_000,
        max_operations: 10,
        max_devices: 1,
    };
    app.configure_limits(limits.clone()).await.unwrap();
    assert!(
        app.issue_device("B", "http://127.0.0.1:4318")
            .await
            .is_err()
    );
    app.revoke(&c.device_id).await.unwrap();
    assert!(
        app.issue_device("B", "http://127.0.0.1:4318")
            .await
            .is_err()
    );
    for invalid in [
        synk_server::Limits {
            max_devices: 257,
            ..limits.clone()
        },
        synk_server::Limits {
            max_devices: 0,
            ..limits.clone()
        },
        synk_server::Limits {
            max_operations: 0,
            ..limits.clone()
        },
        synk_server::Limits {
            max_journal_bytes: 9_007_199_254_740_992,
            ..limits.clone()
        },
    ] {
        assert!(app.configure_limits(invalid).await.is_err());
    }
    app.configure_limits(synk_server::Limits {
        max_devices: 2,
        ..limits
    })
    .await
    .unwrap();
    assert!(app.issue_device("B", "http://127.0.0.1:4318").await.is_ok());
}
#[tokio::test]
async fn processed_ack_is_authorized_epoch_scoped_monotonic_and_persisted() {
    let (temp, app, c) = setup().await;
    let peer = app
        .issue_device("B", "http://127.0.0.1:4318")
        .await
        .unwrap();
    assert_eq!(
        push(&app, &c, &[envelope(&c, 1), envelope(&c, 2)]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            None,
            "POST",
            "/v1/sync/ack",
            Some(json!({"server_epoch":app.server_epoch,"cursor":0}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        ack(&app, &c, &Uuid::new_v4().to_string(), 0).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        ack(&app, &c, &app.server_epoch, -1).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ack(&app, &c, &app.server_epoch, 9_007_199_254_740_992)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ack(&app, &c, &app.server_epoch, 1).await.0,
        StatusCode::BAD_REQUEST
    );
    // Caller-provided pull positions cannot forge delivery for an unread installation.
    assert_eq!(
        request(&app, Some(&peer), "GET", "/v1/sync/pull?cursor=2", None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, Some(&c), "GET", "/v1/sync/pull", None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        ack(&app, &peer, &app.server_epoch, 2).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ack(&app, &c, &app.server_epoch, 3).await.0,
        StatusCode::BAD_REQUEST
    );
    for cursor in [2, 2, 1, 0] {
        let (code, result) = ack(&app, &c, &app.server_epoch, cursor).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(result["processed_cursor"], 2);
    }
    app.pool.close().await;
    let reopened = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    let progress = status(&reopened, &c).await;
    assert_eq!(progress["processed_cursor"], 2);
    assert_eq!(progress["processed_epoch"], reopened.server_epoch);
    assert!(progress["last_seen"].is_string());
    assert_eq!(status(&reopened, &peer).await["processed_cursor"], 0);
    reopened.revoke(&c.device_id).await.unwrap();
    assert_eq!(
        ack(&reopened, &c, &reopened.server_epoch, 2).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&reopened, Some(&c), "GET", "/v1/status", None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn migration_backfills_existing_envelope_bytes_and_usage_triggers_track_changes() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let temp = tempfile::tempdir().unwrap();
    let old_migrations = temp.path().join("old-migrations");
    std::fs::create_dir(&old_migrations).unwrap();
    std::fs::write(
        old_migrations.join("0001_relay.sql"),
        include_str!("../migrations/0001_relay.sql"),
    )
    .unwrap();
    let path = temp.path().join("old.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(old_migrations.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .unwrap();
    let account = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO settings VALUES (1,?,?)")
        .bind(&account)
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices VALUES ('old-author','old','hash',0)")
        .execute(&pool)
        .await
        .unwrap();
    let value = "unicode payload café";
    sqlx::query("INSERT INTO operations (operation_id,device_id,counter,envelope) VALUES ('old-operation','old-author',1,?)").bind(value).execute(&pool).await.unwrap();
    pool.close().await;
    let app = App::open(&path).await.unwrap();
    let usage: (i64, i64) = sqlx::query_as("SELECT journal_bytes,journal_operations FROM settings")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(usage, (value.len() as i64, 1));
    sqlx::query("UPDATE operations SET envelope = 'short'")
        .execute(&app.pool)
        .await
        .unwrap();
    let bytes: i64 = sqlx::query_scalar("SELECT journal_bytes FROM settings")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(bytes, 5);
    sqlx::query("DELETE FROM operations")
        .execute(&app.pool)
        .await
        .unwrap();
    let usage: (i64, i64) = sqlx::query_as("SELECT journal_bytes,journal_operations FROM settings")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(usage, (0, 0));
    let sequence: i64 =
        sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name = 'operations'")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(sequence, 1);
}
#[tokio::test]
async fn startup_refuses_modified_or_unknown_migrations_without_rewriting_history() {
    for unknown in [false, true] {
        let (temp, app, _c) = setup().await;
        if unknown {
            sqlx::query("INSERT INTO _sqlx_migrations (version,description,installed_on,success,checksum,execution_time) VALUES (999,'future',CURRENT_TIMESTAMP,1,X'00',0)").execute(&app.pool).await.unwrap();
        } else {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 1")
                .execute(&app.pool)
                .await
                .unwrap();
        }
        app.pool.close().await;
        let error = App::open(&temp.path().join("synk.sqlite"))
            .await
            .err()
            .expect("must refuse incompatible migration");
        assert!(error.to_string().contains("migration"));
    }
}
#[tokio::test]
async fn sequence_exhaustion_rejects_without_advancing_usage() {
    let (_temp, app, c) = setup().await;
    push(&app, &c, &[envelope(&c, 1)]).await;
    sqlx::query("UPDATE sqlite_sequence SET seq = 9007199254740991 WHERE name = 'operations'")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        push(&app, &c, &[envelope(&c, 2)]).await.0,
        StatusCode::INSUFFICIENT_STORAGE
    );
    assert_eq!(status(&app, &c).await["journal_operations"], 1);
}

async fn invitation(app: &App, c: &Credentials) -> Value {
    let (code, invite) =
        request(app, Some(c), "POST", "/v1/pairing/invites", Some(json!({}))).await;
    assert_eq!(code, StatusCode::OK);
    invite
}
fn claim(app: &App, invitation: &Value) -> Value {
    json!({"account_id":app.account_id,"expected_epoch":app.server_epoch,"invitation_token":invitation["invitation_token"],"device_id":Uuid::new_v4().to_string(),"name":"Paired profile","token":"b".repeat(64)})
}
async fn register(app: &App, claim: Value) -> (StatusCode, Value) {
    request(app, None, "POST", "/v1/pairing/register", Some(claim)).await
}
#[tokio::test]
async fn pairing_is_single_use_idempotent_hashed_and_durable_after_reopen() {
    let (temp, app, c) = setup().await;
    assert_eq!(
        request(&app, None, "POST", "/v1/pairing/invites", Some(json!({})))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let invitation = invitation(&app, &c).await;
    let first = claim(&app, &invitation);
    let (code, reply) = register(&app, first.clone()).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(register(&app, first.clone()).await.1, reply);
    let mut other = first.clone();
    other["device_id"] = json!(Uuid::new_v4().to_string());
    assert_eq!(register(&app, other).await.0, StatusCode::CONFLICT);
    let mut other = first.clone();
    other["token"] = json!("c".repeat(64));
    assert_eq!(register(&app, other).await.0, StatusCode::CONFLICT);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let hashes: (String, String) =
        sqlx::query_as("SELECT invitation_hash,claim_hash FROM pairing_invites")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_ne!(hashes.0, invitation["invitation_token"].as_str().unwrap());
    assert!(!hashes.1.contains(&"b".repeat(64)));
    let token: String = sqlx::query_scalar("SELECT token_hash FROM devices WHERE id = ?")
        .bind(first["device_id"].as_str().unwrap())
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_ne!(token, "b".repeat(64));
    app.pool.close().await;
    let reopened = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    assert_eq!(register(&reopened, first.clone()).await.1, reply);
    let paired = Credentials {
        account_id: reopened.account_id.clone(),
        device_id: first["device_id"].as_str().unwrap().into(),
        name: "Paired profile".into(),
        token: "b".repeat(64),
        server_url: c.server_url,
    };
    assert_eq!(
        request(&reopened, Some(&paired), "GET", "/v1/sync/pull", None)
            .await
            .0,
        StatusCode::OK
    );
    reopened.revoke(&paired.device_id).await.unwrap();
    assert_eq!(register(&reopened, first).await.0, StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn expired_and_revoked_issuer_invitations_cannot_enroll_new_devices() {
    let (_temp, app, c) = setup().await;
    let invite = invitation(&app, &c).await;
    let pending = claim(&app, &invite);
    sqlx::query("UPDATE pairing_invites SET expires_at = strftime('%s','now') - 1")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(register(&app, pending).await.0, StatusCode::GONE);
    let active = invitation(&app, &c).await;
    let pending = claim(&app, &active);
    app.revoke(&c.device_id).await.unwrap();
    assert_eq!(register(&app, pending).await.0, StatusCode::GONE);
}
#[tokio::test]
async fn committed_claim_retries_after_invite_expiry_but_new_claims_cannot() {
    let (_temp, app, c) = setup().await;
    let invite = invitation(&app, &c).await;
    let pending = claim(&app, &invite);
    let reply = register(&app, pending.clone()).await;
    assert_eq!(reply.0, StatusCode::OK);
    sqlx::query("UPDATE pairing_invites SET expires_at = strftime('%s','now') - 1")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(register(&app, pending.clone()).await, reply);
    let mut different = pending.clone();
    different["name"] = json!("changed");
    assert_eq!(register(&app, different).await.0, StatusCode::CONFLICT);
    sqlx::query("UPDATE pairing_invites SET expires_at = strftime('%s','now') - 3600")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(register(&app, pending).await.0, StatusCode::GONE);
}
#[tokio::test]
async fn pairing_quota_rollback_retains_the_unused_invitation_and_concurrent_claims_have_one_winner()
 {
    let (_temp, app, c) = setup().await;
    app.configure_limits(synk_server::Limits {
        max_devices: 1,
        max_operations: 100,
        max_journal_bytes: 1_000_000,
    })
    .await
    .unwrap();
    let invite = invitation(&app, &c).await;
    let pending = claim(&app, &invite);
    assert_eq!(
        register(&app, pending.clone()).await.0,
        StatusCode::INSUFFICIENT_STORAGE
    );
    let claimed: Option<String> =
        sqlx::query_scalar("SELECT claimed_device_id FROM pairing_invites")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(claimed.is_none());
    app.configure_limits(synk_server::Limits {
        max_devices: 3,
        max_operations: 100,
        max_journal_bytes: 1_000_000,
    })
    .await
    .unwrap();
    let mut other = pending.clone();
    other["token"] = json!("c".repeat(64));
    other["device_id"] = json!(Uuid::new_v4().to_string());
    let (one, two) = tokio::join!(register(&app, pending), register(&app, other));
    assert!(matches!(
        (one.0, two.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}
#[tokio::test]
async fn pairing_rejects_mismatched_accounts_epochs_keys_and_bounds_invitation_growth() {
    let (_temp, app, c) = setup().await;
    let invite = invitation(&app, &c).await;
    let pending = claim(&app, &invite);
    for field in ["account_id", "expected_epoch"] {
        let mut invalid = pending.clone();
        invalid[field] = json!(Uuid::new_v4().to_string());
        assert_eq!(register(&app, invalid).await.0, StatusCode::CONFLICT);
    }
    let mut leaked_key = pending.clone();
    leaked_key["recovery_key"] = json!("must-never-arrive-here");
    assert_eq!(
        register(&app, leaked_key).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for field in ["token", "invitation_token", "device_id", "name"] {
        let mut invalid = pending.clone();
        invalid[field] = json!("");
        assert_eq!(register(&app, invalid).await.0, StatusCode::BAD_REQUEST);
    }
    for _ in 1..16 {
        invitation(&app, &c).await;
    }
    assert_eq!(
        request(
            &app,
            Some(&c),
            "POST",
            "/v1/pairing/invites",
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx::query("UPDATE pairing_invites SET expires_at = strftime('%s','now') - 3601")
        .execute(&app.pool)
        .await
        .unwrap();
    invitation(&app, &c).await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_invites")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

fn wrapping_public(marker: u8) -> String {
    let mut raw = [marker; 65];
    raw[0] = 4;
    STANDARD.encode(raw)
}
async fn wrapping_identity(app: &App, c: &Credentials, marker: u8, epoch: u8) -> Value {
    let body = json!({"server_epoch":app.server_epoch,"public_key":wrapping_public(marker),
        "proof_epoch":epoch,"proof":STANDARD.encode([marker;32])});
    assert_eq!(
        request(
            app,
            Some(c),
            "POST",
            "/v1/keys/identity",
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::OK
    );
    body
}
fn rotation(
    app: &App,
    issuer: &Credentials,
    from: u8,
    recipients: &[(&Credentials, u8)],
    revoke: &[&Credentials],
) -> Value {
    let id = Uuid::new_v4().to_string();
    json!({"rotation_id":id,"server_epoch":app.server_epoch,"from_epoch":from,"key_epoch":from+1,
        "revoke_ids":revoke.iter().map(|c|&c.device_id).collect::<Vec<_>>(),
        "packets":recipients.iter().map(|(c, marker)|json!({"version":1,"rotation_id":id,
            "account_id":app.account_id,"server_epoch":app.server_epoch,"issuer_id":issuer.device_id,
            "from_epoch":from,"key_epoch":from+1,"recipient_id":c.device_id,
            "recipient_public_key":wrapping_public(*marker),"ephemeral_public_key":wrapping_public(99),
            "nonce":STANDARD.encode([from;12]),"ciphertext":STANDARD.encode([from;48]),
            "proof":STANDARD.encode([from;32])})).collect::<Vec<_>>()})
}
async fn rotate(app: &App, c: &Credentials, body: Value) -> (StatusCode, Value) {
    request(app, Some(c), "POST", "/v1/keys/rotate", Some(body)).await
}
async fn key_state(app: &App, c: &Credentials, after: u8) -> (StatusCode, Value) {
    request(
        app,
        Some(c),
        "GET",
        &format!("/v1/keys/state?after_epoch={after}"),
        None,
    )
    .await
}
#[tokio::test]
async fn wrapping_identity_is_authenticated_immutable_and_old_exact_retry_survives_rotation() {
    let (_temp, app, c) = setup().await;
    let identity = wrapping_identity(&app, &c, 1, 1).await;
    assert_eq!(
        request(
            &app,
            None,
            "POST",
            "/v1/keys/identity",
            Some(identity.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for field in ["public_key", "proof"] {
        let mut changed = identity.clone();
        changed[field] = json!("");
        assert_eq!(
            request(&app, Some(&c), "POST", "/v1/keys/identity", Some(changed))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut changed = identity.clone();
    changed["public_key"] = json!(wrapping_public(2));
    assert_eq!(
        request(&app, Some(&c), "POST", "/v1/keys/identity", Some(changed))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        rotate(&app, &c, rotation(&app, &c, 1, &[(&c, 1)], &[]))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Some(&c),
            "POST",
            "/v1/keys/identity",
            Some(identity.clone())
        )
        .await
        .0,
        StatusCode::OK
    );
    let newcomer = app
        .issue_device("Legacy", "http://127.0.0.1:4318")
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Some(&newcomer),
            "POST",
            "/v1/keys/identity",
            Some(identity)
        )
        .await
        .0,
        StatusCode::PRECONDITION_FAILED
    );
    wrapping_identity(&app, &newcomer, 2, 2).await;
    app.revoke(&c.device_id).await.unwrap();
    assert_eq!(key_state(&app, &c, 0).await.0, StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn rotation_revoke_packets_and_epoch_commit_together_and_retry_after_reopen() {
    let (temp, app, c) = setup().await;
    let peer = app
        .issue_device("Peer", "http://127.0.0.1:4318")
        .await
        .unwrap();
    let removed = app
        .issue_device("Removed", "http://127.0.0.1:4318")
        .await
        .unwrap();
    wrapping_identity(&app, &c, 1, 1).await;
    wrapping_identity(&app, &peer, 2, 1).await;
    let body = rotation(&app, &c, 1, &[(&c, 1), (&peer, 2)], &[&removed]);
    // Fail after the rotation row is inserted but before packets/revocation/epoch commit.
    sqlx::query("CREATE TRIGGER fail_packet BEFORE INSERT ON key_packets BEGIN SELECT RAISE(ABORT,'test packet failure'); END")
        .execute(&app.pool).await.unwrap();
    assert_eq!(
        rotate(&app, &c, body.clone()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(key_state(&app, &removed, 0).await.0, StatusCode::OK);
    let state = key_state(&app, &c, 0).await.1;
    assert_eq!(state["key_epoch"], 1);
    assert_eq!(state["packets"], json!([]));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_rotations")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER fail_packet")
        .execute(&app.pool)
        .await
        .unwrap();
    let (status, reply) = rotate(&app, &c, body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        key_state(&app, &removed, 0).await.0,
        StatusCode::UNAUTHORIZED
    );
    let state = key_state(&app, &peer, 0).await.1;
    assert_eq!(state["key_epoch"], 2);
    assert_eq!(state["packets"][0]["recipient_id"], peer.device_id);
    assert_eq!(state["packets"].as_array().unwrap().len(), 1);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_packets WHERE recipient_id = ?")
        .bind(&removed.device_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    app.pool.close().await;
    let reopened = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    assert_eq!(
        rotate(&reopened, &c, body.clone()).await,
        (StatusCode::OK, reply.clone())
    );
    let next = rotation(&reopened, &peer, 2, &[(&c, 1), (&peer, 2)], &[]);
    assert_eq!(rotate(&reopened, &peer, next).await.0, StatusCode::OK);
    assert_eq!(
        rotate(&reopened, &c, body.clone()).await,
        (StatusCode::OK, reply)
    );
    let mut changed = body;
    changed["packets"][0]["ciphertext"] = json!(STANDARD.encode([7; 48]));
    assert_eq!(rotate(&reopened, &c, changed).await.0, StatusCode::CONFLICT);
}
#[tokio::test]
async fn rotation_requires_exact_live_membership_and_disallows_self_revocation_and_extra_packets() {
    let (_temp, app, c) = setup().await;
    let peer = app
        .issue_device("Unready", "http://127.0.0.1:4318")
        .await
        .unwrap();
    wrapping_identity(&app, &c, 1, 1).await;
    assert_eq!(
        rotate(&app, &c, rotation(&app, &c, 1, &[(&c, 1)], &[]))
            .await
            .0,
        StatusCode::CONFLICT
    );
    wrapping_identity(&app, &peer, 2, 1).await;
    let body = rotation(&app, &c, 1, &[(&c, 1), (&peer, 2)], &[]);
    let newcomer = app
        .issue_device("Raced membership", "http://127.0.0.1:4318")
        .await
        .unwrap();
    assert_eq!(rotate(&app, &c, body.clone()).await.0, StatusCode::CONFLICT);
    app.revoke(&newcomer.device_id).await.unwrap();
    for change in 0..5 {
        let mut bad = body.clone();
        match change {
            0 => bad["revoke_ids"] = json!([c.device_id]),
            1 => bad["revoke_ids"] = json!([peer.device_id, peer.device_id]),
            2 => bad["packets"][0]["recipient_public_key"] = json!(wrapping_public(8)),
            3 => {
                let duplicate = bad["packets"][0].clone();
                bad["packets"].as_array_mut().unwrap().push(duplicate);
            }
            _ => bad["revoke_ids"] = json!([Uuid::new_v4().to_string()]),
        }
        assert_ne!(rotate(&app, &c, bad).await.0, StatusCode::OK);
        assert_eq!(key_state(&app, &c, 0).await.1["key_epoch"], 1);
    }
    assert_eq!(
        rotate(
            &app,
            &c,
            rotation(&app, &c, 1, &[(&c, 1), (&peer, 2), (&newcomer, 3)], &[])
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (a, b) = tokio::join!(
        rotate(&app, &c, body),
        rotate(
            &app,
            &peer,
            rotation(&app, &peer, 1, &[(&c, 1), (&peer, 2)], &[])
        )
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::PRECONDITION_FAILED)
            | (StatusCode::PRECONDITION_FAILED, StatusCode::OK)
    ));
}
#[tokio::test]
async fn fresh_records_require_current_epoch_while_committed_old_retries_remain_identical() {
    let (_temp, app, c) = setup().await;
    let old = envelope(&c, 1);
    let (_, first) = push(&app, &c, std::slice::from_ref(&old)).await;
    wrapping_identity(&app, &c, 1, 1).await;
    assert_eq!(
        rotate(&app, &c, rotation(&app, &c, 1, &[(&c, 1)], &[]))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        push(&app, &c, std::slice::from_ref(&old)).await,
        (StatusCode::OK, first)
    );
    let mut fresh = envelope(&c, 2);
    let mut current = fresh.clone();
    current.key_epoch = 2;
    assert_eq!(
        push(&app, &c, &[current.clone(), envelope(&c, 3)]).await.0,
        StatusCode::PRECONDITION_FAILED
    );
    assert_eq!(key_state(&app, &c, 0).await.1["key_epoch"], 2);
    assert_eq!(
        request(&app, Some(&c), "GET", "/v1/status", None).await.1["journal_operations"],
        1
    );
    let (_, second) = push(&app, &c, std::slice::from_ref(&current)).await;
    assert_eq!(second["acknowledgements"][0]["sequence"], 2);
    fresh.key_epoch = 2;
    fresh.nonce = STANDARD.encode([3; 12]);
    assert_eq!(push(&app, &c, &[fresh]).await.0, StatusCode::CONFLICT);
    let mut future = envelope(&c, 3);
    future.key_epoch = 3;
    assert_eq!(
        push(&app, &c, &[future]).await.0,
        StatusCode::PRECONDITION_FAILED
    );
}
#[tokio::test]
async fn rekey_check_proves_uncommitted_only_after_old_epoch_is_closed_and_preserves_committed_identity()
 {
    let (_temp, app, c) = setup().await;
    let old = envelope(&c, 1);
    let missing = envelope(&c, 2);
    push(&app, &c, std::slice::from_ref(&old)).await;
    let check = json!({"server_epoch":app.server_epoch,"key_epoch":2,"envelopes":[old,missing]});
    assert_eq!(
        request(
            &app,
            Some(&c),
            "POST",
            "/v1/sync/rekey-check",
            Some(check.clone())
        )
        .await
        .0,
        StatusCode::PRECONDITION_FAILED
    );
    wrapping_identity(&app, &c, 1, 1).await;
    rotate(&app, &c, rotation(&app, &c, 1, &[(&c, 1)], &[])).await;
    let (status, proof) = request(
        &app,
        Some(&c),
        "POST",
        "/v1/sync/rekey-check",
        Some(check.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(proof["committed"][0]["operation_id"], old.operation_id);
    assert_eq!(proof["committed"][0]["sequence"], 1);
    assert_eq!(proof["missing"], json!([missing.operation_id]));
    assert_eq!(
        push(&app, &c, std::slice::from_ref(&missing)).await.0,
        StatusCode::PRECONDITION_FAILED
    );
    let mut replacement = missing.clone();
    replacement.key_epoch = 2;
    replacement.nonce = STANDARD.encode([4; 12]);
    assert_eq!(
        push(&app, &c, std::slice::from_ref(&replacement)).await.0,
        StatusCode::OK
    );
    // Missing proof does not authorize modification of a newly committed envelope.
    assert_eq!(
        request(
            &app,
            Some(&c),
            "POST",
            "/v1/sync/rekey-check",
            Some(check.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut bad = check.clone();
    bad["envelopes"] = json!([envelope(&c, 1)]);
    assert_eq!(
        request(&app, Some(&c), "POST", "/v1/sync/rekey-check", Some(bad))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut bad = check.clone();
    bad["envelopes"] = json!([old.clone(), old]);
    assert_eq!(
        request(&app, Some(&c), "POST", "/v1/sync/rekey-check", Some(bad))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut bad = check;
    bad["server_epoch"] = json!(Uuid::new_v4().to_string());
    assert_eq!(
        request(&app, Some(&c), "POST", "/v1/sync/rekey-check", Some(bad))
            .await
            .0,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn old_invites_cannot_claim_after_rotation_but_committed_keyed_claim_can_retry() {
    let (_temp, app, c) = setup().await;
    wrapping_identity(&app, &c, 1, 1).await;
    let pending = claim(&app, &invitation(&app, &c).await);
    let invite = invitation(&app, &c).await;
    let mut paired = claim(&app, &invite);
    paired["public_key"] = json!(wrapping_public(2));
    paired["proof"] = json!(STANDARD.encode([2; 32]));
    paired["proof_epoch"] = json!(1);
    assert_eq!(register(&app, paired.clone()).await.0, StatusCode::OK);
    let peer = Credentials {
        account_id: app.account_id.clone(),
        device_id: paired["device_id"].as_str().unwrap().into(),
        token: paired["token"].as_str().unwrap().into(),
        name: "Paired".into(),
        server_url: c.server_url.clone(),
    };
    rotate(&app, &c, rotation(&app, &c, 1, &[(&c, 1), (&peer, 2)], &[])).await;
    assert_eq!(register(&app, pending).await.0, StatusCode::GONE);
    let (status, reply) = register(&app, paired.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["key_epoch"], 1);
    assert_eq!(
        key_state(&app, &peer, 1).await.1["packets"][0]["key_epoch"],
        2
    );
    let fresh = invitation(&app, &c).await;
    assert_eq!(fresh["key_epoch"], 2);
    let mut legacy = claim(&app, &fresh);
    legacy["token"] = json!("c".repeat(64));
    assert_eq!(
        register(&app, legacy.clone()).await.0,
        StatusCode::UPGRADE_REQUIRED
    );
    legacy["public_key"] = json!(wrapping_public(3));
    legacy["proof"] = json!(STANDARD.encode([3; 32]));
    legacy["proof_epoch"] = json!(1);
    assert_eq!(
        register(&app, legacy.clone()).await.0,
        StatusCode::BAD_REQUEST
    );
    legacy["proof_epoch"] = json!(2);
    assert_eq!(register(&app, legacy).await.0, StatusCode::OK);
    paired["public_key"] = json!(wrapping_public(8));
    assert_eq!(register(&app, paired).await.0, StatusCode::CONFLICT);
}
#[tokio::test]
async fn key_packet_pages_are_bounded_and_epoch_exhaustion_cannot_wrap() {
    let (_temp, app, c) = setup().await;
    wrapping_identity(&app, &c, 1, 1).await;
    for from in 1..=254 {
        assert_eq!(
            rotate(&app, &c, rotation(&app, &c, from, &[(&c, 1)], &[]))
                .await
                .0,
            StatusCode::OK
        );
    }
    let mut after = 1;
    let mut seen = Vec::new();
    loop {
        let (status, page) = key_state(&app, &c, after).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["key_epoch"], 255);
        let packets = page["packets"].as_array().unwrap();
        assert!(packets.len() <= 32);
        for packet in packets {
            let next = packet["key_epoch"].as_u64().unwrap() as u8;
            assert_eq!(next, after + 1);
            after = next;
            seen.push(next);
        }
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(seen.len(), 254);
    assert_eq!(after, 255);
    let mut exhausted = rotation(&app, &c, 254, &[(&c, 1)], &[]);
    exhausted["from_epoch"] = json!(255);
    exhausted["key_epoch"] = json!(0);
    assert_eq!(rotate(&app, &c, exhausted).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(key_state(&app, &c, 255).await.1["packets"], json!([]));
}

#[tokio::test]
async fn schema_three_claim_migration_preserves_exact_retries_and_bootstraps_epoch_one() {
    use sha2::{Digest, Sha256};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let temp = tempfile::tempdir().unwrap();
    let migrations = temp.path().join("schema-three");
    std::fs::create_dir(&migrations).unwrap();
    for (name, source) in [
        (
            "0001_relay.sql",
            include_str!("../migrations/0001_relay.sql"),
        ),
        (
            "0002_limits_progress.sql",
            include_str!("../migrations/0002_limits_progress.sql"),
        ),
        (
            "0003_pairing.sql",
            include_str!("../migrations/0003_pairing.sql"),
        ),
    ] {
        std::fs::write(migrations.join(name), source).unwrap();
    }
    let path = temp.path().join("migrated.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .unwrap();
    let hash = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()));
    let account = Uuid::new_v4().to_string();
    let epoch = Uuid::new_v4().to_string();
    let issuer = Uuid::new_v4().to_string();
    let device = Uuid::new_v4().to_string();
    let invitation = "a".repeat(64);
    let token = "b".repeat(64);
    let api_hash = hash(&token);
    sqlx::query("INSERT INTO settings (id,account_id,server_epoch) VALUES (1,?,?)")
        .bind(&account)
        .bind(&epoch)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO devices (id,name,token_hash) VALUES (?,'Issuer',?), (?,'Legacy paired',?)",
    )
    .bind(&issuer)
    .bind(hash(&"c".repeat(64)))
    .bind(&device)
    .bind(&api_hash)
    .execute(&pool)
    .await
    .unwrap();
    let old_claim_hash =
        hash(&serde_json::to_string(&(&device, "Legacy paired", &api_hash)).unwrap());
    sqlx::query("INSERT INTO pairing_invites (invitation_hash,issuer_id,expires_at,claimed_device_id,claim_hash) VALUES (?,?,strftime('%s','now') + 900,?,?)")
        .bind(hash(&invitation)).bind(&issuer).bind(&device).bind(old_claim_hash).execute(&pool).await.unwrap();
    pool.close().await;
    let app = App::open(&path).await.unwrap();
    let claim = json!({"account_id":account,"expected_epoch":epoch,"invitation_token":invitation,"device_id":device,"name":"Legacy paired","token":token});
    let (status, reply) = register(&app, claim).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["key_epoch"], 1);
    let c = Credentials {
        account_id: account,
        device_id: device,
        token,
        server_url: "http://127.0.0.1:4318".into(),
        name: "Legacy paired".into(),
    };
    let state = key_state(&app, &c, 0).await.1;
    assert_eq!(state["key_epoch"], 1);
    assert_eq!(state["packets"], json!([]));
    assert!(
        state["devices"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["public_key"].is_null())
    );
    assert_eq!(
        request(&app, Some(&c), "GET", "/v1/status", None).await.1["schema_version"],
        5
    );
}
