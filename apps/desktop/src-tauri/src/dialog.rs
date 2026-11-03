//! Native message dialogs, through rfd as tauri-plugin-dialog does, without the plugin's file
//! system parts. Never call these on the main thread: they wait for it to show the dialog.

use std::sync::mpsc;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use tauri::AppHandle;

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warning,
    Error,
}

/// Shows `message` with one or two buttons and returns the index of the one chosen. Closing the
/// dialog, or pressing Escape, chooses the last button, so put the one that changes nothing last.
pub fn ask(app: &AppHandle, level: Level, message: &str, detail: &str, labels: &[&str]) -> usize {
    let buttons = match labels {
        [ok] => MessageButtons::OkCustom((*ok).to_owned()),
        [ok, cancel, ..] => MessageButtons::OkCancelCustom((*ok).to_owned(), (*cancel).to_owned()),
        [] => MessageButtons::Ok,
    };
    // Windows shows a title in the title bar only, so the message goes into the text there.
    let (title, description) = if cfg!(windows) {
        ("PR Quest".to_owned(), format!("{message}\n\n{detail}"))
    } else {
        (message.to_owned(), detail.to_owned())
    };
    let dialog = AsyncMessageDialog::new()
        .set_level(match level {
            Level::Info => MessageLevel::Info,
            Level::Warning => MessageLevel::Warning,
            Level::Error => MessageLevel::Error,
        })
        .set_title(title)
        .set_description(description)
        .set_buttons(buttons);
    let (tx, rx) = mpsc::channel();
    let shown = app.run_on_main_thread(move || {
        let future = dialog.show();
        std::thread::spawn(move || {
            let _ = tx.send(tauri::async_runtime::block_on(future));
        });
    });
    let result = match shown {
        Ok(()) => rx.recv().unwrap_or(MessageDialogResult::Cancel),
        Err(_) => MessageDialogResult::Cancel,
    };
    chosen(labels, &result)
}

pub fn error(app: &AppHandle, message: &str, detail: &str) {
    ask(app, Level::Error, message, detail, &["Quit"]);
}

/// The index of the button `result` stands for. GTK reports the second button and closing the
/// dialog alike, as Cancel, so both mean the last button.
fn chosen(labels: &[&str], result: &MessageDialogResult) -> usize {
    let last = labels.len().saturating_sub(1);
    match result {
        MessageDialogResult::Custom(label) => labels
            .iter()
            .position(|candidate| candidate == label)
            .unwrap_or(last),
        MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
        _ => last,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LABELS: [&str; 2] = ["Try Again", "Continue Without Saved Keys"];

    #[test]
    fn a_button_by_its_label() {
        assert_eq!(
            chosen(&LABELS, &MessageDialogResult::Custom("Try Again".into())),
            0
        );
        assert_eq!(
            chosen(
                &LABELS,
                &MessageDialogResult::Custom("Continue Without Saved Keys".into())
            ),
            1
        );
    }

    #[test]
    fn ok_is_the_first_button() {
        assert_eq!(chosen(&LABELS, &MessageDialogResult::Ok), 0);
    }

    #[test]
    fn closing_the_dialog_is_the_last_button() {
        assert_eq!(chosen(&LABELS, &MessageDialogResult::Cancel), 1);
        assert_eq!(chosen(&LABELS, &MessageDialogResult::Custom("?".into())), 1);
        assert_eq!(chosen(&["Quit"], &MessageDialogResult::Cancel), 0);
    }
}
