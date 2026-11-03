//! PR Quest's Tauri shell. Tauri has no Node, so the server runs as a sidecar in the Node binary
//! bundled next to this one, on 127.0.0.1 and a free port. The window opens a one-time bootstrap
//! link that sets the request secret's cookie, since Tauri can't set cookies itself. Each start
//! of the server has its own secret and link.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dialog;
mod keychain;
mod log;
mod menu;
mod policy;
mod release;
mod restarts;
mod sidecar;
mod smoke;
mod updates;

use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::dialog::Level;
use crate::log::Log;
use crate::restarts::Restarts;
use crate::sidecar::{Event, Launch, Notice, Sidecar};
use crate::smoke::Smoke;

const WINDOW: &str = "main";
const BOOTSTRAP_PATH: &str = "/__bootstrap";
/// Starting the server takes about a second; this much longer means it's stuck.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SMOKE_TIMEOUT: Duration = Duration::from_secs(100);
/// A server that crashed is started again this often, then the app gives up.
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

/// What the app holds while it runs.
#[derive(Default)]
struct Shell {
    sidecar: Mutex<Option<Arc<Sidecar>>>,
    /// The server's origin, the only one the window shows. A restarted server may get another
    /// port.
    origin: Arc<Mutex<Option<Url>>>,
    quitting: AtomicBool,
}

impl Shell {
    /// Stops the server, at the latest after its stop deadline, and keeps it from restarting.
    fn quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        let sidecar = self
            .sidecar
            .lock()
            .ok()
            .and_then(|mut sidecar| sidecar.take());
        if let Some(sidecar) = sidecar {
            sidecar.stop();
        }
    }
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

/// The start of a secret's SHA-256, which test runs log so scripts/desktop-measure.ts can tell a
/// restarted server's secret from the last one's.
fn fingerprint(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `PR_QUEST_SMOKE_TEST`: `1` runs the smoke test and exits; `idle` keeps the test's isolation but
/// stays open, so scripts/desktop-measure.ts can measure it and check what quitting stops.
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
        eprintln!(
            "[pr-quest] The smoke test needs PR_QUEST_STATE_DIR; see scripts/desktop-smoke.ts"
        );
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
        // The opener's click handler sends target=_blank links over IPC, which the server's page
        // may not use, so they did nothing; without it they reach on_new_window and the policy.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shell::default())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, &event))
        .setup(move |app| {
            if let Err(error) = start(app.handle(), mode) {
                let app = app.handle().clone();
                let log = app.try_state::<Log>().map(|log| log.inner().clone());
                let detail = format!("{error}.");
                thread::spawn(move || {
                    fail(
                        &app,
                        mode,
                        log.as_ref(),
                        "PR Quest could not start",
                        &detail,
                    )
                });
            }
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
        .unwrap_or_else(|error| {
            // Without an app there is no event loop to show a dialog on.
            eprintln!("[pr-quest] PR Quest could not start: {error}");
            std::process::exit(1);
        });
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app),
        RunEvent::Exit => {
            app.state::<Shell>().quit();
            if let Some(log) = app.try_state::<Log>() {
                updates::install_pending(app, &log);
            }
        }
        _ => {}
    });
}

/// Where the sidecar comes from and what every start of it gets.
struct Server {
    node: PathBuf,
    script: PathBuf,
    data_key: Option<String>,
    preferences_file: String,
}

/// What one start of the server gets. The secrets are new each time: a program that took the
/// port while the server restarted could have captured the old cookie, which then opens nothing.
fn launch(server: &Server, show_notices: bool) -> Launch {
    Launch {
        request_secret: token(),
        bootstrap_code: token(),
        data_key: server.data_key.clone(),
        preferences_file: server.preferences_file.clone(),
        show_notices,
    }
}

