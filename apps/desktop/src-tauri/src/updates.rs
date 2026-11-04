//! Self-updates from GitHub Releases through tauri-plugin-updater, which checks each download's
//! signature against the `pubkey` in tauri.conf.json before installing it. Only a release build
//! of a real repository updates itself, so a locally built app never installs whatever a stranger
//! publishes under the placeholder owner.

use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::dialog::{self, Level};
use crate::log::Log;
use crate::release::Repo;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Set at build time; see build.rs.
pub const RELEASE_BUILD: bool = matches!(env!("PR_QUEST_RELEASE_BUILD").as_bytes(), b"1");
pub const RELEASE_REPO: &str = env!("PR_QUEST_RELEASE_REPO");

pub fn release_repo() -> Repo<'static> {
    Repo::parse(RELEASE_REPO).expect("build.rs checked PR_QUEST_RELEASE_REPO")
}

/// Why this app doesn't update itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Disabled {
    NotReleaseBuild,
    PlaceholderRepo,
    /// `PR_QUEST_DISABLE_UPDATES=1`, for managed machines and test runs.
    TurnedOff,
    /// A .deb or .rpm, which the system's package manager updates; Help links to new versions.
    PackageManager,
    /// A bare executable, such as `cargo run`'s, which has no bundle to replace.
    NotBundled,
}

impl Disabled {
    pub fn reason(&self) -> &'static str {
        match self {
            Disabled::NotReleaseBuild => "not a release build",
            Disabled::PlaceholderRepo => "the release repository is the placeholder",
            Disabled::TurnedOff => "PR_QUEST_DISABLE_UPDATES=1",
            Disabled::PackageManager => "a package manager installs this build's updates",
            Disabled::NotBundled => "not an installed app",
        }
    }
}

pub fn enabled(
    release_build: bool,
    repo: &Repo,
    disable_updates: Option<&str>,
    bundle: Option<BundleType>,
) -> Result<(), Disabled> {
    if !release_build {
        return Err(Disabled::NotReleaseBuild);
    }
    if !repo.is_publishable() {
        return Err(Disabled::PlaceholderRepo);
    }
    if disable_updates == Some("1") {
        return Err(Disabled::TurnedOff);
    }
    match bundle {
        Some(BundleType::Deb | BundleType::Rpm) => Err(Disabled::PackageManager),
        Some(BundleType::App | BundleType::AppImage | BundleType::Nsis | BundleType::Msi) => Ok(()),
        _ => Err(Disabled::NotBundled),
    }
}

/// Never a downgrade, and never the same version again.
pub fn is_newer(current: &Version, remote: &Version) -> bool {
    remote > current
}

/// Whether this app updates itself, as it runs.
pub fn enabled_here() -> Result<(), Disabled> {
    enabled(
        RELEASE_BUILD,
        &release_repo(),
        std::env::var("PR_QUEST_DISABLE_UPDATES").ok().as_deref(),
        tauri::utils::platform::bundle_type(),
    )
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let manifest = Url::parse(&release_repo().update_manifest_url()).map_err(|e| e.to_string())?;
    app.updater_builder()
        .version_comparator(|current, release| is_newer(&current, &release.version))
        .endpoints(vec![manifest])
        .and_then(|builder| builder.build())
        .map_err(|error| error.to_string())
}

/// The smoke test's check: the updater builds with the configured key and endpoint, without
/// checking anything.
pub fn smoke_check(app: &AppHandle) -> Result<String, String> {
    updater(app)?;
    Ok(format!(
        "built for {}; checks off: {}",
        release_repo().update_manifest_url(),
        enabled_here()
            .err()
            .map_or("no", |disabled| disabled.reason())
    ))
}

