//! PR Quest's Tauri shell. Tauri has no Node, so the server runs as a sidecar in the Node binary
//! bundled next to this one, on 127.0.0.1 and a free port. The window opens a one-time bootstrap
//! link that sets the per-launch request secret's cookie, since Tauri can't set cookies itself.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keychain;
mod log;
mod sidecar;
mod smoke;

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::log::Log;
use crate::sidecar::{Event, Launch, Sidecar};
use crate::smoke::Smoke;

const WINDOW: &str = "main";
const BOOTSTRAP_PATH: &str = "/__bootstrap";
/// Starting the server takes about a second; this much longer means it's stuck.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SMOKE_TIMEOUT: Duration = Duration::from_secs(100);

struct Shell {
    sidecar: Arc<Sidecar>,
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS has no random source");
    bytes
}

/// 32 random bytes in base64url, which a cookie and a query string carry as they are.
fn token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

/// `PR_QUEST_SMOKE_TEST`: `1` runs the smoke test and exits; `idle` keeps the test's isolation but
/// stays open, so scripts/tauri-measure.ts can measure it and check what quitting stops.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    App,
    SmokeTest,
    Idle,
}

fn main() {
    let mode = match std::env::var("PR_QUEST_SMOKE_TEST").as_deref() {
        Ok("1") => Mode::SmokeTest,
        Ok("idle") => Mode::Idle,
        _ => Mode::App,
    };
    if mode != Mode::App && std::env::var_os("PR_QUEST_STATE_DIR").is_none() {
        // Otherwise the checks would run against the player's real ~/.pr-quest.
        eprintln!("[pr-quest] The smoke test needs PR_QUEST_STATE_DIR; see scripts/tauri-smoke.ts");
        std::process::exit(2);
    }
    let mut builder = tauri::Builder::default();
    // A test run runs next to an open PR Quest instead of handing over to it.
    if mode == Mode::App {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }));
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            start(app.handle(), mode)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS apps stay open without windows; the server keeps polling and the Dock icon
            // brings the window back.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("PR Quest could not start");
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app),
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Shell>() {
                shell.sidecar.stop();
            }
        }
        _ => {}
    });
}

fn start(app: &AppHandle, mode: Mode) -> Result<(), Box<dyn Error>> {
    let paths = app.path();
    // A test run keeps its preferences and log in its throwaway state directory.
    let data_dir = match std::env::var_os("PR_QUEST_STATE_DIR") {
        Some(state_dir) if mode != Mode::App => PathBuf::from(state_dir).join("tauri"),
        _ => paths.app_config_dir()?,
    };
    let log_dir = if mode == Mode::App {
        paths.app_log_dir()?
    } else {
        data_dir.clone()
    };
    let log = Log::open(
        &log_dir.join("main.log"),
        cfg!(debug_assertions) || mode != Mode::App,
    );
    let mut smoke = (mode == Mode::SmokeTest).then(Smoke::new);
    // A test run makes and deletes its own entry: reading the real one from a rebuilt, unsigned
    // app makes macOS ask for permission, and nobody answers in a test run.
    let account = if mode == Mode::App {
        keychain::ACCOUNT.to_owned()
    } else {
        format!("smoke-test-{}", std::process::id())
    };
    let data_key = keychain::data_key(&account);
    let deleted = if mode == Mode::App {
        Ok(())
    } else {
        keychain::delete(&account)
    };
    match smoke.as_mut() {
        Some(smoke) => smoke.check(
            "keychain",
            match (&data_key, deleted) {
                (Ok(_), Ok(())) => Ok("made, read back and deleted a data key".into()),
                (Err(error), _) => Err(error.clone()),
                (Ok(_), Err(error)) => Err(error),
            },
        ),
        None => {
            if let Err(error) = deleted {
                log.warn(&error);
            }
        }
    }
    let data_key = data_key
        .inspect_err(|error| log.warn(&format!("{error}; keys you save last until you quit")))
        .ok();
    start_sidecar(app, &data_dir, data_key, log, smoke)
}

