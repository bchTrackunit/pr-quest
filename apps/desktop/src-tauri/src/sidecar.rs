//! The PR Quest server, which runs in the Node binary bundled next to this one, and talks to the
//! shell over stdio as apps/desktop/src/sidecar/protocol.ts describes.

use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::log::Log;

const READY_PREFIX: &str = "PRQUEST_READY ";
const NOTICE_PREFIX: &str = "PRQUEST_NOTICE ";
const FATAL_PREFIX: &str = "PRQUEST_FATAL ";
const SMOKE_DONE_PREFIX: &str = "PRQUEST_SMOKE_DONE ";
const BOOTSTRAP_PREFIX: &str = "PRQUEST_BOOTSTRAP ";
const SMOKE_LINE_PREFIX: &str = "[smoke] ";
/// How long stopping waits for the server to close before it kills the process.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Variables that could make the sidecar run code that isn't the app's: `NODE_OPTIONS` and the
/// other `NODE_*` ones, OpenSSL's `OPENSSL_*`, as Node reads `OPENSSL_CONF`, which can load
/// provider and engine modules, and the dynamic loaders' `DYLD_*` (macOS) and `LD_*` (Linux),
/// such as `DYLD_INSERT_LIBRARIES` and `LD_PRELOAD`.
const DROPPED_PREFIXES: [&str; 4] = ["NODE_", "OPENSSL_", "DYLD_", "LD_"];
/// Kept for the sidecar, for players behind a corporate TLS proxy. It adds a CA that every
/// outbound API call trusts, which is why only the player's own environment can set it.
const KEPT_VARIABLES: [&str; 1] = ["NODE_EXTRA_CA_CERTS"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub request_secret: String,
    pub bootstrap_code: String,
    pub data_key: Option<String>,
    pub preferences_file: String,
    pub show_notices: bool,
}

#[derive(Deserialize)]
pub struct Ready {
    pub port: u16,
    pub storage: String,
}

/// A notice about saved keys for the player, from apps/desktop/src/secretsNotice.ts.
#[derive(Deserialize)]
pub struct Notice {
    pub message: String,
    pub detail: String,
    pub buttons: Vec<NoticeButton>,
}

#[derive(Deserialize)]
pub struct NoticeButton {
    pub label: String,
    pub action: String,
}

#[derive(Deserialize)]
struct Fatal {
    message: String,
}

#[derive(Deserialize)]
struct SmokeDone {
    ok: bool,
}

#[derive(Deserialize)]
struct Bootstrap {
    code: String,
}

pub enum Event {
    Ready(Ready),
    Notice(Notice),
    /// A new one-time code for the start-up link, which the shell asked for with `rebootstrap`.
    Bootstrap(String),
    /// Why the server couldn't start.
    Fatal(String),
    SmokeLine(String),
    SmokeDone(bool),
    /// The window's smoke test report, as JSON.
    WindowReport(String),
    /// Reload in the menu.
    Reload,
    Exited(Option<i32>),
}

pub struct Sidecar {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    stopping: Arc<AtomicBool>,
}

