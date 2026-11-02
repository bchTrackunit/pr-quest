//! `PR_QUEST_SMOKE_TEST=1` checks a packaged build, prints one `[smoke]` line per check and exits
//! with whether all passed; scripts/tauri-smoke.ts runs it. The shell checks the keychain and the
//! window, then asks the sidecar for its checks: the server, both SDKs and their native parts.

use serde_json::Value;
use tauri::Url;

/// The window has no IPC (the page is remote), so its script reports by navigating here, which
/// the shell's navigation handler catches and cancels.
pub const REPORT_SCHEME: &str = "prquest-smoke";

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
    await sleep(500);
    const report = {
      path: location.pathname + location.search,
      title: document.title,
      children,
      fonts,
      api,
      events,
      cookieVisible: document.cookie.includes('pr_quest_secret'),
      violations,
      userAgent: navigator.userAgent,
    };
    location.href = `prquest-smoke://report?data=${encodeURIComponent(JSON.stringify(report))}`;
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
        let api = &report["api"];
        let events = report["events"].as_str().unwrap_or("?");
        let visible = report["cookieVisible"].as_bool().unwrap_or(true);
        self.check(
            "request-secret-cookie",
            if api.as_u64() == Some(200) && events == "open" && !visible {
                Ok("fetch and EventSource carry the HttpOnly cookie; scripts can't read it".into())
            } else {
                Err(format!(
                    "fetch got {api}, EventSource {events}, cookie visible to scripts: {visible}"
                ))
            },
        );
    }

    pub fn finish(&self, sidecar_ok: bool) -> i32 {
        let ok = self.ok && sidecar_ok;
        println!("[smoke] {}", if ok { "passed" } else { "FAILED" });
        i32::from(!ok)
    }
}

pub fn report_of(url: &Url) -> String {
    url.query_pairs()
        .find(|(name, _)| name == "data")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}
