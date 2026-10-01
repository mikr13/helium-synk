use crate::{Ack, ApiError, App, Envelope, MAX_BATCH, STANDARD, token_hash, validate};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;
use uuid::Uuid;

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn encoded(value: &str, size: usize) -> bool {
    STANDARD
        .decode(value)
        .is_ok_and(|raw| raw.len() == size && STANDARD.encode(raw) == value)
}
pub(crate) fn valid_public(value: &str) -> bool {
    encoded(value, 65) && STANDARD.decode(value).is_ok_and(|raw| raw[0] == 4)
}
pub(crate) fn valid_proof(value: &str) -> bool {
    encoded(value, 32)
}
// The relay validates encoding only. Clients verify curve points and keyed proofs.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentityRequest {
    server_epoch: String,
    public_key: String,
    proof_epoch: u8,
    proof: String,
}
pub(crate) async fn active(conn: &mut SqliteConnection, device: &str) -> Result<(), ApiError> {
    let allowed: bool = sqlx::query_scalar("SELECT revoked = 0 FROM devices WHERE id = ?")
        .bind(device)
        .fetch_one(conn)
        .await?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Device credentials revoked",
        ))
    }
}
pub(crate) async fn identity(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<IdentityRequest>,
) -> Result<Json<Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    if request.server_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Server epoch changed; recovery required",
        ));
    }
    if !valid_public(&request.public_key)
        || !valid_proof(&request.proof)
        || request.proof_epoch == 0
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid installation wrapping identity",
        ));
    }
    let mut tx = app.pool.begin().await?;
    active(&mut tx, &author).await?;
    let row = sqlx::query("SELECT wrapping_public_key, wrapping_proof, wrapping_proof_epoch FROM devices WHERE id = ?")
        .bind(&author).fetch_one(&mut *tx).await?;
    if let Some(existing) = row.get::<Option<String>, _>("wrapping_public_key") {
        if existing != request.public_key
            || row.get::<Option<String>, _>("wrapping_proof").as_deref() != Some(&request.proof)
            || row.get::<Option<u8>, _>("wrapping_proof_epoch") != Some(request.proof_epoch)
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Installation wrapping identity is immutable; enroll a fresh installation",
            ));
        }
    } else {
        let current: u8 = sqlx::query_scalar("SELECT key_epoch FROM settings WHERE id = 1")
            .fetch_one(&mut *tx)
            .await?;
        if current != request.proof_epoch {
            return Err(ApiError(
                StatusCode::PRECONDITION_FAILED,
                "Refresh content keys before registering an installation wrapping identity",
            ));
        }
        sqlx::query("UPDATE devices SET wrapping_public_key = ?, wrapping_proof = ?, wrapping_proof_epoch = ? WHERE id = ?")
            .bind(&request.public_key).bind(&request.proof).bind(request.proof_epoch).bind(&author).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"server_epoch":app.server_epoch,"device_id":author,"public_key":request.public_key,
        "proof_epoch":request.proof_epoch,"proof":request.proof}),
    ))
}
#[derive(Deserialize)]
pub(crate) struct StateQuery {
    #[serde(default)]
    after_epoch: u8,
}
pub(crate) async fn state(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<StateQuery>,
) -> Result<Json<Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    let mut tx = app.pool.begin().await?;
    active(&mut tx, &author).await?;
    let current: u8 = sqlx::query_scalar("SELECT key_epoch FROM settings WHERE id = 1")
        .fetch_one(&mut *tx)
        .await?;
    if query.after_epoch > current {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Content-key history is behind this installation; recovery required",
        ));
    }
    let devices = sqlx::query("SELECT id, name, revoked, wrapping_public_key, wrapping_proof, wrapping_proof_epoch FROM devices ORDER BY id")
        .fetch_all(&mut *tx).await?.into_iter().map(|row| json!({"device_id":row.get::<String,_>("id"),
            "name":row.get::<String,_>("name"),"revoked":row.get::<bool,_>("revoked"),
            "public_key":row.get::<Option<String>,_>("wrapping_public_key"),"proof":row.get::<Option<String>,_>("wrapping_proof"),
            "proof_epoch":row.get::<Option<u8>,_>("wrapping_proof_epoch")})).collect::<Vec<_>>();
    let rows = sqlx::query("SELECT packet FROM key_packets WHERE recipient_id = ? AND key_epoch > ? ORDER BY key_epoch LIMIT 33")
        .bind(&author).bind(query.after_epoch).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > 32;
    let own = sqlx::query("SELECT counter, operation_id FROM operations WHERE device_id = ? ORDER BY counter DESC LIMIT 1")
        .bind(&author).fetch_optional(&mut *tx).await?;
    let author_counter = own.as_ref().map_or(0, |r| r.get::<i64, _>("counter"));
    let author_operation_id = own.map(|r| r.get::<String, _>("operation_id"));
    let packets: Vec<Value> = rows
        .into_iter()
        .take(32)
        .map(|row| serde_json::from_str(&row.get::<String, _>("packet")))
        .collect::<Result<_, _>>()
        .map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Stored key packet is invalid",
            )
        })?;
    tx.commit().await?;
    Ok(Json(
        json!({"account_id":app.account_id,"server_epoch":app.server_epoch,"key_epoch":current,"devices":devices,"packets":packets,"has_more":has_more,
        "author_counter":author_counter,"author_operation_id":author_operation_id}),
    ))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    version: u8,
    rotation_id: String,
    account_id: String,
    server_epoch: String,
    issuer_id: String,
    from_epoch: u8,
    key_epoch: u8,
    recipient_id: String,
    recipient_public_key: String,
    ephemeral_public_key: String,
    nonce: String,
    ciphertext: String,
    proof: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rotation {
    rotation_id: String,
    server_epoch: String,
    from_epoch: u8,
    key_epoch: u8,
    revoke_ids: Vec<String>,
    packets: Vec<Packet>,
}
pub(crate) async fn rotate(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<Rotation>,
) -> Result<Json<Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    if request.server_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Server epoch changed; recovery required",
        ));
    }
    if !uuid(&request.rotation_id)
        || request.from_epoch == 0
        || request.from_epoch.checked_add(1) != Some(request.key_epoch)
        || request.revoke_ids.len() > 256
        || request.packets.is_empty()
        || request.packets.len() > 256
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid content-key rotation",
        ));
    }
    let revoke: HashSet<_> = request.revoke_ids.iter().collect();
    if revoke.len() != request.revoke_ids.len()
        || revoke.contains(&author)
        || !revoke.iter().all(|id| uuid(id))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid revoked installation set",
        ));
    }
    let mut recipients = HashSet::new();
    for packet in &request.packets {
        if packet.version != 1
            || packet.rotation_id != request.rotation_id
            || packet.account_id != app.account_id
            || packet.server_epoch != app.server_epoch
            || packet.issuer_id != author
            || packet.from_epoch != request.from_epoch
            || packet.key_epoch != request.key_epoch
            || !uuid(&packet.recipient_id)
            || !recipients.insert(&packet.recipient_id)
            || !valid_public(&packet.recipient_public_key)
            || !valid_public(&packet.ephemeral_public_key)
            || !encoded(&packet.nonce, 12)
            || !encoded(&packet.ciphertext, 48)
            || !valid_proof(&packet.proof)
        {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Invalid encrypted content-key packet",
            ));
        }
    }
    let hash = token_hash(&serde_json::to_string(&request).expect("rotation primitives"));
    let mut tx = app.pool.begin().await?;
    active(&mut tx, &author).await?;
    let prior = sqlx::query(
        "SELECT key_epoch, issuer_id, request_hash FROM key_rotations WHERE rotation_id = ?",
    )
    .bind(&request.rotation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(prior) = prior {
        if prior.get::<String, _>("issuer_id") != author
            || prior.get::<String, _>("request_hash") != hash
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Rotation identity was reused with different contents",
            ));
        }
        return Ok(Json(
            json!({"server_epoch":app.server_epoch,"rotation_id":request.rotation_id,"key_epoch":prior.get::<u8,_>("key_epoch")}),
        ));
    }
    let current: u8 = sqlx::query_scalar("SELECT key_epoch FROM settings WHERE id = 1")
        .fetch_one(&mut *tx)
        .await?;
    if request.from_epoch != current {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "Content-key epoch changed; retain the proposed rotation and review current keys",
        ));
    }
    let rows = sqlx::query("SELECT id, revoked, wrapping_public_key FROM devices ORDER BY id")
        .fetch_all(&mut *tx)
        .await?;
    let mut retained = 0;
    for row in rows {
        let id = row.get::<String, _>("id");
        let removed = revoke.contains(&id);
        if row.get::<bool, _>("revoked") || removed {
            if recipients.contains(&id) {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Removed installation must not receive a new key packet",
                ));
            }
            continue;
        }
        retained += 1;
        let public = row.get::<Option<String>,_>("wrapping_public_key").ok_or(ApiError(StatusCode::CONFLICT,
            "A retained installation lacks a wrapping key; upgrade it or explicitly remove it before rotation"))?;
        if !request
            .packets
            .iter()
            .any(|p| p.recipient_id == id && p.recipient_public_key == public)
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Retained installation set or wrapping keys changed; refresh before rotation",
            ));
        }
    }
    for id in &request.revoke_ids {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE id = ?)")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if !exists {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Unknown revoked installation",
            ));
        }
    }
    if retained != request.packets.len() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Key packets must match every retained installation exactly",
        ));
    }
    sqlx::query(
        "INSERT INTO key_rotations (key_epoch,rotation_id,issuer_id,request_hash) VALUES (?,?,?,?)",
    )
    .bind(request.key_epoch)
    .bind(&request.rotation_id)
    .bind(&author)
    .bind(hash)
    .execute(&mut *tx)
    .await?;
    for packet in &request.packets {
        sqlx::query("INSERT INTO key_packets (key_epoch,recipient_id,packet) VALUES (?,?,?)")
            .bind(request.key_epoch)
            .bind(&packet.recipient_id)
            .bind(serde_json::to_string(packet).expect("packet primitives"))
            .execute(&mut *tx)
            .await?;
    }
    for id in &request.revoke_ids {
        sqlx::query("UPDATE devices SET revoked = 1 WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE settings SET key_epoch = ? WHERE id = 1")
        .bind(request.key_epoch)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let _ = app.notifications.send(0);
    Ok(Json(
        json!({"server_epoch":app.server_epoch,"rotation_id":request.rotation_id,"key_epoch":request.key_epoch}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RekeyCheck {
    server_epoch: String,
    key_epoch: u8,
    envelopes: Vec<Envelope>,
}
pub(crate) async fn rekey_check(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<RekeyCheck>,
) -> Result<Json<Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    if request.server_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Server epoch changed; recovery required",
        ));
    }
    if request.envelopes.is_empty() || request.envelopes.len() > MAX_BATCH {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Rekey check must contain 1–100 records",
        ));
    }
    let mut ids = HashSet::new();
    let mut counters = HashSet::new();
    for envelope in &request.envelopes {
        validate(envelope, &app, &author)?;
        if envelope.key_epoch >= request.key_epoch
            || !ids.insert(&envelope.operation_id)
            || !counters.insert(envelope.counter)
        {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Rekey checks require distinct records from older key epochs",
            ));
        }
    }
    let mut tx = app.pool.begin().await?;
    active(&mut tx, &author).await?;
    let current: u8 = sqlx::query_scalar("SELECT key_epoch FROM settings WHERE id = 1")
        .fetch_one(&mut *tx)
        .await?;
    if current != request.key_epoch {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "Content-key epoch changed; refresh before checking queued records",
        ));
    }
    let mut committed = Vec::new();
    let mut missing = Vec::new();
    for envelope in &request.envelopes {
        let row = sqlx::query("SELECT sequence, envelope FROM operations WHERE operation_id = ?")
            .bind(&envelope.operation_id)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(row) = row {
            if row.get::<String, _>("envelope")
                != serde_json::to_string(envelope).expect("envelope primitives")
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Committed record differs from the queued envelope; retain it for recovery",
                ));
            }
            committed.push(Ack {
                operation_id: envelope.operation_id.clone(),
                sequence: row.get("sequence"),
            });
        } else {
            let reused: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE device_id = ? AND counter = ?)",
            )
            .bind(&author)
            .bind(envelope.counter)
            .fetch_one(&mut *tx)
            .await?;
            if reused {
                return Err(ApiError(StatusCode::CONFLICT, "Device counter was reused"));
            }
            missing.push(envelope.operation_id.clone());
        }
    }
    // A record proved missing cannot later commit with its old epoch: push checks
    // the monotonically newer epoch in its insertion transaction.
    tx.commit().await?;
    Ok(Json(
        json!({"server_epoch":app.server_epoch,"key_epoch":current,"committed":committed,"missing":missing}),
    ))
}