impl Sidecar {
    /// Starts `node script` and writes `launch` to its stdin, never to argv or the environment,
    /// which other programs on the machine can read.
    pub fn spawn(
        node: &Path,
        script: &Path,
        launch: &Launch,
        log: &Log,
        events: Sender<Event>,
    ) -> io::Result<Sidecar> {
        let mut command = Command::new(node);
        // A signal could otherwise open the inspector, which reads every secret in the process.
        command
            .arg("--disable-sigusr1")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, _) in std::env::vars_os() {
            if is_dropped_variable(&name) {
                command.env_remove(name);
            }
        }
        isolate(&mut command);
        let mut child = command.spawn()?;
        #[cfg(windows)]
        if let Err(error) = windows_job::assign(&child) {
            log.warn(&format!(
                "the server may outlive PR Quest if it crashes: {error}"
            ));
        }
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let message = serde_json::to_string(launch).map_err(io::Error::other)?;
        let sent = stdin
            .write_all(message.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if let Err(error) = sent {
            kill_tree(&mut child);
            return Err(error);
        }

        let stdout_events = events.clone();
        let stdout_log = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                match parse_line(&line) {
                    Ok(Some(event)) => {
                        let _ = stdout_events.send(event);
                    }
                    Ok(None) => stdout_log.info(&format!("sidecar: {line}")),
                    Err(error) => stdout_log.warn(&format!("unreadable sidecar line: {error}")),
                }
            }
        });
        let stderr_log = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                stderr_log.info(&format!("sidecar: {line}"));
            }
        });

        let child = Arc::new(Mutex::new(child));
        let watched = Arc::clone(&child);
        thread::spawn(move || loop {
            thread::sleep(POLL_INTERVAL);
            let status = match watched.lock() {
                Ok(mut child) => reap_if_exited(&mut child),
                Err(_) => return,
            };
            let code = match status {
                Ok(None) => continue,
                Ok(Some(status)) => status.code(),
                Err(_) => None,
            };
            let _ = events.send(Event::Exited(code));
            return;
        });

        Ok(Sidecar {
            child,
            stdin: Mutex::new(Some(stdin)),
            stopping: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Sends one more line, such as a smoke test command.
    pub fn send(&self, line: &str) -> io::Result<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| io::Error::other("stdin lock"))?;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| io::Error::other("the sidecar is stopping"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Closes stdin, which tells the server to close, and kills it if it hasn't within
    /// `STOP_TIMEOUT`. If the shell dies instead, the OS closes stdin and the sidecar stops itself;
    /// on Windows the job object also ends it.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            match self
                .child
                .lock()
                .map(|mut child| reap_if_exited(&mut child))
            {
                Ok(Ok(None)) => thread::sleep(POLL_INTERVAL),
                _ => return,
            }
        }
        if let Ok(mut child) = self.child.lock() {
            kill_tree(&mut child);
        }
    }
}