fn start(app: &AppHandle, mode: Mode) -> Result<(), Box<dyn Error>> {
    let paths = app.path();
    // A test run keeps its preferences and log in its throwaway state directory.
    let data_dir = match std::env::var_os("PR_QUEST_STATE_DIR") {
        Some(state_dir) if mode != Mode::App => PathBuf::from(state_dir).join("tauri"),
        _ => paths
            .app_config_dir()
            .map_err(|error| format!("It found no folder for its settings ({error})"))?,
    };
    let log_dir = if mode == Mode::App {
        paths
            .app_log_dir()
            .map_err(|error| format!("It found no folder for its log ({error})"))?
    } else {
        data_dir.clone()
    };
    let log = Log::open(
        &log_dir.join("main.log"),
        cfg!(debug_assertions) || mode != Mode::App,
    );
    app.manage(log.clone());
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
        Some(smoke) => {
            let keychain = match (&data_key, deleted) {
                (Ok(_), Ok(())) => Ok("made, read back and deleted a data key".into()),
                (Err(error), _) => Err(error.clone()),
                (Ok(_), Err(error)) => Err(error),
            };
            // CI runners without a keychain check everything else: the app then keeps keys in
            // memory, as it does for a player without one.
            match keychain {
                Err(error) if std::env::var_os("PR_QUEST_SMOKE_NO_KEYCHAIN").is_some() => {
                    smoke.info(&format!("keychain: {error}; skipped"));
                }
                keychain => smoke.check("keychain", keychain),
            }
        }
        None => {
            if let Err(error) = deleted {
                log.warn(&error);
            }
        }
    }
    let data_key = data_key
        .inspect_err(|error| log.warn(&format!("no data key: {error}")))
        .ok();
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("It couldn't create {} ({error})", data_dir.display()))?;
    // Tauri refuses to find its resources when the app's path goes through a symlink on macOS.
    let resources = paths
        .resource_dir()
        .map_err(|error| format!("It couldn't find its own files ({error})"))?;
    let server = Server {
        // Not `node`, which the deb would put on PATH; see scripts/desktop/targets.ts.
        node: std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "pr-quest-node.exe"
        } else {
            "pr-quest-node"
        }),
        script: resources.join("sidecar").join("main.mjs"),
        data_key,
        preferences_file: data_dir.join("desktop.json").to_string_lossy().into_owned(),
    };
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
    thread::spawn(move || supervise(&app, mode, &server, &log, smoke));
    Ok(())
}

/// Why a server session ended.
enum Outcome {
    /// The app is quitting, or the smoke test is done.
    Stopped,
    /// It stopped before it was ready.
    Failed(String),
    /// It stopped after it was ready.
    Crashed(String),
}

/// Runs the server and starts it again, a bounded number of times, when it crashes. Each start
/// gets a new request secret and bootstrap code, which the window then opens for its cookie.
fn supervise(app: &AppHandle, mode: Mode, server: &Server, log: &Log, mut smoke: Option<Smoke>) {
    let shell = app.state::<Shell>();
    let mut restarts = Restarts::new(MAX_RESTARTS, RESTART_WINDOW);
    let mut first = true;
    loop {
        // Once is enough: a restarted server finds the keys as they were.
        let launch = launch(server, first && mode == Mode::App);
        let bootstrap_code = launch.bootstrap_code.clone();
        if mode != Mode::App {
            log.info(&format!(
                "starting the server with request secret {}",
                fingerprint(&launch.request_secret)
            ));
        }
        let (events_tx, events_rx) = mpsc::channel();
        let spawned = Sidecar::spawn(
            &server.node,
            &server.script,
            &launch,
            log,
            events_tx.clone(),
        );
        drop(launch);
        let sidecar = match spawned {
            Ok(sidecar) => Arc::new(sidecar),
            Err(error) => {
                return fail(
                    app,
                    mode,
                    Some(log),
                    "PR Quest could not start",
                    &format!("Its server didn't start: {error}."),
                )
            }
        };
        if let Ok(mut current) = shell.sidecar.lock() {
            *current = Some(Arc::clone(&sidecar));
        }
        // Quitting may have started before the server was there to stop.
        if shell.quitting.load(Ordering::SeqCst) {
            return sidecar.stop();
        }
        let session = Session {
            app,
            mode,
            sidecar: &sidecar,
            log,
            events_tx: &events_tx,
            bootstrap_code: &bootstrap_code,
        };
        let reason = match session.run(&events_rx, &mut smoke) {
            Outcome::Stopped => return,
            Outcome::Failed(reason) if first => {
                return fail(app, mode, Some(log), "PR Quest could not start", &reason)
            }
            Outcome::Failed(reason) | Outcome::Crashed(reason) => reason,
        };
        if mode == Mode::SmokeTest || !restarts.allow(Instant::now()) {
            return fail(
                app,
                mode,
                Some(log),
                "PR Quest's server keeps stopping",
                &reason,
            );
        }
        log.warn(&format!("{reason} Starting it again."));
        leave_server(app, log);
        first = false;
    }
}

struct Session<'a> {
    app: &'a AppHandle,
    mode: Mode,
    sidecar: &'a Sidecar,
    log: &'a Log,
    events_tx: &'a Sender<Event>,
    bootstrap_code: &'a str,
}

