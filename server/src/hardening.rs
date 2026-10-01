use crate::{ApiError, App, MAX_SAFE_INTEGER};
use axum::{
    Json,
    extract::{Request, State},
    http::HeaderMap,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_journal_bytes: i64,
    pub max_operations: i64,
    pub max_devices: i64,
}
impl App {
    pub fn initiate_shutdown(&self) {
        self.shutdown.send_replace(true);
    }
    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown.borrow()
    }
    pub async fn configure_limits(&self, limits: Limits) -> Result<(), ApiError> {
        if limits.max_journal_bytes < 1
            || limits.max_journal_bytes > MAX_SAFE_INTEGER
            || limits.max_operations < 1
            || limits.max_operations > MAX_SAFE_INTEGER
            || !(1..=256).contains(&limits.max_devices)
        {
            return Err(ApiError(StatusCode::BAD_REQUEST, "Invalid relay limits"));
        }
        // Lowering a budget does not delete records or prevent an identical retry.
        sqlx::query("UPDATE settings SET max_journal_bytes = ?, max_operations = ?, max_devices = ? WHERE id = 1")
            .bind(limits.max_journal_bytes).bind(limits.max_operations).bind(limits.max_devices).execute(&self.pool).await?;
        Ok(())
    }
}
pub(crate) async fn guard(State(app): State<App>, request: Request, next: Next) -> Response {
    if app.is_shutting_down() {
        return ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Relay is shutting down; retain pending work",
        )
        .into_response();
    }
    let Ok(_permit) = app.requests.clone().try_acquire_owned() else {
        return ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Relay request capacity reached; retain pending work and retry",
        )
        .into_response();
    };
    match tokio::time::timeout(Duration::from_secs(15), next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError(
            StatusCode::REQUEST_TIMEOUT,
            "Relay request timed out; retain pending work and retry identically",
        )
        .into_response(),
    }
}
pub(crate) async fn reserve_insert(
    conn: &mut SqliteConnection,
    bytes: usize,
) -> Result<(), ApiError> {
    let row = sqlx::query("SELECT journal_bytes, journal_operations, max_journal_bytes, max_operations FROM settings WHERE id = 1").fetch_one(&mut *conn).await?;
    if row.get::<i64, _>("journal_operations") >= row.get::<i64, _>("max_operations")
        || row
            .get::<i64, _>("journal_bytes")
            .checked_add(bytes as i64)
            .is_none_or(|sum| sum > row.get::<i64, _>("max_journal_bytes"))
    {
        return Err(ApiError(
            StatusCode::INSUFFICIENT_STORAGE,
            "Relay account quota reached; retain pending work and increase the budget or reclaim storage",
        ));
    }
    reserve_sequence(conn).await
}
pub(crate) async fn reserve_sequence(conn: &mut SqliteConnection) -> Result<(), ApiError> {
    let latest: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'operations'),0)",
    )
    .fetch_one(&mut *conn)
    .await?;
    if latest >= MAX_SAFE_INTEGER {
        return Err(ApiError(
            StatusCode::INSUFFICIENT_STORAGE,
            "Relay sequence exhausted; retain pending work and recover the relay",
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgressRequest {
    server_epoch: String,
    cursor: i64,
}
pub(crate) async fn acknowledge(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<ProgressRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    if request.server_epoch != app.server_epoch {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Server epoch changed; recovery required",
        ));
    }
    if !(0..=MAX_SAFE_INTEGER).contains(&request.cursor) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid processed cursor",
        ));
    }
    let mut tx = app.pool.begin().await?;
    let row = sqlx::query(
        "SELECT sent_cursor, processed_cursor, processed_epoch, revoked FROM devices WHERE id = ?",
    )
    .bind(&author)
    .fetch_one(&mut *tx)
    .await?;
    if row.get::<i64, _>("revoked") != 0 {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Device credentials revoked",
        ));
    }
    if request.cursor > row.get::<i64, _>("sent_cursor") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Processed cursor exceeds delivered progress",
        ));
    }
    let previous =
        if row.get::<Option<String>, _>("processed_epoch").as_deref() == Some(&app.server_epoch) {
            row.get::<i64, _>("processed_cursor")
        } else {
            0
        };
    let processed = previous.max(request.cursor);
    sqlx::query("UPDATE devices SET processed_cursor = ?, processed_epoch = ?, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(processed).bind(&app.server_epoch).bind(&author).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        serde_json::json!({"server_epoch":app.server_epoch,"processed_cursor":processed}),
    ))
}
pub(crate) async fn status(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let author = app.bearer(&headers).await?;
    let row = sqlx::query("SELECT s.*, d.processed_cursor, d.processed_epoch, d.last_seen, (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM devices WHERE revoked = 0) AS active_devices, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'operations'),0) AS latest_sequence FROM settings s JOIN devices d ON d.id = ? WHERE s.id = 1")
        .bind(author).fetch_one(&app.pool).await?;
    Ok(Json(
        serde_json::json!({"server_epoch":app.server_epoch,"protocol_version":1,"schema_version":crate::SCHEMA_VERSION,
        "package_version":env!("CARGO_PKG_VERSION"),"sqlite_version":app.sqlite_version,"key_epoch":row.get::<i64,_>("key_epoch"),
        "journal_bytes":row.get::<i64,_>("journal_bytes"),"journal_operations":row.get::<i64,_>("journal_operations"),
        "max_journal_bytes":row.get::<i64,_>("max_journal_bytes"),"max_operations":row.get::<i64,_>("max_operations"),
        "max_devices":row.get::<i64,_>("max_devices"),"devices":row.get::<i64,_>("devices"),"active_devices":row.get::<i64,_>("active_devices"),
        "processed_cursor":row.get::<i64,_>("processed_cursor"),"processed_epoch":row.get::<Option<String>,_>("processed_epoch"),
        "last_seen":row.get::<Option<String>,_>("last_seen"),"latest_sequence":row.get::<i64,_>("latest_sequence"),
        "history_erasure_version":row.get::<i64,_>("history_erasure_version"),
        "history_identity_receipts":sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM history_redactions").fetch_one(&app.pool).await?}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    #[tokio::test]
    async fn request_cap_timeout_and_shutdown_release_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let app = App::open(&temp.path().join("guard.sqlite")).await.unwrap();
        let held = app.requests.clone().acquire_many_owned(32).await.unwrap();
        let response = crate::router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(held);
        let response = crate::router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // No database work under virtual time: exercise cancellation of a blocked handler.
        tokio::time::pause();
        let blocked = Router::new()
            .route(
                "/blocked",
                get(|| async { std::future::pending::<Response>().await }),
            )
            .layer(axum::middleware::from_fn_with_state(app.clone(), guard));
        let response = blocked
            .oneshot(
                Request::builder()
                    .uri("/blocked")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(app.requests.available_permits(), 32);
        tokio::time::resume();
        app.initiate_shutdown();
        let response = crate::router(app.clone())
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
