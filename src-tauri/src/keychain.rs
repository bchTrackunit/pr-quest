//! The per-install data key that encrypts saved keys, kept in the OS keychain (the macOS
//! Keychain, the Windows Credential Manager or the Linux Secret Service). The sidecar gets it on
//! stdin and does the encrypting; see src/desktop/sidecar/dataKeyEncryptor.ts.

use base64::{engine::general_purpose::STANDARD, Engine};
use keyring::{Entry, Error};

/// The same as the bundle identifier, so the entry is easy to find and remove.
const SERVICE: &str = "com.prquest.desktop";
/// The real app's entry. The smoke test uses its own, which it deletes afterwards.
pub const ACCOUNT: &str = "secrets-data-key";
const KEY_BYTES: usize = 32;

/// The data key in base64, made and saved on the first run. An error says why the keychain can't
/// be used, and the app then keeps new keys only in memory.
pub fn data_key(account: &str) -> Result<String, String> {
    let entry = Entry::new(SERVICE, account).map_err(describe)?;
    match entry.get_password() {
        Ok(key) if is_key(&key) => Ok(key),
        // Replacing it would lose the keys it encrypted, if it ever was a key.
        Ok(_) => Err(format!(
            "the keychain entry {SERVICE}/{account} isn't a data key"
        )),
        Err(Error::NoEntry) => {
            let key = STANDARD.encode(crate::random_bytes::<KEY_BYTES>());
            entry.set_password(&key).map_err(describe)?;
            // A keychain that "saves" without keeping, like a locked or mock one, would lose the
            // keys encrypted with it on the next start.
            match entry.get_password() {
                Ok(read) if read == key => Ok(key),
                Ok(_) => Err("the keychain returned a different data key than it saved".into()),
                Err(error) => Err(describe(error)),
            }
        }
        Err(error) => Err(describe(error)),
    }
}

pub fn delete(account: &str) -> Result<(), String> {
    Entry::new(SERVICE, account)
        .and_then(|entry| entry.delete_credential())
        .map_err(describe)
}

fn is_key(value: &str) -> bool {
    STANDARD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == KEY_BYTES)
}

fn describe(error: Error) -> String {
    format!("the OS keychain can't be used: {error}")
}
