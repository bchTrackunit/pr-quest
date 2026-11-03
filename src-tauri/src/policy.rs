//! What the window may do: show only the app, hand web and mail links to the system, and use only
//! the browser permissions the UI needs.

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Url;

/// Schemes the system may open for a link in the UI; anything else could launch a local program.
const EXTERNAL_SCHEMES: [&str; 3] = ["https", "http", "mailto"];

/// Whether `url` is a page of the app itself, served by its own server at `app`.
pub fn is_app_url(url: &Url, app: &Url) -> bool {
    url.origin() == app.origin()
}

/// The URL to hand to the system browser, or `None` when it isn't a web or mail link.
pub fn external_url(url: &Url) -> Option<&Url> {
    EXTERNAL_SCHEMES.contains(&url.scheme()).then_some(url)
}

/// Denies every permission except desktop notifications, which the UI uses, and only for the app's
/// own pages. Copying the sign-in code needs no permission. macOS's WebKit has no notifications.
pub fn permission(kind: PermissionKind, page: Option<&Url>, app: &Url) -> PermissionResponse {
    let on_app = page.is_some_and(|page| is_app_url(page, app));
    if on_app && matches!(kind, PermissionKind::Notifications) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    fn app() -> Url {
        url("http://127.0.0.1:53124/")
    }

    #[test]
    fn the_apps_own_pages_are_the_app() {
        for page in [
            "http://127.0.0.1:53124/",
            "http://127.0.0.1:53124/api/health",
            "http://127.0.0.1:53124/?quest=1#top",
        ] {
            assert!(is_app_url(&url(page), &app()), "{page}");
        }
    }

    #[test]
    fn other_origins_are_not_the_app() {
        for page in [
            "http://127.0.0.1:4318/",
            "http://localhost:53124/",
            "https://127.0.0.1:53124/",
            "https://github.com/",
        ] {
            assert!(!is_app_url(&url(page), &app()), "{page}");
        }
    }

    #[test]
    fn web_and_mail_links_open_in_the_system() {
        for link in [
            "https://github.com/octo/repo/pull/1",
            "http://example.com/",
            "mailto:someone@example.com",
        ] {
            assert_eq!(
                external_url(&url(link)).map(Url::as_str),
                Some(url(link).as_str())
            );
        }
    }

    #[test]
    fn other_schemes_never_reach_the_system() {
        for link in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "smb://server/share",
            "x-apple.systempreferences:",
            "ms-settings:",
        ] {
            assert_eq!(external_url(&url(link)), None, "{link}");
        }
    }

    #[test]
    fn grants_notifications_to_the_app() {
        assert_eq!(
            permission(PermissionKind::Notifications, Some(&app()), &app()),
            PermissionResponse::Allow
        );
    }

    #[test]
    fn denies_everything_else() {
        for kind in [
            PermissionKind::Camera,
            PermissionKind::Microphone,
            PermissionKind::Geolocation,
            PermissionKind::ClipboardRead,
            PermissionKind::DisplayCapture,
            PermissionKind::Other,
        ] {
            assert_eq!(
                permission(kind, Some(&app()), &app()),
                PermissionResponse::Deny,
                "{kind}"
            );
        }
    }

    #[test]
    fn denies_notifications_to_other_origins_and_unknown_pages() {
        let evil = url("https://evil.example/");
        assert_eq!(
            permission(PermissionKind::Notifications, Some(&evil), &app()),
            PermissionResponse::Deny
        );
        assert_eq!(
            permission(PermissionKind::Notifications, None, &app()),
            PermissionResponse::Deny
        );
    }
}
