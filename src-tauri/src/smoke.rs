//! `PR_QUEST_SMOKE_TEST=1` checks a packaged build, prints one `[smoke]` line per check and exits
//! with whether all passed; scripts/desktop-smoke.ts runs it. The shell checks the keychain, the
//! window and the updater, then asks the sidecar for its checks: the server, both SDKs and their
//! native parts.

use serde_json::Value;
use tauri::Url;

/// The window has no IPC (the page is remote), so its script reports by navigating to this path of
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
    await sleep(500);
    const report = {
      path: location.pathname + location.search,
      title: document.title,
      children,
      fonts,
      api,
      events,
      eventsStatus,
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
    fn a_cookie_scripts_can_read_fails() {
        let report = json!({ "api": 200, "events": "open", "cookieVisible": true });
        assert!(cookie_check(&report).is_err());
    }
}
