//! The app menu: About, the Edit menu (without it, copy and paste shortcuts don't work on macOS),
//! the Window menu, Help and Quit. Nothing in it opens the developer tools, which release builds
//! don't have.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::updates::release_repo;

const DOWNLOAD_LATEST: &str = "download-latest";
const PROJECT_PAGE: &str = "project-page";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = PredefinedMenuItem::about(
        app,
        Some("About PR Quest"),
        Some(AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            website: Some(release_repo().project_url()),
            website_label: Some("PR Quest on GitHub".into()),
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
    let download = MenuItem::with_id(
        app,
        DOWNLOAD_LATEST,
        "Download the Latest Version",
        true,
        None::<&str>,
    )?;
    let project = MenuItem::with_id(app, PROJECT_PAGE, "PR Quest on GitHub", true, None::<&str>)?;
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
        let help = Submenu::with_items(app, "Help", true, &[&download, &project])?;
        Menu::with_items(app, &[&app_menu, &edit, &window, &help])
    } else {
        let file = Submenu::with_items(app, "File", true, &[&quit])?;
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[
                &download,
                &project,
                &PredefinedMenuItem::separator(app)?,
                &about,
            ],
        )?;
        Menu::with_items(app, &[&file, &edit, &window, &help])
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let repo = release_repo();
    let url = match event.id().as_ref() {
        DOWNLOAD_LATEST => repo.latest_release_url(),
        PROJECT_PAGE => repo.project_url(),
        _ => return,
    };
    let _ = app.opener().open_url(url, None::<&str>);
}
