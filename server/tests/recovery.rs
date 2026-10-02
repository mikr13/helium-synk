use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use synk_server::{
    App, Credentials, Envelope,
    recovery::{RelayLease, backup, mark_restored},
};
use tower::ServiceExt;
use uuid::Uuid;

async fn api(
    app: &App,
    c: &Credentials,
    method: &str,
    path: &str,
    value: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {}", c.token))
        .header("content-type", "application/json")
        .body(Body::from(value.map(|v| v.to_string()).unwrap_or_default()))
        .unwrap();
    let response = synk_server::router(app.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
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
        nonce: STANDARD.encode([counter as u8; 12]),
        ciphertext: STANDARD.encode([0; 32]),
    }
}
async fn push(app: &App, c: &Credentials, e: &Envelope) -> Value {
    let (status, reply) = api(
        app,
        c,
        "POST",
        "/v1/sync/push",
        Some(json!({"expected_epoch":app.server_epoch,"envelopes":[e]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    reply
}
#[tokio::test]
async fn snapshot_includes_committed_wal_and_reopens_with_exact_retry_and_private_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let app = App::open(&dir.path().join("live.sqlite")).await.unwrap();
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&app.pool)
        .await
        .unwrap();
    let c = app
        .issue_device("Backup fixture", "http://127.0.0.1:4318")
        .await
        .unwrap();
    let first = envelope(&c, 1);
    let ack = push(&app, &c, &first).await;
    let path = dir.path().join("snapshot.sqlite");
    backup(&app, &path).await.unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let bytes = std::fs::read(&path).unwrap();
    assert!(
        !bytes
            .windows(c.token.len())
            .any(|v| v == c.token.as_bytes())
    );
    push(&app, &c, &envelope(&c, 2)).await;
    let restored = App::open(&path).await.unwrap();
    assert_eq!(restored.account_id, app.account_id);
    assert_eq!(restored.server_epoch, app.server_epoch);
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&restored.pool)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operations")
        .fetch_one(&restored.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(push(&restored, &c, &first).await, ack);
    assert_eq!(
        push(&restored, &c, &envelope(&c, 2)).await["acknowledgements"][0]["sequence"],
        2
    );
}
#[tokio::test]
async fn backup_refuses_overwrite_and_removes_its_failed_output() {
    let dir = tempfile::tempdir().unwrap();
    let app = App::open(&dir.path().join("live.sqlite")).await.unwrap();
    let existing = dir.path().join("existing.sqlite");
    std::fs::write(&existing, b"keep existing backup").unwrap();
    assert!(backup(&app, &existing).await.is_err());
    assert_eq!(std::fs::read(&existing).unwrap(), b"keep existing backup");
    app.pool.close().await;
    let failed = dir.path().join("failed.sqlite");
    assert!(backup(&app, &failed).await.is_err());
    assert!(!failed.exists());
}
#[tokio::test]
async fn restore_epoch_reset_is_atomic_and_preserves_account_records_counters_and_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.sqlite");
    let app = App::open(&path).await.unwrap();
    let c = app
        .issue_device("Restore fixture", "http://127.0.0.1:4318")
        .await
        .unwrap();
    let first = envelope(&c, 1);
    let ack = push(&app, &c, &first).await;
    api(&app, &c, "GET", "/v1/sync/pull", None).await;
    assert_eq!(
        api(
            &app,
            &c,
            "POST",
            "/v1/sync/ack",
            Some(json!({"server_epoch":app.server_epoch,"cursor":1}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        api(&app, &c, "POST", "/v1/pairing/invites", Some(json!({})))
            .await
            .0,
        StatusCode::OK
    );
    let previous = app.server_epoch.clone();
    assert!(
        mark_restored(&app, &Uuid::new_v4().to_string())
            .await
            .is_err()
    );
    sqlx::query("CREATE TRIGGER reject_restore BEFORE UPDATE OF sent_cursor ON devices BEGIN SELECT RAISE(ABORT, 'forced restore failure'); END;").execute(&app.pool).await.unwrap();
    assert!(mark_restored(&app, &previous).await.is_err());
    let stored: String = sqlx::query_scalar("SELECT server_epoch FROM settings WHERE id=1")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(stored, previous);
    let progress: i64 = sqlx::query_scalar("SELECT processed_cursor FROM devices WHERE id=?")
        .bind(&c.device_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(progress, 1);
    let invitations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_invites")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(invitations, 1);
    sqlx::query("DROP TRIGGER reject_restore")
        .execute(&app.pool)
        .await
        .unwrap();
    let next = mark_restored(&app, &previous).await.unwrap();
    assert_ne!(next, previous);
    let row =
        sqlx::query("SELECT sent_cursor,processed_cursor,processed_epoch FROM devices WHERE id=?")
            .bind(&c.device_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(row.get::<i64, _>("sent_cursor"), 0);
    assert_eq!(row.get::<i64, _>("processed_cursor"), 0);
    assert_eq!(row.get::<Option<String>, _>("processed_epoch"), None);
    let invitations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_invites")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(invitations, 0);
    app.pool.close().await;
    let restored = App::open(&path).await.unwrap();
    assert_eq!(restored.account_id, c.account_id);
    assert_eq!(restored.server_epoch, next);
    assert_eq!(
        push(&restored, &c, &first).await["acknowledgements"],
        ack["acknowledgements"]
    );
    assert_eq!(
        push(&restored, &c, &envelope(&c, 2)).await["acknowledgements"][0]["sequence"],
        2
    );
}
#[test]
#[cfg(unix)]
fn lease_refuses_competing_server_or_restore_and_releases_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/live.sqlite");
    let held = RelayLease::acquire(&path).unwrap();
    assert!(RelayLease::acquire(&path).is_err());
    assert!(RelayLease::acquire(&dir.path().join("nested/../nested/live.sqlite")).is_err());
    drop(held);
    assert!(RelayLease::acquire(&path).is_ok());
}
