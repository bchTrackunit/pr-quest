//! The app menu: About, the Edit menu (without it, copy and paste shortcuts don't work on macOS),
//! View with Reload, the Window menu, Help and Quit. Nothing in it opens the developer tools, which release builds
//! don't have. Help links to the release repository only once it is a real one.

use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::release::Repo;
use crate::updates::release_repo;

/// Handled in main.rs, which has the server: see `reload` there.
pub const RELOAD: &str = "reload";
const DOWNLOAD_LATEST: &str = "download-latest";
const PROJECT_PAGE: &str = "project-page";

/// Help's items that open the repository: none for the placeholder, whose pages don't exist.
fn repo_links(repo: &Repo) -> &'static [(&'static str, &'static str)] {
    if repo.is_publishable() {
        &[
            (DOWNLOAD_LATEST, "Download the Latest Version"),
            (PROJECT_PAGE, "PR Quest on GitHub"),
        ]
    } else {
        &[]
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let repo = release_repo();
    let publishable = repo.is_publishable();
    let about = PredefinedMenuItem::about(
        app,
        Some("About PR Quest"),
        Some(AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            website: publishable.then(|| repo.project_url()),
            website_label: publishable.then(|| "PR Quest on GitHub".into()),
            license: Some("MIT".into()),
            ..AboutMetadata::default()
        }),
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&MenuItem::with_id(
            app,
            RELOAD,
            "Reload",
            true,
            Some("CmdOrCtrl+R"),
        )?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let links = repo_links(&repo)
        .iter()
        .map(|(id, label)| MenuItem::with_id(app, *id, *label, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit PR Quest"))?;

    if cfg!(target_os = "macos") {
        let app_menu = Submenu::with_items(
            app,
            "PR Quest",
            true,
            &[
                &about,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;
        let menu = Menu::with_items(app, &[&app_menu, &edit, &view, &window])?;
        if !links.is_empty() {
            let items: Vec<&dyn IsMenuItem<R>> = links
                .iter()
                .map(|item| item as &dyn IsMenuItem<R>)
                .collect();
            menu.append(&Submenu::with_items(app, "Help", true, &items)?)?;
        }
        Ok(menu)
    } else {
        let file = Submenu::with_items(app, "File", true, &[&quit])?;
        let mut items: Vec<&dyn IsMenuItem<R>> = links
            .iter()
            .map(|item| item as &dyn IsMenuItem<R>)
            .collect();
        if !items.is_empty() {
            items.push(&separator);
        }
        items.push(&about);
        let help = Submenu::with_items(app, "Help", true, &items)?;
        Menu::with_items(app, &[&file, &edit, &view, &window, &help])
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let repo = release_repo();
    if !repo.is_publishable() {
        return;
    }
    let url = match event.id().as_ref() {
        DOWNLOAD_LATEST => repo.latest_release_url(),
        PROJECT_PAGE => repo.project_url(),
        _ => return,
    };
    let _ = app.opener().open_url(url, None::<&str>);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_to_a_real_repository() {
        let repo = Repo::parse("octocat/pr-quest").unwrap();
        let ids: Vec<&str> = repo_links(&repo).iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, [DOWNLOAD_LATEST, PROJECT_PAGE]);
    }

    #[test]
    fn has_no_links_to_the_placeholder_which_go_nowhere() {
        let repo = Repo::parse(crate::release::DEFAULT_REPO).unwrap();
        assert!(repo_links(&repo).is_empty());
    }
}
