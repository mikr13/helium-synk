use std::{path::Path, time::Duration};

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use tokio::sync::broadcast;
use uuid::Uuid;

const MAX_BATCH: usize = 100;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct App {
    pub pool: SqlitePool,
    pub account_id: String,
    pub server_epoch: String,
    pub sqlite_version: String,
    notifications: broadcast::Sender<i64>,
}

#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database request failed");
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database unavailable; retain pending work and retry",
        )
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0, self.1)
    }
}
impl std::error::Error for ApiError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub protocol_version: u8,
    pub operation_id: String,
    pub account_id: String,
    pub device_id: String,
    pub counter: i64,
    pub domain: String,
    pub key_epoch: u8,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Serialize, Deserialize)]
pub struct Credentials {
    pub account_id: String,
    pub device_id: String,
    pub token: String,
    pub server_url: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PushRequest {
    envelopes: Vec<Envelope>,
    expected_epoch: String,
}
#[derive(Serialize)]
struct Ack {
    operation_id: String,
    sequence: i64,
}
#[derive(Serialize)]
struct PushReply {
    server_epoch: String,
    acknowledgements: Vec<Ack>,
}
#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    cursor: i64,
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn patched_sqlite(version: &str) -> bool {
    let parts: Vec<u32> = version
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect();
    parts.as_slice() >= [3, 51, 3].as_slice()
        || (parts.len() == 3 && parts[0..2] == [3, 50] && parts[2] >= 7)
        || (parts.len() == 3 && parts[0..2] == [3, 44] && parts[2] >= 6)
}

impl App {
    pub async fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
                }
            }
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        // One connection deliberately serializes this personal relay's short writes.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&pool)
            .await?;
        if !patched_sqlite(&sqlite_version) {
            return Err(format!("SQLite {sqlite_version} lacks the WAL-reset fix. Use SQLite >= 3.51.3 (or patched 3.50.7/3.44.6).").into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        sqlx::migrate!().run(&pool).await?;
        sqlx::query(
            "INSERT OR IGNORE INTO settings (id, account_id, server_epoch) VALUES (1, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await?;
        let row = sqlx::query("SELECT account_id, server_epoch FROM settings WHERE id = 1")
            .fetch_one(&pool)
            .await?;
        let (notifications, _) = broadcast::channel(64);
        Ok(Self {
            pool,
            account_id: row.get("account_id"),
            server_epoch: row.get("server_epoch"),
            sqlite_version,
            notifications,
        })
    }

    pub async fn issue_device(
        &self,
        name: &str,
        server_url: &str,
    ) -> Result<Credentials, ApiError> {
        if name.trim().is_empty() || name.len() > 100 {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Device name must contain 1–100 bytes",
            ));
        }
        let mut secret = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        let token: String = secret.iter().map(|b| format!("{b:02x}")).collect();
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO devices (id, name, token_hash) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(name)
            .bind(token_hash(&token))
            .execute(&self.pool)
            .await?;
        Ok(Credentials {
            account_id: self.account_id.clone(),
            device_id: id,
            token,
            server_url: server_url.to_owned(),
            name: name.to_owned(),
        })
    }
    pub async fn revoke(&self, device_id: &str) -> Result<bool, ApiError> {
        let result = sqlx::query("UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0")
            .bind(device_id)
            .execute(&self.pool)
            .await?;
        // Wake active sockets so revocation is rechecked even without new operations.
        let _ = self.notifications.send(0);
        Ok(result.rows_affected() > 0)
    }
    async fn authenticate(&self, token: &str) -> Result<String, ApiError> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "Invalid device credentials",
            ));
        }
        sqlx::query_scalar("SELECT id FROM devices WHERE token_hash = ? AND revoked = 0")
            .bind(token_hash(token))
            .fetch_optional(&self.pool)
            .await?
            .ok_or(ApiError(
                StatusCode::UNAUTHORIZED,
                "Invalid device credentials",
            ))
    }
    async fn bearer(&self, headers: &HeaderMap) -> Result<String, ApiError> {
        let token = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError(
                StatusCode::UNAUTHORIZED,
                "Device credentials required",
            ))?;
        self.authenticate(token).await
    }
}

pub fn router(app: App) -> Router {
    Router::new()
        .route(
            "/health/live",
            get(|| async { Json(serde_json::json!({"status": "live"})) }),
        )
        .route("/health/ready", get(ready))
        .route("/v1/sync/push", post(push))
        .route("/v1/sync/pull", get(pull))
        .route("/v1/events", get(events))
        .layer(DefaultBodyLimit::max(1_048_576))
        .with_state(app)
}

async fn ready(State(app): State<App>) -> Result<Json<serde_json::Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&app.pool).await?;
    Ok(Json(
        serde_json::json!({"status": "ready", "protocol_version": 1, "server_epoch": app.server_epoch, "sqlite_version": app.sqlite_version}),
    ))
}

fn validate(e: &Envelope, app: &App, author: &str) -> Result<(), ApiError> {
    if e.protocol_version != 1
        || e.domain != "diagnostic"
        || e.key_epoch != 1
        || e.device_id != author
        || e.account_id != app.account_id
        || Uuid::parse_str(&e.operation_id).is_err()
        || e.counter < 1
        || e.counter > MAX_SAFE_INTEGER
        || e.ciphertext.len() > 90_000
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid or unsupported encrypted envelope",
        ));
    }
    let nonce = STANDARD
        .decode(&e.nonce)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid nonce"))?;
    let ciphertext = STANDARD
        .decode(&e.ciphertext)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid ciphertext"))?;
    if nonce.len() != 12 || ciphertext.len() < 16 || ciphertext.len() > 65_536 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid encrypted payload size",
        ));
    }
    Ok(())
}

