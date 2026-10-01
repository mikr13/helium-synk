use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use synk_server::{
    App, Credentials, Envelope, Limits,
    history_erasure::{Header, envelope_digest},
};
use tower::ServiceExt;
use uuid::Uuid;

async fn setup() -> (tempfile::TempDir, App, Credentials, Credentials) {
    let temp = tempfile::tempdir().unwrap();
    let app = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    let a = app
        .issue_device("A", "http://127.0.0.1:4318")
        .await
        .unwrap();
    let b = app
        .issue_device("B", "http://127.0.0.1:4318")
        .await
        .unwrap();
    (temp, app, a, b)
}
fn envelope(c: &Credentials, counter: i64, domain: &str) -> Envelope {
    Envelope {
        protocol_version: 1,
        operation_id: Uuid::new_v4().to_string(),
        account_id: c.account_id.clone(),
        device_id: c.device_id.clone(),
        counter,
        domain: domain.into(),
        key_epoch: 1,
        nonce: STANDARD.encode([0; 12]),
        ciphertext: STANDARD.encode([0; 32]),
    }
}
async fn api(
    app: &App,
    c: Option<&Credentials>,
    method: &str,
    path: &str,
    body: Option<Value>,
    compatible: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if compatible {
        request = request.header("x-synk-history-erasure", "1");
    }
    if let Some(c) = c {
        request = request.header("authorization", format!("Bearer {}", c.token));
    }
    let request = if let Some(body) = body {
        request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
    } else {
        request.body(Body::empty())
    }
    .unwrap();
    let response = synk_server::router(app.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn push(app: &App, c: &Credentials, envelopes: &[Envelope]) -> (StatusCode, Value) {
    api(
        app,
        Some(c),
        "POST",
        "/v1/sync/push",
        Some(json!({"expected_epoch":app.server_epoch,"envelopes":envelopes})),
        true,
    )
    .await
}
fn body(app: &App, certificate: &Envelope, targets: &[Envelope]) -> Value {
    json!({"expected_epoch":app.server_epoch,"certificate":certificate,"targets":targets.iter().map(|e|
        json!({"header":Header::of(e),"digest":envelope_digest(e)})
    ).collect::<Vec<_>>()})
}
async fn purge(
    app: &App,
    c: &Credentials,
    certificate: &Envelope,
    targets: &[Envelope],
) -> (StatusCode, Value) {
    api(
        app,
        Some(c),
        "POST",
        "/v1/history/purge",
        Some(body(app, certificate, targets)),
        true,
    )
    .await
}
async fn status(app: &App, c: &Credentials) -> Value {
    api(app, Some(c), "GET", "/v1/status", None, true).await.1
}

#[test]
fn canonical_digest_matches_javascript_fixture() {
    let e = Envelope {
        protocol_version: 1,
        operation_id: "00000000-0000-0000-0000-000000000001".into(),
        account_id: "00000000-0000-0000-0000-000000000002".into(),
        device_id: "00000000-0000-0000-0000-000000000003".into(),
        counter: 7,
        domain: "history".into(),
        key_epoch: 1,
        nonce: "AAAAAAAAAAAAAAAA".into(),
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
    };
    assert_eq!(
        envelope_digest(&e),
        "4871be609e10a88680c288a39a7d7312c706c795e963e2dcb5a7480b57f9c428"
    );
}

#[tokio::test]
async fn purge_preserves_sequence_digest_author_frontier_and_exact_retry_after_restart() {
    let (temp, app, a, b) = setup().await;
    let mut original = envelope(&a, 1, "history");
    original.ciphertext = STANDARD.encode([1; 20_000]);
    let (_, pushed) = push(&app, &a, std::slice::from_ref(&original)).await;
    let certificate = envelope(&b, 1, "history-erasure");
    let (code, reply) = purge(&app, &b, &certificate, std::slice::from_ref(&original)).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        reply["redactions"][0]["sequence"],
        pushed["acknowledgements"][0]["sequence"]
    );
    let stored: String =
        sqlx::query_scalar("SELECT envelope FROM operations WHERE operation_id = ?")
            .bind(&original.operation_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(!stored.contains(&original.ciphertext));
    assert_eq!(
        serde_json::from_str::<Value>(&stored).unwrap()["ciphertext"],
        ""
    );
    assert_eq!(status(&app, &a).await["journal_operations"], 1);
    let own = api(
        &app,
        Some(&a),
        "GET",
        "/v1/keys/state?after_epoch=0",
        None,
        true,
    )
    .await
    .1;
    assert_eq!(own["author_counter"], 1);
    assert_eq!(own["author_operation_id"], original.operation_id);
    assert_eq!(
        api(&app, Some(&a), "GET", "/v1/sync/pull?cursor=0", None, false)
            .await
            .0,
        StatusCode::UPGRADE_REQUIRED
    );
    let page = api(&app, Some(&a), "GET", "/v1/sync/pull?cursor=0", None, true)
        .await
        .1;
    assert_eq!(
        page["records"][0]["redacted"]["digest"],
        envelope_digest(&original)
    );
    assert_eq!(
        page["records"][0]["redacted"]["certificate"],
        json!(certificate)
    );
    assert_eq!(
        page["records"][0]["redacted"]["header"],
        json!(Header::of(&original))
    );
    assert_eq!(page["next_cursor"], 2);
    assert_eq!(
        push(&app, &a, std::slice::from_ref(&original)).await.1,
        pushed
    );
    let mut changed = original.clone();
    changed.ciphertext = STANDARD.encode([2; 20_000]);
    assert_eq!(push(&app, &a, &[changed]).await.0, StatusCode::CONFLICT);
    assert_eq!(
        push(&app, &a, &[envelope(&a, 1, "history")]).await.0,
        StatusCode::CONFLICT
    );
    app.pool.close().await;
    let reopened = App::open(&temp.path().join("synk.sqlite")).await.unwrap();
    assert_eq!(
        purge(&reopened, &b, &certificate, std::slice::from_ref(&original))
            .await
            .1,
        reply
    );
    sqlx::query("UPDATE settings SET key_epoch = 2")
        .execute(&reopened.pool)
        .await
        .unwrap();
    let checked = api(
        &reopened,
        Some(&a),
        "POST",
        "/v1/sync/rekey-check",
        Some(json!({
            "server_epoch":reopened.server_epoch,"key_epoch":2,"envelopes":[original]
        })),
        true,
    )
    .await;
    assert_eq!(checked.0, StatusCode::OK);
    assert_eq!(checked.1["missing"], json!([]));
    assert_eq!(checked.1["committed"], pushed["acknowledgements"]);
}

#[tokio::test]
async fn missing_own_ciphertext_is_reserved_without_upload_and_cannot_be_resurrected() {
    let (_temp, app, a, b) = setup().await;
    let original = envelope(&a, 1, "history");
    let certificate = envelope(&a, 2, "history-erasure");
    let (code, reply) = purge(&app, &a, &certificate, std::slice::from_ref(&original)).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(reply["redactions"][0]["sequence"], 2);
    assert_eq!(status(&app, &a).await["journal_operations"], 1);
    let (_, retry) = push(&app, &a, std::slice::from_ref(&original)).await;
    assert_eq!(retry["acknowledgements"][0]["sequence"], 2);
    let own = api(&app, Some(&a), "GET", "/v1/keys/state", None, true)
        .await
        .1;
    assert_eq!(own["author_counter"], 2);
    let foreign = envelope(&b, 1, "history");
    assert_eq!(
        purge(&app, &a, &envelope(&a, 3, "history-erasure"), &[foreign])
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(status(&app, &a).await["journal_operations"], 1);
    assert_eq!(
        push(&app, &a, &[envelope(&a, 1, "history")]).await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn validates_authentication_domains_headers_digests_duplicates_and_bound_request_sets() {
    let (_temp, app, a, b) = setup().await;
    let original = envelope(&a, 1, "history");
    push(&app, &a, std::slice::from_ref(&original)).await;
    let certificate = envelope(&b, 1, "history-erasure");
    let request = body(&app, &certificate, std::slice::from_ref(&original));
    assert_eq!(
        api(
            &app,
            None,
            "POST",
            "/v1/history/purge",
            Some(request.clone()),
            true
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        api(
            &app,
            Some(&b),
            "POST",
            "/v1/history/purge",
            Some(request.clone()),
            false
        )
        .await
        .0,
        StatusCode::UPGRADE_REQUIRED
    );
    assert_eq!(
        api(
            &app,
            Some(&a),
            "POST",
            "/v1/history/purge",
            Some(request.clone()),
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for (field, value, expected) in [
        ("digest", json!("a".repeat(64)), StatusCode::CONFLICT),
        ("digest", json!("not-a-digest"), StatusCode::BAD_REQUEST),
        (
            "header",
            json!(Header::of(&envelope(&a, 2, "bookmark"))),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let mut wrong = request.clone();
        wrong["targets"][0][field] = value;
        assert_eq!(
            api(
                &app,
                Some(&b),
                "POST",
                "/v1/history/purge",
                Some(wrong),
                true
            )
            .await
            .0,
            expected
        );
    }
    let mut wrong = request.clone();
    wrong["targets"][0]["header"]["counter"] = json!(2);
    assert_eq!(
        api(
            &app,
            Some(&b),
            "POST",
            "/v1/history/purge",
            Some(wrong),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        purge(
            &app,
            &b,
            &certificate,
            &[original.clone(), original.clone()]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        purge(&app, &b, &certificate, &[]).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        purge(&app, &b, &certificate, &vec![original.clone(); 101])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        push(&app, &b, std::slice::from_ref(&certificate)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        purge(&app, &b, &certificate, std::slice::from_ref(&original))
            .await
            .0,
        StatusCode::OK
    );
    let another = envelope(&a, 2, "history");
    push(&app, &a, std::slice::from_ref(&another)).await;
    assert_eq!(
        purge(&app, &b, &certificate, &[another]).await.0,
        StatusCode::CONFLICT
    );
    app.revoke(&b.device_id).await.unwrap();
    assert_eq!(
        purge(&app, &b, &certificate, &[original]).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn failed_target_and_storage_write_roll_back_certificate_receipts_usage_and_capability() {
    let (_temp, app, a, b) = setup().await;
    let original = envelope(&a, 1, "history");
    push(&app, &a, std::slice::from_ref(&original)).await;
    let before = status(&app, &a).await;
    let certificate = envelope(&b, 1, "history-erasure");
    let foreign_missing = envelope(&a, 2, "history");
    assert_eq!(
        purge(&app, &b, &certificate, &[original.clone(), foreign_missing])
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(status(&app, &a).await, before);
    let stored: String =
        sqlx::query_scalar("SELECT envelope FROM operations WHERE operation_id = ?")
            .bind(&original.operation_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(serde_json::from_str::<Envelope>(&stored).unwrap(), original);
    sqlx::query("CREATE TRIGGER fail_redaction BEFORE INSERT ON history_redactions BEGIN SELECT RAISE(ABORT, 'test write failure'); END").execute(&app.pool).await.unwrap();
    assert_eq!(
        purge(&app, &b, &certificate, std::slice::from_ref(&original))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(status(&app, &a).await, before);
    let requests: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_erasures")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(requests, 0);
    sqlx::query("DROP TRIGGER fail_redaction")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        purge(&app, &b, &certificate, &[original]).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn quota_allows_net_cleanup_and_identical_retry_but_rejects_growing_metadata_atomically() {
    let (_temp, app, a, b) = setup().await;
    let mut first = envelope(&a, 1, "history");
    first.ciphertext = STANDARD.encode([1; 10_000]);
    let mut second = envelope(&a, 2, "history");
    second.ciphertext = STANDARD.encode([2; 10_000]);
    push(&app, &a, &[first.clone(), second.clone()]).await;
    app.configure_limits(Limits {
        max_journal_bytes: 1,
        max_operations: 1,
        max_devices: 64,
    })
    .await
    .unwrap();
    let certificate = envelope(&b, 1, "history-erasure");
    let originals = [first, second];
    let (code, reply) = purge(&app, &b, &certificate, &originals).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(status(&app, &a).await["journal_operations"], 1);
    assert_eq!(purge(&app, &b, &certificate, &originals).await.1, reply);
    let before = status(&app, &a).await;
    assert_eq!(
        purge(&app, &b, &envelope(&b, 2, "history-erasure"), &originals)
            .await
            .0,
        StatusCode::INSUFFICIENT_STORAGE
    );
    assert_eq!(status(&app, &a).await, before);
    assert_eq!(
        purge(
            &app,
            &b,
            &envelope(&b, 2, "history-erasure"),
            &[envelope(&b, 1, "history")]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn redacted_pages_remain_byte_bounded_without_skipped_sequences_and_ack_after_delivery() {
    let (_temp, app, a, b) = setup().await;
    let originals: Vec<_> = (1..=24)
        .map(|counter| envelope(&a, counter, "history"))
        .collect();
    push(&app, &a, &originals).await;
    let mut certificate = envelope(&b, 1, "history-erasure");
    certificate.ciphertext = STANDARD.encode([3; 60_000]);
    assert_eq!(
        purge(&app, &b, &certificate, &originals).await.0,
        StatusCode::OK
    );
    let mut cursor = 0;
    let mut count = 0;
    loop {
        let (code, page) = api(
            &app,
            Some(&a),
            "GET",
            &format!("/v1/sync/pull?cursor={cursor}"),
            None,
            true,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert!(page.to_string().len() < 512 * 1024);
        let records = page["records"].as_array().unwrap();
        assert!(!records.is_empty());
        for entry in records {
            cursor += 1;
            assert_eq!(entry["sequence"], cursor);
            count += 1;
        }
        assert_eq!(page["next_cursor"], cursor);
        let ack = api(
            &app,
            Some(&a),
            "POST",
            "/v1/sync/ack",
            Some(json!({"server_epoch":app.server_epoch,"cursor":cursor})),
            true,
        )
        .await;
        assert_eq!(ack.0, StatusCode::OK);
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(count, 25);
    assert_eq!(status(&app, &a).await["processed_cursor"], 25);
}

#[tokio::test]
async fn competing_certificates_keep_first_receipt_and_reordered_exact_target_sets_retry() {
    let (_temp, app, a, b) = setup().await;
    let originals = [envelope(&a, 1, "history"), envelope(&a, 2, "history")];
    push(&app, &a, &originals).await;
    let first = envelope(&b, 1, "history-erasure");
    let second = envelope(&b, 2, "history-erasure");
    let (one, two) = tokio::join!(
        purge(&app, &b, &first, &originals),
        purge(&app, &b, &second, &originals)
    );
    assert_eq!(one.0, StatusCode::OK);
    assert_eq!(two.0, StatusCode::OK);
    assert_eq!(one.1["redactions"], two.1["redactions"]);
    let reversed = [originals[1].clone(), originals[0].clone()];
    assert_eq!(purge(&app, &b, &first, &reversed).await.0, StatusCode::OK);
    assert_eq!(status(&app, &a).await["history_identity_receipts"], 2);
}

#[tokio::test]
async fn schema_four_upgrade_preserves_envelopes_usage_epochs_and_processed_progress() {
    use sha2::{Digest, Sha256};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let temp = tempfile::tempdir().unwrap();
    let migrations = temp.path().join("schema-four");
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
        (
            "0004_key_epochs.sql",
            include_str!("../migrations/0004_key_epochs.sql"),
        ),
    ] {
        std::fs::write(migrations.join(name), source).unwrap();
    }
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
    sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .unwrap();
    let c = Credentials {
        account_id: Uuid::new_v4().to_string(),
        device_id: Uuid::new_v4().to_string(),
        token: "a".repeat(64),
        name: "Legacy".into(),
        server_url: "http://127.0.0.1:4318".into(),
    };
    let epoch = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO settings (id,account_id,server_epoch,key_epoch) VALUES (1,?,?,2)")
        .bind(&c.account_id)
        .bind(&epoch)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices (id,name,token_hash,sent_cursor,processed_cursor,processed_epoch) VALUES (?,?,?,1,1,?)")
        .bind(&c.device_id).bind(&c.name).bind(format!("{:x}",Sha256::digest(c.token.as_bytes()))).bind(&epoch).execute(&pool).await.unwrap();
    let original = envelope(&c, 1, "history");
    let encoded = serde_json::to_string(&original).unwrap();
    sqlx::query(
        "INSERT INTO operations (operation_id,device_id,counter,envelope) VALUES (?,?,1,?)",
    )
    .bind(&original.operation_id)
    .bind(&c.device_id)
    .bind(&encoded)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    let app = App::open(&path).await.unwrap();
    assert_eq!(app.server_epoch, epoch);
    let after = status(&app, &c).await;
    assert_eq!(after["schema_version"], 5);
    assert_eq!(after["history_erasure_version"], 0);
    assert_eq!(after["journal_operations"], 1);
    assert_eq!(after["journal_bytes"], encoded.len());
    assert_eq!(after["processed_cursor"], 1);
    assert_eq!(after["processed_epoch"], epoch);
    assert_eq!(after["key_epoch"], 2);
    let stored: String =
        sqlx::query_scalar("SELECT envelope FROM operations WHERE operation_id = ?")
            .bind(&original.operation_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(stored, encoded);
    assert_eq!(
        api(&app, Some(&c), "GET", "/v1/sync/pull?cursor=0", None, false)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(push(&app, &c, &[original]).await.0, StatusCode::OK);
}
