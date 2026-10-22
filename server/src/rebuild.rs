//! Offline, create-only reconstruction. The input is a private client-authorized replay,
//! not a relay backup and never contains content keys. Only the exporting author retains access.
use crate::{
    App, Envelope,
    history_erasure::{Header, Target, envelope_digest, target_digest},
    recovery::{RelayLease, verify_backup},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    format: String,
    version: u8,
    recovery_id: String,
    account_id: String,
    previous_server_epoch: String,
    server_epoch: String,
    key_epoch: u8,
    source: Source,
    entries: Vec<Entry>,
    manifest_digest: String,
    purges: Vec<PurgeReceipt>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PurgeReceipt {
    certificate_operation_id: String,
    targets: Vec<Target>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    device_id: String,
    name: String,
    token: String,
    identity: Identity,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device_id: String,
    public_key: String,
    proof_epoch: u8,
    proof: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    envelope: Envelope,
    redacted: Option<Redaction>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Redaction {
    digest: String,
    certificate_operation_id: String,
}
fn uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate(bundle: &Bundle, expected_account: &str) -> Result<()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    if bundle.format != "helium-synk-relay-recovery"
        || bundle.version != 1
        || bundle.account_id != expected_account
        || !uuid(&bundle.account_id)
        || !uuid(&bundle.server_epoch)
        || !uuid(&bundle.previous_server_epoch)
        || bundle.server_epoch == bundle.previous_server_epoch
        || !uuid(&bundle.recovery_id)
        || bundle.key_epoch < 2
        || !uuid(&bundle.source.device_id)
        || bundle.source.name.trim().is_empty()
        || bundle.source.name.len() > 100
        || !digest(&bundle.source.token)
        || bundle.source.identity.device_id != bundle.source.device_id
        || bundle.source.identity.proof_epoch != bundle.key_epoch
        || STANDARD
            .decode(&bundle.source.identity.public_key)
            .map_or(true, |b| b.len() != 65 || b[0] != 4)
        || STANDARD
            .decode(&bundle.source.identity.proof)
            .map_or(true, |b| b.len() != 32)
        || bundle.entries.len() > 1_000_000
    {
        return Err("Invalid recovery account, source, epochs or public identity.".into());
    }
    let mut ids = HashMap::new();
    let mut counters = HashSet::new();
    let mut manifest = Vec::new();
    let mut previous = "";
    for entry in &bundle.entries {
        let e = &entry.envelope;
        if !uuid(&e.operation_id)
            || !uuid(&e.device_id)
            || e.account_id != bundle.account_id
            || e.protocol_version != 1
            || e.key_epoch == 0
            || e.key_epoch >= bundle.key_epoch
            || e.counter < 1
            || e.counter > crate::MAX_SAFE_INTEGER
            || e.operation_id.as_str() <= previous
            || !counters.insert((&e.device_id, e.counter))
            || !matches!(
                e.domain.as_str(),
                "diagnostic" | "bookmark" | "session" | "history" | "history-erasure"
            )
        {
            return Err("Recovery contains conflicting identities, counters or epochs.".into());
        }
        if let Some(r) = &entry.redacted {
            if !matches!(e.domain.as_str(), "history" | "session" | "bookmark")
                || !digest(&r.digest)
                || !uuid(&r.certificate_operation_id)
                || !e.nonce.is_empty()
                || !e.ciphertext.is_empty()
            {
                return Err("Invalid compacted recovery receipt.".into());
            }
        } else if STANDARD.decode(&e.nonce).map_or(true, |b| b.len() != 12)
            || STANDARD
                .decode(&e.ciphertext)
                .map_or(true, |b| b.len() < 16 || b.len() > 65_536)
        {
            return Err("Invalid encrypted recovery record.".into());
        }
        manifest.push(json!([
            e.operation_id,
            entry
                .redacted
                .as_ref()
                .map_or_else(|| envelope_digest(e), |r| r.digest.clone()),
            entry.redacted.as_ref().map(|r| &r.certificate_operation_id)
        ]));
        previous = &e.operation_id;
        ids.insert(&e.operation_id, entry);
    }
    for entry in &bundle.entries {
        if let Some(r) = &entry.redacted {
            let certificate = ids
                .get(&r.certificate_operation_id)
                .ok_or("Recovery is missing an erasure certificate.")?;
            if certificate.redacted.is_some()
                || (entry.envelope.domain == "bookmark"
                    && certificate.envelope.domain != "bookmark")
                || (entry.envelope.domain == "history"
                    && certificate.envelope.domain != "history-erasure")
                || (entry.envelope.domain == "session"
                    && (certificate.envelope.domain != "session"
                        || certificate.envelope.device_id != entry.envelope.device_id))
            {
                return Err("Recovery erasure certificate has the wrong domain or author.".into());
            }
        }
    }
    let mut purge_manifest = Vec::new();
    let mut certificates = HashSet::new();
    for purge in &bundle.purges {
        let cert = ids
            .get(&purge.certificate_operation_id)
            .ok_or("Recovery purge is missing its certificate.")?;
        if cert.redacted.is_some()
            || purge.targets.is_empty()
            || purge.targets.len() > 100
            || !certificates.insert(&purge.certificate_operation_id)
        {
            return Err("Invalid recovery purge identity or targets.".into());
        }
        let mut targets = Vec::new();
        let mut seen = HashSet::new();
        for target in &purge.targets {
            let entry = ids
                .get(&target.header.operation_id)
                .ok_or("Recovery purge target is missing.")?;
            let original_digest = entry
                .redacted
                .as_ref()
                .map_or_else(|| envelope_digest(&entry.envelope), |r| r.digest.clone());
            if Header::of(&entry.envelope) != target.header
                || target.digest != original_digest
                || !seen.insert(&target.header.operation_id)
            {
                return Err("Recovery purge target identity conflicts.".into());
            }
            let h = &target.header;
            targets.push(json!([
                h.protocol_version,
                h.operation_id,
                h.account_id,
                h.device_id,
                h.counter,
                h.domain,
                h.key_epoch,
                target.digest
            ]));
        }
        purge_manifest.push(json!([purge.certificate_operation_id, targets]));
    }
    let actual = format!(
        "{:x}",
        Sha256::digest(json!([manifest, purge_manifest]).to_string().as_bytes())
    );
    if actual != bundle.manifest_digest {
        return Err("Recovery manifest integrity check failed.".into());
    }
    Ok(())
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", ".relay-lock"] {
            let mut name = self.0.as_os_str().to_os_string();
            name.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(name));
        }
    }
}
pub async fn rebuild(input: &Path, output: &Path, expected_account: &str) -> Result<Value> {
    let sidecar_exists = |path: &Path| {
        ["", "-wal", "-shm"].iter().any(|suffix| {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            PathBuf::from(name).exists()
        })
    };
    if sidecar_exists(output) {
        return Err(
            "Recovery never overwrites an existing database. Choose a new isolated path.".into(),
        );
    }
    // Bound the private replay file before allocating/parsing; ordinary API batch limits remain unchanged.
    if std::fs::metadata(input)?.len() > 2 * 1024 * 1024 * 1024 {
        return Err("Recovery input exceeds 2 GiB.".into());
    }
    let bundle: Bundle = serde_json::from_slice(&std::fs::read(input)?)
        .map_err(|_| "Invalid private recovery file.")?;
    validate(&bundle, expected_account)?;
    let _lease = RelayLease::acquire(output)?;
    let mut staging = output.as_os_str().to_os_string();
    staging.push(format!(".rebuild-{}", Uuid::new_v4()));
    let staging = Staging(PathBuf::from(staging));
    let app = App::open(&staging.0).await?;
    let mut tx = app.pool.begin().await?;
    sqlx::query("UPDATE settings SET account_id=?, server_epoch=?, key_epoch=? WHERE id=1")
        .bind(&bundle.account_id)
        .bind(&bundle.server_epoch)
        .bind(bundle.key_epoch)
        .execute(&mut *tx)
        .await?;
    let authors: HashSet<_> = bundle
        .entries
        .iter()
        .map(|e| e.envelope.device_id.as_str())
        .chain(std::iter::once(bundle.source.device_id.as_str()))
        .collect();
    if authors.len() > 256 {
        return Err("Recovery exceeds the installation identity limit.".into());
    }
    for author in authors {
        let active = author == bundle.source.device_id;
        // All other historical authors remain as revoked provenance only. Old registry access is never replayed.
        sqlx::query("INSERT INTO devices (id,name,token_hash,revoked,wrapping_public_key,wrapping_proof,wrapping_proof_epoch) VALUES (?,?,?,?,?,?,?)")
            .bind(author).bind(if active { bundle.source.name.as_str() } else { "Recovered historical author" })
            .bind(if active { crate::token_hash(&bundle.source.token) } else { crate::token_hash(&Uuid::new_v4().to_string()) })
            .bind(!active).bind(active.then_some(&bundle.source.identity.public_key))
            .bind(active.then_some(&bundle.source.identity.proof)).bind(active.then_some(bundle.key_epoch))
            .execute(&mut *tx).await?;
    }
    for entry in &bundle.entries {
        let e = &entry.envelope;
        sqlx::query("INSERT INTO operations (operation_id,device_id,counter,envelope,purged) VALUES (?,?,?,?,?)")
            .bind(&e.operation_id).bind(&e.device_id).bind(e.counter).bind(serde_json::to_string(e)?)
            .bind(entry.redacted.is_some()).execute(&mut *tx).await?;
    }
    let mut history = false;
    let mut sessions = false;
    let mut bookmarks = false;
    for entry in &bundle.entries {
        if let Some(r) = &entry.redacted {
            sqlx::query("INSERT INTO history_redactions (operation_id,original_digest,certificate_operation_id) VALUES (?,?,?)")
                .bind(&entry.envelope.operation_id).bind(&r.digest).bind(&r.certificate_operation_id).execute(&mut *tx).await?;
            history |= entry.envelope.domain == "history";
            sessions |= entry.envelope.domain == "session";
            bookmarks |= entry.envelope.domain == "bookmark";
        }
    }
    for purge in &bundle.purges {
        sqlx::query(
            "INSERT INTO history_erasures (certificate_operation_id,request_digest) VALUES (?,?)",
        )
        .bind(&purge.certificate_operation_id)
        .bind(target_digest(&purge.targets))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE settings SET history_erasure_version=?,session_erasure_version=?,bookmark_compaction_version=?,max_devices=MAX(max_devices,(SELECT COUNT(*) FROM devices)),max_journal_bytes=MAX(max_journal_bytes,journal_bytes),max_operations=MAX(max_operations,journal_operations) WHERE id=1")
        .bind(history).bind(sessions).bind(bookmarks).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO relay_recovery (id,recovery_id,source_id,manifest_digest) VALUES (1,?,?,?)",
    )
    .bind(&bundle.recovery_id)
    .bind(&bundle.source.device_id)
    .bind(&bundle.manifest_digest)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&app.pool)
        .await?;
    app.pool.close().await;
    verify_backup(&staging.0).await?;
    std::fs::File::open(&staging.0)?.sync_all()?;
    // hard_link is atomic and refuses an existing output. The old relay/backup is never opened or modified.
    if sidecar_exists(output) {
        return Err(
            "Recovery destination or SQLite sidecar appeared; no existing files were changed."
                .into(),
        );
    }
    std::fs::hard_link(&staging.0, output)?;
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(
        json!({"account_id":bundle.account_id,"server_epoch":bundle.server_epoch,"recovery_id":bundle.recovery_id,
        "operations":bundle.entries.len(),"active_installations":1,"requires_client_adoption":true}),
    )
}

pub(crate) async fn state(
    State(app): State<App>,
    headers: HeaderMap,
) -> std::result::Result<Json<Value>, crate::ApiError> {
    let author = app.bearer(&headers).await?;
    let row = sqlx::query("SELECT recovery_id,source_id,manifest_digest FROM relay_recovery WHERE id=1 AND source_id=?")
        .bind(&author).fetch_optional(&app.pool).await?.ok_or(crate::ApiError(StatusCode::NOT_FOUND,"No recovery proposal for this installation"))?;
    let key_epoch: u8 = sqlx::query_scalar("SELECT key_epoch FROM settings WHERE id=1")
        .fetch_one(&app.pool)
        .await?;
    Ok(Json(
        json!({"account_id":app.account_id,"server_epoch":app.server_epoch,"key_epoch":key_epoch,
        "recovery_id":row.get::<String,_>("recovery_id"),"source_id":author,"manifest_digest":row.get::<String,_>("manifest_digest")}),
    ))
}
