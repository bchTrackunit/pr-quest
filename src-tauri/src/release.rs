//! The GitHub repository PR Quest is released from. The app checks its releases for updates, and
//! Help opens it. build.rs includes this file too, to refuse a release build of the placeholder.

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
