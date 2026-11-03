//! `PR_QUEST_SMOKE_TEST=1` checks a packaged build, prints one `[smoke]` line per check and exits
//! with whether all passed; scripts/desktop-smoke.ts runs it. The shell checks the keychain, the
//! window, Reload and the updater, then asks the sidecar for its checks: the server, both SDKs
//! and their native parts.

use serde_json::Value;
use tauri::Url;

/// The window may not use IPC (the page is remote), so its script reports by navigating to this path of
/// the app, which the shell's navigation handler catches and cancels. Every webview reports a
/// navigation to an http URL; not all of them report one to a scheme nobody handles.
pub const REPORT_PATH: &str = "/__smoke-report";

/// Runs in the window before the page's own scripts, so the page's CSP doesn't apply to it and it
/// sees every violation.
pub const WINDOW_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || location.protocol !== 'http:') return;
  const violations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    violations.push(
      `${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile || '?'}:${event.lineNumber} ${event.sample}`,
    );
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.addEventListener('load', async () => {
    let children = 0;
    for (let waited = 0; waited < 10000 && children === 0; waited += 250) {
      children = document.getElementById('root')?.childElementCount ?? 0;
      if (children === 0) await sleep(250);
    }
    await document.fonts.ready;
    const fonts = [...document.fonts].filter((font) => font.status === 'loaded').length;
    const api = await fetch('/api/settings').then((res) => res.status, (error) => String(error));
    const events = await new Promise((resolve) => {
      const source = new EventSource('/api/events');
      const done = (result) => { clearTimeout(timer); source.close(); resolve(result); };
      const timer = setTimeout(() => done('no answer in 5 s'), 5000);
      source.onopen = () => done('open');
      source.onerror = () => done('error');
    });
    // EventSource doesn't say why it failed; the events route needs a GitHub sign-in as well.
    const eventsStatus = events === 'open' ? undefined : await fetch('/api/events').then(
      (res) => { res.body?.cancel(); return res.status; },
      (error) => String(error),
    );
    // tauri.conf.json grants no capabilities, so the page can't call the shell or its plugins.
    const internals = window.__TAURI_INTERNALS__;
    const ipc = typeof internals?.invoke !== 'function' ? 'absent' : await Promise.race([
      internals.invoke('plugin:opener|open_url', { url: 'https://example.invalid/' }).then(
        () => 'allowed',
        (error) => `rejected: ${String(error)}`,
      ),
      sleep(5000).then(() => 'no answer in 5 s'),
    ]);
    await sleep(500);
    const report = {
      path: location.pathname + location.search,
      title: document.title,
      children,
      fonts,
      api,
      events,
      eventsStatus,
      ipc,
      cookieVisible: document.cookie.includes('pr_quest_secret'),
      violations,
      userAgent: navigator.userAgent,
    };
    location.href = `/__smoke-report?data=${encodeURIComponent(JSON.stringify(report))}`;
  });
})();
"#;

pub struct Smoke {
    ok: bool,
}

impl Smoke {
    pub fn new() -> Smoke {
        Smoke { ok: true }
    }

    pub fn check(&mut self, name: &str, result: Result<String, String>) {
        match result {
            Ok(detail) => println!("[smoke] ok   {name}: {detail}"),
            Err(detail) => {
                self.ok = false;
                println!("[smoke] FAIL {name}: {detail}");
            }
        }
    }

    pub fn info(&self, detail: &str) {
        println!("[smoke] info {detail}");
    }

    /// A line the sidecar printed for one of its checks.
    pub fn sidecar_line(&mut self, line: &str) {
        if line.starts_with("[smoke] FAIL") {
            self.ok = false;
        }
        println!("{line}");
    }

