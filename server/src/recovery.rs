use crate::App;
use sqlx::Row;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Held by CLI serving/restore operations. Backup and credential provisioning may run online.
pub struct RelayLease {
    _file: File,
}
impl RelayLease {
    pub fn acquire(database: &Path) -> Result<Self> {
        if let Some(parent) = database.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
                }
            }
        }
        let database = if database.exists() {
            database.canonicalize()?
        } else {
            let parent = database
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            parent
                .canonicalize()?
                .join(database.file_name().ok_or("Invalid relay database path.")?)
        };
        let mut name = database.as_os_str().to_os_string();
        name.push(".relay-lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(PathBuf::from(name))?;
        #[cfg(unix)]
        {
            use rustix::fs::{FlockOperation, flock};
            flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(
                |_| "Relay database is already serving or being restored. Stop that relay first.",
            )?;
            Ok(Self { _file: file })
        }
        #[cfg(not(unix))]
        {
            let _ = file;
            Err("Relay process leases require a supported Unix filesystem.".into())
        }
    }
}

struct BackupOutput {
    path: PathBuf,
    complete: bool,
}
impl Drop for BackupOutput {
    fn drop(&mut self) {
        if !self.complete {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Make an independent consistent SQLite snapshot, including committed WAL content.
pub async fn backup(app: &App, output: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(output)?;
    let mut saved = BackupOutput {
        path: output.to_path_buf(),
        complete: false,
    };
    let canonical = output.canonicalize()?;
    let filename = canonical
        .to_str()
        .ok_or("Backup path must be valid UTF-8.")?;
    sqlx::query("VACUUM main INTO ?")
        .bind(filename)
        .execute(&app.pool)
        .await?;
    file.sync_all()?;
    if let Some(parent) = canonical.parent() {
        File::open(parent)?.sync_all()?;
    }
    saved.complete = true;
    Ok(())
}

/// Caller holds RelayLease and has stopped serving this database. No records/counters are reset.
pub async fn mark_restored(app: &App, expected_epoch: &str) -> Result<String> {
    let expected = Uuid::parse_str(expected_epoch)?.to_string();
    let epoch = Uuid::new_v4().to_string();
    let mut tx = app.pool.begin().await?;
    let current = sqlx::query("SELECT server_epoch FROM settings WHERE id = 1")
        .fetch_one(&mut *tx)
        .await?
        .get::<String, _>("server_epoch");
    if current != expected {
        return Err("Restore epoch does not match. No recovery state changed.".into());
    }
    sqlx::query("UPDATE settings SET server_epoch = ? WHERE id = 1")
        .bind(&epoch)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE devices SET sent_cursor = 0, processed_cursor = 0, processed_epoch = NULL, last_seen = NULL")
        .execute(&mut *tx).await?;
    sqlx::query("DELETE FROM pairing_invites")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(epoch)
}