/// A downloaded, verified update waiting for the app to quit or restart.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Checks now and every few hours. A newer version downloads in the background; the player can
/// restart into it now, or it installs when the app quits.
pub fn schedule(app: AppHandle, log: Log) {
    if let Err(disabled) = enabled_here() {
        log.info(&format!("updates are off: {}", disabled.reason()));
        return;
    }
    app.manage(Pending::default());
    std::thread::spawn(move || loop {
        match tauri::async_runtime::block_on(check(&app)) {
            Ok(Some(version)) => {
                log.info(&format!("downloaded PR Quest {version}"));
                offer_restart(&app, &log, &version);
                return;
            }
            Ok(None) => {}
            Err(error) => log.warn(&format!("update check failed: {error}")),
        }
        std::thread::sleep(CHECK_INTERVAL);
    });
}

async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(update) = updater(app)?.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    // download() checks the signature before it returns the bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let version = update.version.clone();
    if let Some(pending) = app.try_state::<Pending>() {
        *pending.0.lock().map_err(|_| "update lock")? = Some((update, bytes));
    }
    Ok(Some(version))
}

fn offer_restart(app: &AppHandle, log: &Log, version: &str) {
    let restart = dialog::ask(
        app,
        Level::Info,
        &format!("PR Quest {version} is ready"),
        "Restart PR Quest to use the new version, or keep going; it installs when you quit.",
        &["Restart Now", "Later"],
    ) == 0;
    if restart {
        // Quitting installs it (see install_pending), then the app starts again.
        app.request_restart();
    } else {
        log.info("the update installs when PR Quest quits");
    }
}

/// Installs a downloaded update, as the app quits.
pub fn install_pending(app: &AppHandle, log: &Log) {
    let Some(pending) = app.try_state::<Pending>() else {
        return;
    };
    let Some((update, bytes)) = pending.0.lock().ok().and_then(|mut pending| pending.take()) else {
        return;
    };
    match update.install(bytes) {
        Ok(()) => log.info(&format!("installed PR Quest {}", update.version)),
        Err(error) => log.warn(&format!("installing the update failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: Repo = Repo {
        owner: "octocat",
        name: "pr-quest",
    };
    const PLACEHOLDER: Repo = Repo {
        owner: "change-me",
        name: "pr-quest",
    };

    #[test]
    fn a_release_build_of_a_real_repository_updates_itself() {
        for bundle in [
            BundleType::App,
            BundleType::AppImage,
            BundleType::Nsis,
            BundleType::Msi,
        ] {
            assert_eq!(enabled(true, &REAL, None, Some(bundle)), Ok(()));
        }
    }

    #[test]
    fn a_local_build_never_updates_itself() {
        assert_eq!(
            enabled(false, &REAL, None, Some(BundleType::App)),
            Err(Disabled::NotReleaseBuild)
        );
    }

    #[test]
    fn the_placeholder_repository_never_updates_anything() {
        assert_eq!(
            enabled(true, &PLACEHOLDER, None, Some(BundleType::App)),
            Err(Disabled::PlaceholderRepo)
        );
    }

    #[test]
    fn the_player_can_turn_updates_off() {
        assert_eq!(
            enabled(true, &REAL, Some("1"), Some(BundleType::App)),
            Err(Disabled::TurnedOff)
        );
        assert_eq!(
            enabled(true, &REAL, Some("0"), Some(BundleType::App)),
            Ok(())
        );
    }

    #[test]
    fn packages_leave_updates_to_the_package_manager() {
        for bundle in [BundleType::Deb, BundleType::Rpm] {
            assert_eq!(
                enabled(true, &REAL, None, Some(bundle)),
                Err(Disabled::PackageManager)
            );
        }
    }

    #[test]
    fn a_bare_executable_has_nothing_to_update() {
        assert_eq!(enabled(true, &REAL, None, None), Err(Disabled::NotBundled));
    }

    #[test]
    fn only_a_newer_version_is_an_update() {
        let current = Version::parse("1.2.3").unwrap();
        assert!(is_newer(&current, &Version::parse("1.2.4").unwrap()));
        assert!(is_newer(&current, &Version::parse("2.0.0").unwrap()));
        assert!(!is_newer(&current, &Version::parse("1.2.3").unwrap()));
        assert!(!is_newer(&current, &Version::parse("1.2.2").unwrap()));
        assert!(!is_newer(
            &current,
            &Version::parse("1.2.3-beta.1").unwrap()
        ));
    }
}
