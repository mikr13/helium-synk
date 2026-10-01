use std::{
    fs::OpenOptions,
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use clap::{Parser, Subcommand};
use synk_server::{App, Limits};

#[derive(Parser)]
#[command(version, about = "Private encrypted relay for Helium Synk")]
struct Cli {
    #[arg(long, env = "SYNK_DATABASE", default_value = "data/synk.sqlite")]
    database: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, env = "SYNK_PORT", default_value_t = 4318)]
        port: u16,
    },
    /// Provision a distinct credential for each browser profile. No encryption keys are generated here.
    IssueDevice {
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "http://127.0.0.1:4318")]
        server_url: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Update persisted account budgets without deleting records. Running relays read these on each insert.
    SetLimits {
        #[arg(long)]
        max_journal_bytes: i64,
        #[arg(long)]
        max_operations: i64,
        #[arg(long, default_value_t = 64)]
        max_devices: i64,
    },
    RevokeDevice {
        #[arg(long)]
        device_id: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "synk_server=info".into()),
        )
        .init();
    let cli = Cli::parse();
    let app = App::open(&cli.database).await?;
    match cli.command {
        Command::Serve { port } => {
            let listener = tokio::net::TcpListener::bind(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                port,
            ))
            .await?;
            tracing::info!(address = %listener.local_addr()?, "relay listening on localhost");
            let stopping = app.clone();
            axum::serve(listener, synk_server::router(app.clone()))
                .with_graceful_shutdown(async move {
                    shutdown_signal().await;
                    stopping.initiate_shutdown();
                    tracing::info!("relay draining committed work");
                })
                .await?;
            app.pool.close().await;
            tracing::info!("relay stopped");
        }
        Command::IssueDevice {
            name,
            server_url,
            output,
        } => {
            // Refuse overwrite and create with restrictive permissions before provisioning a token.
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&output)?;
            let credential = app.issue_device(&name, &server_url).await?;
            file.write_all(serde_json::to_string_pretty(&credential)?.as_bytes())?;
            file.sync_all()?;
            println!(
                "Credential written to {}. Keep this file private; use it for one profile only.",
                output.display()
            );
        }
        Command::SetLimits {
            max_journal_bytes,
            max_operations,
            max_devices,
        } => {
            app.configure_limits(Limits {
                max_journal_bytes,
                max_operations,
                max_devices,
            })
            .await?;
            println!("Relay budgets updated. Existing records and retry identities were retained.");
        }
        Command::RevokeDevice { device_id } => {
            if !app.revoke(&device_id).await? {
                return Err("Device not found or already revoked".into());
            }
            println!(
                "Device access revoked. Previously downloaded data and encryption keys are unaffected."
            );
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
