use crate::{ApiError, App, token_hash};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const INVITE_LIFETIME: i64 = 15 * 60;
// An already-committed claim can retry for one hour after expiry with the same
// client-generated API secret. Expired invitations never accept a new claim.
const CLAIM_RETRY_GRACE: i64 = 60 * 60;
fn now() -> Result<i64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_secs() as i64)
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "Relay clock unavailable"))
}
fn valid_secret(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) async fn invite(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let issuer = app.bearer(&headers).await?;
    let timestamp = now()?;
    let mut tx = app.pool.begin().await?;
    let allowed: bool = sqlx::query_scalar("SELECT revoked = 0 FROM devices WHERE id = ?")
        .bind(&issuer)
        .fetch_one(&mut *tx)
        .await?;
    if !allowed {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Device credentials revoked",
        ));
    }
    sqlx::query("DELETE FROM pairing_invites WHERE expires_at + ? < ?")
        .bind(CLAIM_RETRY_GRACE)
        .bind(timestamp)
        .execute(&mut *tx)
        .await?;
    let outstanding: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pairing_invites WHERE claimed_device_id IS NULL AND expires_at > ?",
    )
    .bind(timestamp)
    .fetch_one(&mut *tx)
    .await?;
    if outstanding >= 16 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many active pairing invitations; wait for expiry",
        ));
    }
    // Bound spent/expired retry rows as well as outstanding invitations.
    let recent: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_invites")
        .fetch_one(&mut *tx)
        .await?;
    if recent >= 64 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Pairing invitation capacity reached; wait for expiry",
        ));
    }
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let token: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
    let expires_at = timestamp + INVITE_LIFETIME;
    sqlx::query(
        "INSERT INTO pairing_invites (invitation_hash,issuer_id,expires_at) VALUES (?,?,?)",
    )
    .bind(token_hash(&token))
    .bind(issuer)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"account_id":app.account_id,"server_epoch":app.server_epoch,"invitation_token":token,"expires_at":expires_at}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Registration {
    invitation_token: String,
    account_id: String,
    expected_epoch: String,
    device_id: String,
    name: String,
    token: String,
}
pub(crate) async fn register(
    State(app): State<App>,
    Json(request): Json<Registration>,
) -> Result<Json<Value>, ApiError> {
    if request.account_id != app.account_id || request.expected_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Pairing account or server epoch changed; obtain a new bundle",
        ));
    }
    if !valid_secret(&request.invitation_token)
        || !valid_secret(&request.token)
        || !Uuid::parse_str(&request.device_id).is_ok_and(|id| id.to_string() == request.device_id)
        || request.name.trim().is_empty()
        || request.name != request.name.trim()
        || request.name.len() > 100
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Invalid pairing claim"));
    }
    let timestamp = now()?;
    let mut tx = app.pool.begin().await?;
    let row = sqlx::query("SELECT i.*, d.revoked AS issuer_revoked FROM pairing_invites i JOIN devices d ON d.id = i.issuer_id WHERE invitation_hash = ?")
        .bind(token_hash(&request.invitation_token)).fetch_optional(&mut *tx).await?
        .ok_or(ApiError(StatusCode::GONE, "Pairing invitation unavailable or expired"))?;
    let expiry: i64 = row.get("expires_at");
    if row.get::<i64, _>("issuer_revoked") != 0 || timestamp >= expiry + CLAIM_RETRY_GRACE {
        return Err(ApiError(
            StatusCode::GONE,
            "Pairing invitation unavailable or expired",
        ));
    }
    let api_hash = token_hash(&request.token);
    let claim_hash = token_hash(
        &serde_json::to_string(&(&request.device_id, &request.name, &api_hash))
            .expect("claim primitives"),
    );
    if let Some(claimed) = row.get::<Option<String>, _>("claimed_device_id") {
        if claimed != request.device_id
            || row.get::<Option<String>, _>("claim_hash").as_deref() != Some(claim_hash.as_str())
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Pairing invitation already claimed by another installation",
            ));
        }
        let allowed: bool =
            sqlx::query_scalar("SELECT revoked = 0 AND token_hash = ? FROM devices WHERE id = ?")
                .bind(&api_hash)
                .bind(&claimed)
                .fetch_one(&mut *tx)
                .await?;
        if !allowed {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "Paired device credentials revoked or replaced",
            ));
        }
    } else {
        if timestamp >= expiry {
            return Err(ApiError(
                StatusCode::GONE,
                "Pairing invitation unavailable or expired",
            ));
        }
        let available: bool = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM devices) < max_devices FROM settings WHERE id = 1",
        )
        .fetch_one(&mut *tx)
        .await?;
        if !available {
            return Err(ApiError(
                StatusCode::INSUFFICIENT_STORAGE,
                "Installation limit reached; pairing claim retained for retry",
            ));
        }
        let conflict: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE id = ? OR token_hash = ?")
                .bind(&request.device_id)
                .bind(&api_hash)
                .fetch_one(&mut *tx)
                .await?;
        if conflict != 0 {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Pairing installation identity already exists",
            ));
        }
        sqlx::query("INSERT INTO devices (id,name,token_hash) VALUES (?,?,?)")
            .bind(&request.device_id)
            .bind(&request.name)
            .bind(&api_hash)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE pairing_invites SET claimed_device_id = ?, claim_hash = ? WHERE invitation_hash = ?").bind(&request.device_id).bind(claim_hash).bind(token_hash(&request.invitation_token)).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"account_id":app.account_id,"server_epoch":app.server_epoch,"device_id":request.device_id,"name":request.name}),
    ))
}
