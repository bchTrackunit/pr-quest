//! The GitHub repository PR Quest is released from. The app checks its releases for updates, and
//! Help opens it. build.rs includes this file too, to refuse a release build of the placeholder or
//! with the development updater key.

/// Stands in for the real owner until the repository is public. Nothing updates from it.
pub const PLACEHOLDER_OWNER: &str = "CHANGE-ME";

/// The repository when `PR_QUEST_RELEASE_REPO` isn't set at build time. Change it here when the
/// repository moves; it is the only place that names it. Only build.rs reads it.
#[allow(dead_code)]
pub const DEFAULT_REPO: &str = "CHANGE-ME/pr-quest";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Repo<'a> {
    pub owner: &'a str,
    pub name: &'a str,
}

impl<'a> Repo<'a> {
    /// `owner/name`, as GitHub writes it, or `None` when it isn't one.
    pub fn parse(value: &'a str) -> Option<Repo<'a>> {
        let (owner, name) = value.split_once('/')?;
        (is_github_name(owner) && is_github_name(name)).then_some(Repo { owner, name })
    }

    /// Whether this names a real repository that the app may update from.
    pub fn is_publishable(&self) -> bool {
        // GitHub owner names are case-insensitive, so `change-me` is the placeholder too.
        !self.owner.eq_ignore_ascii_case(PLACEHOLDER_OWNER)
    }

    pub fn project_url(&self) -> String {
        format!("https://github.com/{}/{}#readme", self.owner, self.name)
    }

    pub fn latest_release_url(&self) -> String {
        format!(
            "https://github.com/{}/{}/releases/latest",
            self.owner, self.name
        )
    }

    /// The updater manifest that the release pipeline attaches to each release.
    pub fn update_manifest_url(&self) -> String {
        format!(
            "https://github.com/{}/{}/releases/latest/download/latest.json",
            self.owner, self.name
        )
    }
}

/// Why a release build's updater key won't do, if it won't: the one in tauri.conf.json (`base`) is
/// for local builds, whose private half isn't kept secret, so a release must replace it through
/// the `--config` overlay that `tauri build` passes as `TAURI_CONFIG`. Keys are compared trimmed,
/// and a blank one counts as missing.
#[allow(dead_code)]
pub fn updater_key_problem(base: &str, overlay: Option<&str>) -> Option<String> {
    let pubkey = |config: &serde_json::Value| {
        config
            .pointer("/plugins/updater/pubkey")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
    };
    let base = match serde_json::from_str(base) {
        Ok(config) => pubkey(&config),
        Err(error) => return Some(format!("tauri.conf.json isn't valid JSON: {error}")),
    };
    let release = match overlay.map(serde_json::from_str) {
        Some(Ok(config)) => pubkey(&config),
        Some(Err(error)) => return Some(format!("TAURI_CONFIG isn't valid JSON: {error}")),
        None => None,
    };
    match release {
        Some(key) if Some(&key) != base.as_ref() => None,
        _ => Some(
            "A release build needs its own updater key: set PR_QUEST_UPDATER_PUBKEY and package \
             with apps/desktop/scripts/desktop-package.ts; the key in tauri.conf.json is for local builds"
                .into(),
        ),
    }
}

fn is_github_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_name() {
        assert_eq!(
            Repo::parse("octocat/pr-quest"),
            Some(Repo {
                owner: "octocat",
                name: "pr-quest"
            })
        );
    }

    #[test]
    fn refuses_what_isnt_a_repository() {
        for value in [
            "",
            "octocat",
            "/pr-quest",
            "octocat/",
            "octo/cat/pr-quest",
            "octo cat/pr-quest",
        ] {
            assert_eq!(Repo::parse(value), None, "{value:?}");
        }
    }

    #[test]
    fn a_real_owner_is_publishable() {
        assert!(Repo::parse("octocat/pr-quest").unwrap().is_publishable());
    }

    #[test]
    fn the_placeholder_isnt_publishable_in_any_case() {
        for value in [DEFAULT_REPO, "change-me/pr-quest", "Change-Me/other"] {
            assert!(!Repo::parse(value).unwrap().is_publishable(), "{value}");
        }
    }

    const BASE: &str = r#"{"plugins":{"updater":{"pubkey":"DEV"}}}"#;

    #[test]
    fn a_release_needs_its_own_updater_key() {
        let release = r#"{"plugins":{"updater":{"pubkey":"RELEASE"}}}"#;
        assert_eq!(updater_key_problem(BASE, Some(release)), None);
    }

    #[test]
    fn refuses_the_development_updater_key() {
        for overlay in [
            None,
            Some(r#"{"bundle":{"createUpdaterArtifacts":true}}"#),
            Some(r#"{"plugins":{"updater":{"pubkey":"DEV"}}}"#),
            Some(r#"{"plugins":{"updater":{"pubkey":"DEV\n"}}}"#),
            Some(r#"{"plugins":{"updater":{"pubkey":"  DEV "}}}"#),
            Some(r#"{"plugins":{"updater":{"pubkey":" \n"}}}"#),
        ] {
            let problem = updater_key_problem(BASE, overlay);
            assert!(
                problem
                    .as_deref()
                    .is_some_and(|p| p.contains("PR_QUEST_UPDATER_PUBKEY")),
                "{overlay:?}: {problem:?}"
            );
        }
    }

    #[test]
    fn refuses_configuration_it_cant_read() {
        assert!(updater_key_problem("{", None).is_some());
        assert!(updater_key_problem(BASE, Some("not json")).is_some());
    }

    #[test]
    fn links_to_the_repository() {
        let repo = Repo::parse("octocat/pr-quest").unwrap();
        assert_eq!(
            repo.project_url(),
            "https://github.com/octocat/pr-quest#readme"
        );
        assert_eq!(
            repo.latest_release_url(),
            "https://github.com/octocat/pr-quest/releases/latest"
        );
        assert_eq!(
            repo.update_manifest_url(),
            "https://github.com/octocat/pr-quest/releases/latest/download/latest.json"
        );
    }
}
