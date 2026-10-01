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