/// On Unix, puts the sidecar in a process group of its own, so stopping it stops what it started,
/// such as cursorsandbox and rg. On Windows the job object does that (see `windows_job`).
///
/// If the shell is killed, the sidecar sees stdin close and stops the rest of its group itself.
/// On Linux it also gets SIGTERM once the thread that started it ends, which is the supervising
/// thread, alive as long as the sidecar is.
fn isolate(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let shell = libc::pid_t::try_from(std::process::id()).unwrap_or(0);
        // SAFETY: runs between fork and exec, so it only makes async-signal-safe calls and
        // doesn't allocate.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(io::Error::last_os_error());
                }
                // The shell may have died before the line above, which then never fires.
                if libc::getppid() != shell {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A console of its own, but hidden, which the programs it starts inherit too.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Kills the sidecar and, on Unix, the rest of its process group.
fn kill_tree(child: &mut Child) {
    if let Ok(Some(_)) = reap_if_exited(child) {
        return;
    }
    // Not reaped, so the group's id is still the sidecar's even if it exits meanwhile.
    #[cfg(unix)]
    kill_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// The sidecar's exit status once it exited, reaping it. On Unix it first kills the rest of its
/// process group, which a review's rg would otherwise outlive it in: until the sidecar is reaped
/// its pid, and with it the group's id, can't go to another process.
fn reap_if_exited(child: &mut Child) -> io::Result<Option<ExitStatus>> {
    #[cfg(unix)]
    {
        let pid: libc::id_t = child.id();
        // SAFETY: zeroed is a valid siginfo_t, which waitid only writes to.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: waitid with WNOWAIT only looks at the child's state, leaving it to be reaped.
        let looked = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if looked == -1 {
            // ECHILD: it was reaped already, and Child remembers its status.
            return child.try_wait();
        }
        // SAFETY: waitid filled in info, or left it zeroed when the child hasn't exited.
        if unsafe { info.si_pid() } == 0 {
            return Ok(None);
        }
        kill_group(child.id());
        child.wait().map(Some)
    }
    #[cfg(not(unix))]
    child.try_wait()
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    if let Ok(group) = libc::pid_t::try_from(pid) {
        // SAFETY: killpg only sends a signal; a group that is already gone makes it fail harmlessly.
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
}

/// The event a stdout line stands for, `None` for a plain log line.
fn parse_line(line: &str) -> Result<Option<Event>, serde_json::Error> {
    if let Some(ready) = line.strip_prefix(READY_PREFIX) {
        return serde_json::from_str(ready).map(|ready| Some(Event::Ready(ready)));
    }
    if let Some(notice) = line.strip_prefix(NOTICE_PREFIX) {
        return serde_json::from_str(notice).map(|notice| Some(Event::Notice(notice)));
    }
    if let Some(bootstrap) = line.strip_prefix(BOOTSTRAP_PREFIX) {
        return serde_json::from_str::<Bootstrap>(bootstrap)
            .map(|bootstrap| Some(Event::Bootstrap(bootstrap.code)));
    }
    if let Some(fatal) = line.strip_prefix(FATAL_PREFIX) {
        return serde_json::from_str::<Fatal>(fatal).map(|fatal| Some(Event::Fatal(fatal.message)));
    }
    if let Some(done) = line.strip_prefix(SMOKE_DONE_PREFIX) {
        return serde_json::from_str::<SmokeDone>(done).map(|done| Some(Event::SmokeDone(done.ok)));
    }
    if line.starts_with(SMOKE_LINE_PREFIX) {
        return Ok(Some(Event::SmokeLine(line.to_owned())));
    }
    Ok(None)
}

/// Windows reads variable names in any case, so these match in any case too.
fn is_dropped_variable(name: &OsString) -> bool {
    name.to_str().is_some_and(|name| {
        let name = name.to_ascii_uppercase();
        DROPPED_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
            && !KEPT_VARIABLES.contains(&name.as_str())
    })
}

/// One job object for the app's lifetime, which every sidecar and the programs it starts join.
/// Windows closes its handle when the shell exits, however it exits, and that kills them all.
#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    // The handle is only ever passed to the OS, which may use it from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Result<Job, String>> = OnceLock::new();

    fn create() -> Result<Job, String> {
        // SAFETY: plain Win32 calls with valid arguments; the handle is never closed, so it lives
        // until the process ends.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error().to_string());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = u32::try_from(std::mem::size_of_val(&limits)).expect("a small struct");
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size,
            ) == 0
            {
                return Err(io::Error::last_os_error().to_string());
            }
            Ok(Job(job))
        }
    }

    pub fn assign(child: &Child) -> Result<(), String> {
        let job = JOB.get_or_init(create).as_ref().map_err(Clone::clone)?;
        // SAFETY: both handles are valid for the duration of the call.
        if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ready_line() {
        let Ok(Some(Event::Ready(ready))) =
            parse_line(r#"PRQUEST_READY {"port":4317,"storage":"keychain"}"#)
        else {
            panic!("not a ready line");
        };
        assert_eq!((ready.port, ready.storage.as_str()), (4317, "keychain"));
    }

    #[test]
    fn reads_whether_the_sidecar_checks_passed() {
        let passed = parse_line(r#"PRQUEST_SMOKE_DONE {"ok":true}"#);
        assert!(matches!(passed, Ok(Some(Event::SmokeDone(true)))));
        let failed = parse_line(r#"PRQUEST_SMOKE_DONE {"ok":false,"note":"\"ok\":true"}"#);
        assert!(matches!(failed, Ok(Some(Event::SmokeDone(false)))));
        assert!(parse_line(r#"PRQUEST_SMOKE_DONE {"ok":"yes"}"#).is_err());
    }

    #[test]
    fn reads_a_new_start_up_code() {
        let line = r#"PRQUEST_BOOTSTRAP {"code":"abc"}"#;
        assert!(matches!(parse_line(line), Ok(Some(Event::Bootstrap(code))) if code == "abc"));
    }

    #[test]
    fn reads_a_notice() {
        let line = r#"PRQUEST_NOTICE {"message":"m","detail":"d","buttons":[{"label":"Continue","action":"continue"}]}"#;
        let Ok(Some(Event::Notice(notice))) = parse_line(line) else {
            panic!("not a notice");
        };
        assert_eq!(notice.buttons[0].action, "continue");
    }

    #[test]
    fn reads_why_the_server_could_not_start() {
        let Ok(Some(Event::Fatal(message))) =
            parse_line(r#"PRQUEST_FATAL {"message":"Port in use"}"#)
        else {
            panic!("not a fatal line");
        };
        assert_eq!(message, "Port in use");
    }

    #[test]
    fn other_lines_are_logs() {
        assert!(matches!(parse_line("listening"), Ok(None)));
        assert!(parse_line("PRQUEST_READY not json").is_err());
    }

    /// Starts `script` in `sh` the way the sidecar starts, and returns it with the pid of the
    /// background process the script printed.
    #[cfg(unix)]
    fn spawn_with_grandchild(script: &str) -> (Child, i32) {
        let mut command = Command::new("sh");
        command.args(["-c", script]).stdout(Stdio::piped());
        isolate(&mut command);
        let mut child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        (child, line.trim().parse().unwrap())
    }

    /// Whether `pid` is gone within 5 seconds.
    #[cfg(unix)]
    fn gone(pid: i32) -> bool {
        (0..50).any(|_| {
            thread::sleep(Duration::from_millis(100));
            // SAFETY: signal 0 only checks whether the process exists.
            let exists = unsafe { libc::kill(pid, 0) } == 0;
            !exists || zombie(pid)
        })
    }

    /// Whether `pid` exited but wasn't reaped, as under a container init that doesn't reap orphans.
    #[cfg(unix)]
    fn zombie(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z'))
        })
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_sends_it_sigterm_when_the_thread_that_started_it_ends() {
        use std::os::unix::process::ExitStatusExt;
        let mut child = thread::spawn(|| {
            let mut command = Command::new("sleep");
            command.arg("30");
            isolate(&mut command);
            command.spawn().unwrap()
        })
        .join()
        .unwrap();
        let status = child.wait().unwrap();
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    #[cfg(unix)]
    #[test]
    fn killing_it_also_kills_what_it_started() {
        let (mut child, grandchild) = spawn_with_grandchild("sleep 30 & echo $!; wait");
        kill_tree(&mut child);
        assert!(
            gone(grandchild),
            "process {grandchild} outlived the sidecar"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_sidecar_that_exits_takes_what_it_started_along_before_it_is_reaped() {
        let (mut child, grandchild) = spawn_with_grandchild("sleep 30 & echo $!");
        let status = (0..50)
            .find_map(|_| {
                thread::sleep(Duration::from_millis(100));
                reap_if_exited(&mut child).unwrap()
            })
            .expect("the shell exited");
        assert!(status.success());
        assert!(
            gone(grandchild),
            "process {grandchild} outlived the sidecar"
        );
        assert_eq!(reap_if_exited(&mut child).unwrap(), Some(status));
    }

    #[test]
    fn drops_node_variables_that_could_load_other_code() {
        assert!(is_dropped_variable(&OsString::from("NODE_OPTIONS")));
        assert!(is_dropped_variable(&OsString::from("NODE_PATH")));
        assert!(!is_dropped_variable(&OsString::from("NODE_EXTRA_CA_CERTS")));
        assert!(!is_dropped_variable(&OsString::from("PATH")));
    }

    #[test]
    fn drops_loader_variables_that_could_inject_libraries() {
        for name in [
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FRAMEWORK_PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
        ] {
            assert!(is_dropped_variable(&OsString::from(name)), "{name}");
        }
        assert!(!is_dropped_variable(&OsString::from("LANG")));
        assert!(!is_dropped_variable(&OsString::from("HOME")));
    }

    #[test]
    fn drops_openssl_variables_that_could_load_modules() {
        for name in ["OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_ENGINES"] {
            assert!(is_dropped_variable(&OsString::from(name)), "{name}");
        }
        assert!(!is_dropped_variable(&OsString::from("SSL_CERT_FILE")));
    }

    #[test]
    fn drops_them_in_any_case_as_windows_reads_them() {
        assert!(is_dropped_variable(&OsString::from("node_options")));
        assert!(is_dropped_variable(&OsString::from("Node_Options")));
        assert!(!is_dropped_variable(&OsString::from("node_extra_ca_certs")));
    }
}