fn start_sidecar(
    app: &AppHandle,
    data_dir: &Path,
    data_key: Option<String>,
    log: Log,
    smoke: Option<Smoke>,
) -> Result<(), Box<dyn Error>> {
    let paths = app.path();
    fs::create_dir_all(data_dir)?;
    let node =
        std::env::current_exe()?.with_file_name(if cfg!(windows) { "node.exe" } else { "node" });
    let script = paths.resource_dir()?.join("sidecar").join("main.mjs");
    let bootstrap_code = token();
    let launch = Launch {
        request_secret: token(),
        bootstrap_code: bootstrap_code.clone(),
        data_key,
        preferences_file: data_dir.join("desktop.json").to_string_lossy().into_owned(),
    };
    let (events_tx, events_rx) = mpsc::channel();
    let sidecar = Arc::new(Sidecar::spawn(
        &node,
        &script,
        &launch,
        &log,
        events_tx.clone(),
    )?);
    drop(launch);
    app.manage(Shell {
        sidecar: Arc::clone(&sidecar),
    });
    if smoke.is_some() {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(SMOKE_TIMEOUT);
            println!(
                "[smoke] FAIL the smoke test didn't finish in {} s",
                SMOKE_TIMEOUT.as_secs()
            );
            app.exit(1);
        });
    }
    let app = app.clone();
    thread::spawn(move || {
        run(
            &app,
            &sidecar,
            &log,
            events_rx,
            &events_tx,
            &bootstrap_code,
            smoke,
        )
    });
    Ok(())
}

/// Handles what the sidecar and the window report until the sidecar exits.
fn run(
    app: &AppHandle,
    sidecar: &Sidecar,
    log: &Log,
    events: Receiver<Event>,
    events_tx: &Sender<Event>,
    bootstrap_code: &str,
    mut smoke: Option<Smoke>,
) {
    let mut ready = false;
    loop {
        let event = if ready {
            events.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            events.recv_timeout(READY_TIMEOUT)
        };
        match event {
            Ok(Event::Ready(server)) => {
                ready = true;
                log.info(&format!(
                    "the server listens on port {}; saved keys: {}",
                    server.port, server.storage
                ));
                let origin = Url::parse(&format!("http://127.0.0.1:{}/", server.port))
                    .expect("a loopback URL parses");
                let mut url = origin.join(BOOTSTRAP_PATH).expect("a path joins");
                url.query_pairs_mut().append_pair("code", bootstrap_code);
                let reports = smoke.is_some().then(|| events_tx.clone());
                let window_app = app.clone();
                let window_log = log.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = open_window(&window_app, url, &origin, reports) {
                        window_log.warn(&format!("couldn't open the window: {error}"));
                        window_app.exit(1);
                    }
                });
            }
            Ok(Event::WindowReport(report)) => {
                if let Some(smoke) = smoke.as_mut() {
                    smoke.window(&report);
                    if let Err(error) = sidecar.send(r#"{"command":"smoke"}"#) {
                        smoke.check("sidecar", Err(error.to_string()));
                        app.exit(smoke.finish(false));
                    }
                }
            }
            Ok(Event::SmokeLine(line)) => {
                if let Some(smoke) = smoke.as_mut() {
                    smoke.sidecar_line(&line);
                }
            }
            Ok(Event::SmokeDone(ok)) => {
                if let Some(smoke) = smoke.as_ref() {
                    app.exit(smoke.finish(ok));
                }
            }
            Ok(Event::Exited(code)) => {
                if !sidecar.is_stopping() {
                    log.warn(&format!(
                        "the server stopped unexpectedly (exit code {code:?})"
                    ));
                    app.exit(1);
                }
                return;
            }
            Err(RecvTimeoutError::Timeout) => {
                log.warn(&format!(
                    "the server didn't start in {} s",
                    READY_TIMEOUT.as_secs()
                ));
                app.exit(1);
                return;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// The window shows only the app. Links anywhere else, such as a PR on GitHub, open in the system
/// browser, and the page can't open windows of its own.
fn open_window(
    app: &AppHandle,
    url: Url,
    origin: &Url,
    smoke_reports: Option<Sender<Event>>,
) -> tauri::Result<()> {
    let app_origin = origin.origin();
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let smoke_test = smoke_reports.is_some();
    let mut builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title("PR Quest")
        .inner_size(1280.0, 860.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(move |target| {
            if target.origin() == app_origin {
                return true;
            }
            if let Some(reports) = &smoke_reports {
                if target.scheme() == smoke::REPORT_SCHEME {
                    let _ = reports.send(Event::WindowReport(smoke::report_of(target)));
                    return false;
                }
            }
            open_externally(&navigation_app, target);
            false
        })
        .on_new_window(move |target, _features| {
            open_externally(&new_window_app, &target);
            NewWindowResponse::Deny
        });
    if smoke_test {
        builder = builder.initialization_script(smoke::WINDOW_SCRIPT);
    }
    builder.build()?;
    Ok(())
}

fn open_externally(app: &AppHandle, target: &Url) {
    if matches!(target.scheme(), "http" | "https") {
        let _ = app.opener().open_url(target.as_str(), None::<&str>);
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