impl Session<'_> {
    /// Handles what the sidecar and the window report until the sidecar exits.
    fn run(&self, events: &Receiver<Event>, smoke: &mut Option<Smoke>) -> Outcome {
        let mut ready = false;
        let mut fatal = None;
        loop {
            let event = if ready {
                events.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                events.recv_timeout(READY_TIMEOUT)
            };
            match event {
                Ok(Event::Ready(server)) => {
                    ready = true;
                    self.log.info(&format!(
                        "the server listens on port {}; saved keys: {}",
                        server.port, server.storage
                    ));
                    self.show(server.port);
                }
                Ok(Event::Notice(notice)) => {
                    let action = answer(self.app, &notice);
                    let command = serde_json::json!({ "command": "notice", "action": action });
                    if let Err(error) = self.sidecar.send(&command.to_string()) {
                        self.log
                            .warn(&format!("couldn't answer the server's notice: {error}"));
                    }
                }
                Ok(Event::Fatal(message)) => fatal = Some(message),
                Ok(Event::WindowReport(report)) => {
                    if let Some(smoke) = smoke.as_mut() {
                        smoke.window(&report);
                        smoke.check("updater", updates::smoke_check(self.app));
                        if let Err(error) = self.sidecar.send(r#"{"command":"smoke"}"#) {
                            smoke.check("sidecar", Err(error.to_string()));
                            self.app.exit(smoke.finish(false));
                            return Outcome::Stopped;
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
                        self.app.exit(smoke.finish(ok));
                        return Outcome::Stopped;
                    }
                }
                Ok(Event::Exited(code)) => {
                    if self.sidecar.is_stopping() {
                        return Outcome::Stopped;
                    }
                    let reason = fatal.take().map_or_else(
                        || format!("Its server stopped unexpectedly (exit code {code:?})."),
                        |message| format!("{message}."),
                    );
                    return if ready {
                        Outcome::Crashed(reason)
                    } else {
                        Outcome::Failed(reason)
                    };
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.sidecar.stop();
                    return Outcome::Failed(format!(
                        "Its server didn't start in {} seconds.",
                        READY_TIMEOUT.as_secs()
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => return Outcome::Stopped,
            }
        }
    }

    /// Opens the window on the server, or points the open one at a restarted server, which also
    /// reloads the page.
    fn show(&self, port: u16) {
        let origin =
            Url::parse(&format!("http://127.0.0.1:{port}/")).expect("a loopback URL parses");
        let mut url = origin.join(BOOTSTRAP_PATH).expect("a path joins");
        url.query_pairs_mut()
            .append_pair("code", self.bootstrap_code);
        if let Ok(mut current) = self.app.state::<Shell>().origin.lock() {
            *current = Some(origin);
        }
        let app = self.app.clone();
        let log = self.log.clone();
        let mode = self.mode;
        let reports = (mode == Mode::SmokeTest).then(|| self.events_tx.clone());
        let _ = self.app.run_on_main_thread(move || {
            let shown = match app.get_webview_window(WINDOW) {
                Some(window) => window.navigate(url),
                None => open_window(&app, url, &log, reports).inspect(|()| {
                    if mode == Mode::App {
                        updates::schedule(app.clone(), log.clone());
                    }
                }),
            };
            if let Err(error) = shown {
                let detail = format!("Its window didn't open: {error}.");
                thread::spawn(move || {
                    fail(&app, mode, Some(&log), "PR Quest could not start", &detail)
                });
            }
        });
    }
}

/// Takes the window off a server that stopped, so the page stops calling its port, which another
/// program could take, and the window goes nowhere until the restarted server is shown.
fn leave_server(app: &AppHandle, log: &Log) {
    if let Ok(mut origin) = app.state::<Shell>().origin.lock() {
        *origin = None;
    }
    let window_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = window_app.get_webview_window(WINDOW) {
            let _ = window.navigate(Url::parse(policy::BLANK).expect("about:blank parses"));
        }
    });
    log.info("the window left the stopped server");
}

/// Shows a secrets notice and returns the action of the button the player chose. Closing it
/// chooses the last button, which never loses keys.
fn answer(app: &AppHandle, notice: &Notice) -> String {
    let labels: Vec<&str> = notice.buttons.iter().map(|b| b.label.as_str()).collect();
    let chosen = dialog::ask(
        app,
        Level::Warning,
        &notice.message,
        &notice.detail,
        &labels,
    );
    let action = notice
        .buttons
        .get(chosen)
        .map_or("continue", |button| button.action.as_str());
    if action == "savePlaintext" && !confirm_plaintext(app) {
        return "keepInMemory".into();
    }
    action.into()
}

/// Closing this dialog keeps the keys in memory, so they're never saved unencrypted by accident.
fn confirm_plaintext(app: &AppHandle) -> bool {
    dialog::ask(
        app,
        Level::Warning,
        "Save your keys unencrypted?",
        "They go in secrets.json in PR Quest's state folder, where any program running as you can \
         read them. You can remove them in Settings at any time.",
        &["Save Unencrypted", "Keep Them Until I Quit"],
    ) == 0
}

/// Tells the player why the app has to stop, then quits. Blocks on the dialog, so it never runs
/// on the main thread. A test run prints a failed check instead.
fn fail(app: &AppHandle, mode: Mode, log: Option<&Log>, message: &str, detail: &str) {
    match log {
        Some(log) => log.warn(&format!("{message}: {detail}")),
        None => eprintln!("[pr-quest] {message}: {detail}"),
    }
    if mode == Mode::App {
        let detail = match log {
            Some(log) => format!("{detail}\n\nThe log is in {}.", log.path().display()),
            None => detail.to_owned(),
        };
        dialog::error(app, message, &detail);
    } else {
        println!("[smoke] FAIL {message}: {detail}");
    }
    app.exit(1);
}

/// The window shows only the app. Links anywhere else, such as a PR on GitHub, open in the system
/// browser; the page can't open windows of its own and gets no permissions but notifications.
fn open_window(
    app: &AppHandle,
    url: Url,
    log: &Log,
    smoke_reports: Option<Sender<Event>>,
) -> tauri::Result<()> {
    let origin = Arc::clone(&app.state::<Shell>().origin);
    let permission_origin = Arc::clone(&origin);
    let navigation_app = app.clone();
    let navigation_log = log.clone();
    let new_window_app = app.clone();
    let new_window_log = log.clone();
    let smoke_test = smoke_reports.is_some();
    let mut builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title("PR Quest")
        .inner_size(1280.0, 860.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(move |target| {
            if policy::is_blank(target) {
                return true;
            }
            let Some(app_origin) = origin.lock().ok().and_then(|origin| origin.clone()) else {
                return false;
            };
            if !policy::is_app_url(target, &app_origin) {
                open_externally(&navigation_app, &navigation_log, target);
                return false;
            }
            if target.path() == BOOTSTRAP_PATH {
                navigation_log.info("the window opens the server's start-up link");
            }
            if let Some(reports) = &smoke_reports {
                if target.path() == smoke::REPORT_PATH {
                    let _ = reports.send(Event::WindowReport(smoke::report_of(target)));
                    return false;
                }
            }
            true
        })
        .on_new_window(move |target, _features| {
            open_externally(&new_window_app, &new_window_log, &target);
            NewWindowResponse::Deny
        })
        .on_permission_request(move |webview, kind| {
            let page = webview.url().ok();
            match permission_origin
                .lock()
                .ok()
                .and_then(|origin| origin.clone())
            {
                Some(app_origin) => policy::permission(kind, page.as_ref(), &app_origin),
                None => tauri::webview::PermissionResponse::Deny,
            }
        });
    if smoke_test {
        builder = builder.initialization_script(smoke::WINDOW_SCRIPT);
    }
    builder.build()?;
    Ok(())
}

fn open_externally(app: &AppHandle, log: &Log, target: &Url) {
    match policy::external_url(target) {
        Some(url) => {
            if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
                log.warn(&format!("couldn't open a link: {error}"));
            }
        }
        None => log.warn(&format!("didn't open a {} link", target.scheme())),
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Server {
        Server {
            node: PathBuf::from("pr-quest-node"),
            script: PathBuf::from("main.mjs"),
            data_key: None,
            preferences_file: "desktop.json".into(),
        }
    }

    #[test]
    fn every_start_of_the_server_gets_new_secrets() {
        let first = launch(&server(), true);
        let restarted = launch(&server(), false);
        assert_ne!(first.request_secret, restarted.request_secret);
        assert_ne!(first.bootstrap_code, restarted.bootstrap_code);
        assert_ne!(first.request_secret, first.bootstrap_code);
        assert!(first.show_notices && !restarted.show_notices);
    }

    #[test]
    fn a_fingerprint_tells_secrets_apart_without_giving_them_away() {
        let secret = token();
        let print = fingerprint(&secret);
        assert_eq!(print, fingerprint(&secret));
        assert_ne!(print, fingerprint(&token()));
        assert_eq!(print.len(), 8);
        assert!(!secret.contains(&print));
    }
}
