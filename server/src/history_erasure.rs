use crate::{ApiError, App, Envelope, MAX_BATCH, hardening, validate};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;
use uuid::Uuid;

const CAPABILITY: &str = "x-synk-history-erasure";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub protocol_version: u8,
    pub operation_id: String,
    pub account_id: String,
    pub device_id: String,
    pub counter: i64,
    pub domain: String,
    pub key_epoch: u8,
}
impl Header {
    pub fn of(e: &Envelope) -> Self {
        Self {
            protocol_version: e.protocol_version,
            operation_id: e.operation_id.clone(),
            account_id: e.account_id.clone(),
            device_id: e.device_id.clone(),
            counter: e.counter,
            domain: e.domain.clone(),
            key_epoch: e.key_epoch,
        }
    }
    fn receipt(&self) -> Envelope {
        Envelope {
            protocol_version: self.protocol_version,
            operation_id: self.operation_id.clone(),
            account_id: self.account_id.clone(),
            device_id: self.device_id.clone(),
            counter: self.counter,
            domain: self.domain.clone(),
            key_epoch: self.key_epoch,
            nonce: String::new(),
            ciphertext: String::new(),
        }
    }
}

/// Fixed field array shared with JavaScript. JSON object member order is immaterial.
pub fn envelope_digest(e: &Envelope) -> String {
    let canonical = json!([
        e.protocol_version,
        e.operation_id,
        e.account_id,
        e.device_id,
        e.counter,
        e.domain,
        e.key_epoch,
        e.nonce,
        e.ciphertext
    ])
    .to_string();
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}
fn capable(headers: &HeaderMap) -> bool {
    headers.get(CAPABILITY).is_some_and(|v| v == "1")
}
pub(crate) async fn require_capability(
    conn: &mut SqliteConnection,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    let required: i64 =
        sqlx::query_scalar("SELECT history_erasure_version FROM settings WHERE id = 1")
            .fetch_one(&mut *conn)
            .await?;
    if required != 0 && !capable(headers) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "History erasure requires an upgraded client; retain local data and upgrade before syncing",
        ));
    }
    Ok(())
}
pub(crate) async fn matches_stored(
    conn: &mut SqliteConnection,
    envelope: &Envelope,
    encoded: &str,
) -> Result<bool, ApiError> {
    let digest: Option<String> =
        sqlx::query_scalar("SELECT original_digest FROM history_redactions WHERE operation_id = ?")
            .bind(&envelope.operation_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(digest.map_or_else(
        || serde_json::to_string(envelope).is_ok_and(|e| e == encoded),
        |digest| digest == envelope_digest(envelope),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Target {
    header: Header,
    digest: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Purge {
    expected_epoch: String,
    certificate: Envelope,
    targets: Vec<Target>,
}

pub(crate) async fn purge(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<Purge>,
) -> Result<Json<Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    if !capable(&headers) {
        return Err(ApiError(
            StatusCode::UPGRADE_REQUIRED,
            "History erasure capability required",
        ));
    }
    if request.expected_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Server epoch changed; recovery required",
        ));
    }
    validate(&request.certificate, &app, &author)?;
    if request.certificate.domain != "history-erasure"
        || request.targets.is_empty()
        || request.targets.len() > MAX_BATCH
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Erasure requires a certificate and 1–100 history targets",
        ));
    }
    let mut ids = HashSet::new();
    let mut counters = HashSet::new();
    for target in &request.targets {
        let h = &target.header;
        if h.protocol_version != 1
            || h.domain != "history"
            || h.key_epoch == 0
            || h.key_epoch > request.certificate.key_epoch
            || h.account_id != app.account_id
            || Uuid::parse_str(&h.operation_id).is_err()
            || Uuid::parse_str(&h.device_id).is_err()
            || h.counter < 1
            || h.counter > crate::MAX_SAFE_INTEGER
            || h.operation_id == request.certificate.operation_id
            || (h.device_id == author && h.counter >= request.certificate.counter)
            || !ids.insert(&h.operation_id)
            || !counters.insert((&h.device_id, h.counter))
            || target.digest.len() != 64
            || !target
                .digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Invalid history erasure target",
            ));
        }
    }
    let mut tx = app.pool.begin().await?;
    let allowed: bool = sqlx::query_scalar("SELECT revoked = 0 FROM devices WHERE id = ?")
        .bind(&author)
        .fetch_one(&mut *tx)
        .await?;
    if !allowed {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Device credentials revoked",
        ));
    }
    let before = sqlx::query("SELECT journal_bytes, journal_operations FROM settings WHERE id = 1")
        .fetch_one(&mut *tx)
        .await?;
    let certificate = &request.certificate;
    let encoded = serde_json::to_string(certificate).expect("envelope primitives");
    let existing = sqlx::query("SELECT sequence, envelope FROM operations WHERE operation_id = ?")
        .bind(&certificate.operation_id)
        .fetch_optional(&mut *tx)
        .await?;
    let certificate_sequence = if let Some(row) = existing {
        if row.get::<String, _>("envelope") != encoded {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Certificate identity was reused",
            ));
        }
        row.get::<i64, _>("sequence")
    } else {
        let current: u8 = sqlx::query_scalar("SELECT key_epoch FROM settings WHERE id = 1")
            .fetch_one(&mut *tx)
            .await?;
        if certificate.key_epoch != current {
            return Err(ApiError(
                StatusCode::PRECONDITION_FAILED,
                "Content-key epoch changed; refresh before erasure",
            ));
        }
        let reused: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE device_id = ? AND counter = ?)",
        )
        .bind(&author)
        .bind(certificate.counter)
        .fetch_one(&mut *tx)
        .await?;
        if reused {
            return Err(ApiError(StatusCode::CONFLICT, "Device counter was reused"));
        }
        hardening::reserve_sequence(&mut tx).await?;
        sqlx::query("INSERT INTO operations (operation_id, device_id, counter, envelope) VALUES (?, ?, ?, ?)")
            .bind(&certificate.operation_id).bind(&author).bind(certificate.counter).bind(encoded)
            .execute(&mut *tx).await?.last_insert_rowid()
    };
    // The immutable certificate also binds one public target set across lost replies.
    // The encrypted proof itself is verified by clients, never interpreted here.
    let mut sorted: Vec<_> = request.targets.iter().collect();
    sorted.sort_by(|a, b| a.header.operation_id.cmp(&b.header.operation_id));
    let public_targets: Vec<_> = sorted
        .iter()
        .map(|target| {
            let h = &target.header;
            json!([
                h.protocol_version,
                h.operation_id,
                h.account_id,
                h.device_id,
                h.counter,
                h.domain,
                h.key_epoch,
                target.digest
            ])
        })
        .collect();
    let request_digest = format!(
        "{:x}",
        Sha256::digest(json!(public_targets).to_string().as_bytes())
    );
    let old: Option<String> = sqlx::query_scalar(
        "SELECT request_digest FROM history_erasures WHERE certificate_operation_id = ?",
    )
    .bind(&certificate.operation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if old.as_ref().is_some_and(|old| old != &request_digest) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Certificate target set was changed",
        ));
    }
    if old.is_none() {
        sqlx::query(
            "INSERT INTO history_erasures (certificate_operation_id, request_digest) VALUES (?, ?)",
        )
        .bind(&certificate.operation_id)
        .bind(request_digest)
        .execute(&mut *tx)
        .await?;
    }
    let mut redactions = Vec::new();
    let mut latest = certificate_sequence;
    for target in request.targets {
        let h = &target.header;
        let row = sqlx::query("SELECT o.sequence, o.envelope, r.original_digest, r.certificate_operation_id FROM operations o LEFT JOIN history_redactions r ON r.operation_id = o.operation_id WHERE o.operation_id = ?")
            .bind(&h.operation_id).fetch_optional(&mut *tx).await?;
        let (sequence, proof) = if let Some(row) = row {
            let original: Envelope = serde_json::from_str(&row.get::<String, _>("envelope"))
                .map_err(|_| {
                    ApiError(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Stored history record is invalid",
                    )
                })?;
            let old_digest: Option<String> = row.get("original_digest");
            if Header::of(&original) != *h
                || old_digest
                    .clone()
                    .unwrap_or_else(|| envelope_digest(&original))
                    != target.digest
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "History target identity or digest conflicts",
                ));
            }
            let sequence = row.get::<i64, _>("sequence");
            if let Some(proof) = row.get::<Option<String>, _>("certificate_operation_id") {
                (sequence, proof)
            } else {
                sqlx::query(
                    "UPDATE operations SET envelope = ?, purged = 1 WHERE operation_id = ?",
                )
                .bind(serde_json::to_string(&h.receipt()).expect("header primitives"))
                .bind(&h.operation_id)
                .execute(&mut *tx)
                .await?;
                sqlx::query("INSERT INTO history_redactions (operation_id, original_digest, certificate_operation_id) VALUES (?, ?, ?)")
                    .bind(&h.operation_id).bind(&target.digest).bind(&certificate.operation_id).execute(&mut *tx).await?;
                (sequence, certificate.operation_id.clone())
            }
        } else {
            // Only an author may reserve its own unpublished identity. Other clients
            // cannot forge a counter reservation for an operation the relay never saw.
            if h.device_id != author {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Unknown history target belongs to another installation",
                ));
            }
            let reused: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE device_id = ? AND counter = ?)",
            )
            .bind(&author)
            .bind(h.counter)
            .fetch_one(&mut *tx)
            .await?;
            if reused {
                return Err(ApiError(StatusCode::CONFLICT, "Device counter was reused"));
            }
            hardening::reserve_sequence(&mut tx).await?;
            let sequence = sqlx::query("INSERT INTO operations (operation_id, device_id, counter, envelope, purged) VALUES (?, ?, ?, ?, 1)")
                .bind(&h.operation_id).bind(&author).bind(h.counter)
                .bind(serde_json::to_string(&h.receipt()).expect("header primitives"))
                .execute(&mut *tx).await?.last_insert_rowid();
            sqlx::query("INSERT INTO history_redactions (operation_id, original_digest, certificate_operation_id) VALUES (?, ?, ?)")
                .bind(&h.operation_id).bind(&target.digest).bind(&certificate.operation_id).execute(&mut *tx).await?;
            (sequence, certificate.operation_id.clone())
        };
        latest = latest.max(sequence);
        redactions.push(json!({"operation_id":h.operation_id,"sequence":sequence,"digest":target.digest,"certificate_operation_id":proof}));
    }
    let after = sqlx::query("SELECT journal_bytes, journal_operations, max_journal_bytes, max_operations FROM settings WHERE id = 1")
        .fetch_one(&mut *tx).await?;
    // A lowered/full budget still permits a cleanup that does not grow either
    // exceeded resource. A growing certificate/receipt set must fit the budget.
    for (used, max) in [
        ("journal_bytes", "max_journal_bytes"),
        ("journal_operations", "max_operations"),
    ] {
        if after.get::<i64, _>(used) > after.get::<i64, _>(max)
            && after.get::<i64, _>(used) > before.get::<i64, _>(used)
        {
            return Err(ApiError(
                StatusCode::INSUFFICIENT_STORAGE,
                "Erasure metadata exceeds the relay budget; retain the intent and retry after making space",
            ));
        }
    }
    sqlx::query("UPDATE settings SET history_erasure_version = 1 WHERE id = 1")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let _ = app.notifications.send(latest);
    Ok(Json(
        json!({"server_epoch":app.server_epoch,"certificate_sequence":certificate_sequence,"redactions":redactions}),
    ))
}