    pub fn window(&mut self, report: &str) {
        let report: Value = match serde_json::from_str(report) {
            Ok(report) => report,
            Err(error) => {
                self.check("window", Err(format!("unreadable report: {error}")));
                return;
            }
        };
        self.info(&format!(
            "webview: {}",
            report["userAgent"].as_str().unwrap_or("?")
        ));
        let title = report["title"].as_str().unwrap_or("");
        self.check(
            "ui",
            if report["children"].as_u64().unwrap_or(0) > 0 {
                Ok(format!("\"{title}\" rendered"))
            } else {
                Err("the UI root rendered nothing in 10 s".into())
            },
        );
        let path = report["path"].as_str().unwrap_or("");
        self.check(
            "bootstrap-redirect",
            if path == "/" {
                Ok("the window landed on / with no code left in its URL".into())
            } else {
                Err(format!("the window is on {path:?}"))
            },
        );
        let violations: Vec<&str> = report["violations"]
            .as_array()
            .map(|all| all.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let fonts = report["fonts"].as_u64().unwrap_or(0);
        self.check(
            "csp",
            if !violations.is_empty() {
                Err(format!(
                    "the page's policy blocked: {}",
                    violations.join(" | ")
                ))
            } else if fonts == 0 {
                Err("no font loaded".into())
            } else {
                Ok(format!("nothing blocked; {fonts} font(s) loaded"))
            },
        );
        self.check("request-secret-cookie", cookie_check(&report));
        self.check("ipc", ipc_check(&report));
    }

    pub fn finish(&self, sidecar_ok: bool) -> i32 {
        let ok = self.ok && sidecar_ok;
        println!("[smoke] {}", if ok { "passed" } else { "FAILED" });
        i32::from(!ok)
    }
}

/// Whether the page's requests carry the request secret's HttpOnly cookie. Without a GitHub
/// sign-in, as on CI, the events route answers 401 and EventSource can't open; the secret then
/// counts as carried when that 401 isn't the 403 a missing secret gets.
fn cookie_check(report: &Value) -> Result<String, String> {
    let api = &report["api"];
    let events = report["events"].as_str().unwrap_or("?");
    let events_status = &report["eventsStatus"];
    let visible = report["cookieVisible"].as_bool().unwrap_or(true);
    let problem = || {
        format!(
            "fetch got {api}, EventSource {events} ({events_status}), cookie visible to scripts: \
             {visible}"
        )
    };
    if api.as_u64() != Some(200) || visible {
        return Err(problem());
    }
    match (events, events_status.as_u64()) {
        ("open", _) => {
            Ok("fetch and EventSource carry the HttpOnly cookie; scripts can't read it".into())
        }
        ("error", Some(401)) => Ok("fetch and the events route carry the HttpOnly cookie; \
             scripts can't read it; EventSource can't open while nobody is signed in to GitHub"
            .into()),
        _ => Err(problem()),
    }
}

/// Whether the window's report after Reload shows the UI again, which it reached through a new
/// start-up link: a code the server refused would leave the window on that link's 403.
pub fn reload_check(report: &str) -> Result<String, String> {
    let report: Value =
        serde_json::from_str(report).map_err(|error| format!("unreadable report: {error}"))?;
    let path = report["path"].as_str().unwrap_or("");
    let api = &report["api"];
    if path == "/" && api.as_u64() == Some(200) && report["children"].as_u64().unwrap_or(0) > 0 {
        Ok("Reload opened a new start-up link, and the UI renders and reads the API again".into())
    } else {
        Err(format!(
            "after Reload the window is on {path:?} and fetch got {api}"
        ))
    }
}

/// Whether the page was refused when it called the shell, or had no way to.
fn ipc_check(report: &Value) -> Result<String, String> {
    match report["ipc"].as_str() {
        Some("absent") => Ok("the page has no IPC".into()),
        Some(ipc) if ipc.starts_with("rejected") => {
            Ok("the shell refused the page's call to the opener plugin".into())
        }
        Some(ipc) => Err(format!("the page's call to the opener plugin was {ipc}")),
        None => Err("the window didn't say whether it can call the shell".into()),
    }
}

pub fn report_of(url: &Url) -> String {
    url.query_pairs()
        .find(|(name, _)| name == "data")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fetch_and_event_source_carry_the_cookie() {
        let report = json!({ "api": 200, "events": "open", "cookieVisible": false });
        assert!(cookie_check(&report).is_ok());
    }

    #[test]
    fn without_a_github_sign_in_the_events_route_still_takes_the_cookie() {
        let report = json!({
            "api": 200, "events": "error", "eventsStatus": 401, "cookieVisible": false
        });
        let detail = cookie_check(&report).unwrap();
        assert!(detail.contains("nobody is signed in"), "{detail}");
    }

    #[test]
    fn a_refused_cookie_fails() {
        let report = json!({
            "api": 200, "events": "error", "eventsStatus": 403, "cookieVisible": false
        });
        assert!(cookie_check(&report).is_err());
        let report = json!({ "api": 403, "events": "open", "cookieVisible": false });
        assert!(cookie_check(&report).is_err());
    }

    #[test]
    fn reload_lands_on_the_ui_through_a_new_link() {
        let back = json!({ "path": "/", "api": 200, "children": 1 }).to_string();
        assert!(reload_check(&back).is_ok());
        let refused = json!({ "path": "/__bootstrap?code=x", "api": 403, "children": 0 });
        assert!(reload_check(&refused.to_string()).is_err());
        assert!(reload_check("not json").is_err());
    }

    #[test]
    fn the_page_cant_call_the_shell() {
        for ipc in ["absent", "rejected: plugin:opener|open_url not allowed"] {
            assert!(ipc_check(&json!({ "ipc": ipc })).is_ok(), "{ipc}");
        }
        for ipc in ["allowed", "no answer in 5 s"] {
            assert!(ipc_check(&json!({ "ipc": ipc })).is_err(), "{ipc}");
        }
        assert!(ipc_check(&json!({})).is_err());
    }

    #[test]
    fn a_cookie_scripts_can_read_fails() {
        let report = json!({ "api": 200, "events": "open", "cookieVisible": true });
        assert!(cookie_check(&report).is_err());
    }
}
