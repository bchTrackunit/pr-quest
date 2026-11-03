#[allow(dead_code)]
#[path = "src/release.rs"]
mod release;

use std::{env, fs};

/// Bakes the release settings into the binary: `PR_QUEST_RELEASE_BUILD=1` marks a release build,
/// the only kind that updates itself, and `PR_QUEST_RELEASE_REPO` (`owner/name`) names the
/// repository it updates from. A release build of the placeholder repository, or with the
/// development updater key, fails here.
fn main() {
    println!("cargo:rerun-if-env-changed=PR_QUEST_RELEASE_BUILD");
    println!("cargo:rerun-if-env-changed=PR_QUEST_RELEASE_REPO");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let release_build = env::var("PR_QUEST_RELEASE_BUILD").as_deref() == Ok("1");
    let repo_value = env::var("PR_QUEST_RELEASE_REPO")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| release::DEFAULT_REPO.to_owned());
    let Some(repo) = release::Repo::parse(&repo_value) else {
        panic!("PR_QUEST_RELEASE_REPO must be a GitHub owner/name, not {repo_value:?}");
    };
    if release_build && !repo.is_publishable() {
        panic!(
            "A release build needs a real repository, but PR_QUEST_RELEASE_REPO is {repo_value}. Set PR_QUEST_RELEASE_REPO=owner/name."
        );
    }
    if release_build {
        let base = fs::read_to_string("tauri.conf.json").expect("tauri.conf.json is readable");
        let overlay = env::var("TAURI_CONFIG").ok();
        if let Some(problem) = release::updater_key_problem(&base, overlay.as_deref()) {
            panic!("{problem}");
        }
    }
    println!("cargo:rustc-env=PR_QUEST_RELEASE_REPO={repo_value}");
    println!(
        "cargo:rustc-env=PR_QUEST_RELEASE_BUILD={}",
        u8::from(release_build)
    );
    tauri_build::build();
}