async fn push(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<PushRequest>,
) -> Result<Json<PushReply>, ApiError> {
    let author = app.bearer(&headers).await?;
    if request.expected_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Server epoch changed; recovery required",
        ));
    }
    if request.envelopes.is_empty() || request.envelopes.len() > MAX_BATCH {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Batch must contain 1–100 records",
        ));
    }
    for envelope in &request.envelopes {
        validate(envelope, &app, &author)?;
    }
    let mut tx = app.pool.begin().await?;
    let mut acknowledgements = Vec::new();
    let mut latest = 0;
    for envelope in &request.envelopes {
        let encoded =
            serde_json::to_string(envelope).expect("envelope contains serializable primitives");
        let existing =
            sqlx::query("SELECT sequence, envelope FROM operations WHERE operation_id = ?")
                .bind(&envelope.operation_id)
                .fetch_optional(&mut *tx)
                .await?;
        let sequence = if let Some(row) = existing {
            if row.get::<String, _>("envelope") != encoded {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Operation ID was reused with different contents",
                ));
            }
            row.get::<i64, _>("sequence")
        } else {
            let reused: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM operations WHERE device_id = ? AND counter = ?",
            )
            .bind(&author)
            .bind(envelope.counter)
            .fetch_one(&mut *tx)
            .await?;
            if reused > 0 {
                return Err(ApiError(StatusCode::CONFLICT, "Device counter was reused"));
            }
            let result = sqlx::query("INSERT INTO operations (operation_id, device_id, counter, envelope) VALUES (?, ?, ?, ?)")
                .bind(&envelope.operation_id).bind(&author).bind(envelope.counter).bind(encoded).execute(&mut *tx).await?;
            result.last_insert_rowid()
        };
        latest = latest.max(sequence);
        acknowledgements.push(Ack {
            operation_id: envelope.operation_id.clone(),
            sequence,
        });
    }
    tx.commit().await?;
    let _ = app.notifications.send(latest);
    Ok(Json(PushReply {
        server_epoch: app.server_epoch,
        acknowledgements,
    }))
}

async fn pull(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<PullQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    app.bearer(&headers).await?;
    if query.cursor < 0 || query.cursor > MAX_SAFE_INTEGER {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Invalid cursor"));
    }
    let latest: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) FROM operations")
        .fetch_one(&app.pool)
        .await?;
    if query.cursor > latest {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Cursor is ahead of server history; recovery required",
        ));
    }
    let rows = sqlx::query(
        "SELECT sequence, envelope FROM operations WHERE sequence > ? ORDER BY sequence LIMIT 101",
    )
    .bind(query.cursor)
    .fetch_all(&app.pool)
    .await?;
    let has_more = rows.len() > MAX_BATCH;
    let mut records = Vec::new();
    let mut cursor = query.cursor;
    for row in rows.into_iter().take(MAX_BATCH) {
        cursor = row.get("sequence");
        let envelope: serde_json::Value = serde_json::from_str(&row.get::<String, _>("envelope"))
            .map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Stored envelope is invalid",
            )
        })?;
        records.push(serde_json::json!({"sequence": cursor, "envelope": envelope}));
    }
    Ok(Json(
        serde_json::json!({"server_epoch": app.server_epoch, "records": records, "next_cursor": cursor, "has_more": has_more}),
    ))
}

async fn events(
    State(app): State<App>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    // No browser site may drive this socket. Authentication remains mandatory, including for CLI clients without Origin.
    if let Some(origin) = headers.get("origin") {
        if !origin
            .to_str()
            .is_ok_and(|s| s.starts_with("chrome-extension://"))
        {
            return Err(ApiError(StatusCode::FORBIDDEN, "Extension origin required"));
        }
    }
    Ok(ws
        .max_message_size(4_096)
        .max_frame_size(4_096)
        .on_upgrade(move |socket| socket_loop(socket, app)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SocketAuth {
    token: String,
}
async fn socket_loop(socket: WebSocket, app: App) {
    let (mut sender, mut receiver) = socket.split();
    let first = tokio::time::timeout(Duration::from_secs(5), receiver.next()).await;
    let token = match first {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<SocketAuth>(&text)
            .ok()
            .map(|a| a.token),
        _ => None,
    };
    let Some(token) = token else {
        return;
    };
    if app.authenticate(&token).await.is_err() {
        return;
    }
    let mut notifications = app.notifications.subscribe();
    let ready = serde_json::json!({"type": "ready", "server_epoch": app.server_epoch});
    if sender
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    loop {
        let message = tokio::select! {
            event = notifications.recv() => match event {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => serde_json::json!({"type": "sync_available"}),
                Err(_) => break,
            },
            _ = heartbeat.tick() => serde_json::json!({"type": "ping"}),
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(text))) if text.as_str() == "pong" || text.as_str() == "ping" => serde_json::json!({"type": "pong"}),
                Some(Ok(Message::Ping(bytes))) => {
                    if sender.send(Message::Pong(bytes)).await.is_err() { break; }
                    continue;
                },
                _ => break,
            },
        };
        if app.authenticate(&token).await.is_err() {
            break;
        }
        if !matches!(
            tokio::time::timeout(
                Duration::from_secs(5),
                sender.send(Message::Text(message.to_string().into()))
            )
            .await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
    let _ = sender.close().await;
}
