/*
 * Tauri's Windows signCommand while packaging (see scripts/desktop/config.ts): signs one file with
 * PR_QUEST_WINDOWS_SIGN_COMMAND, e.g. `trusted-signing-cli -e <endpoint> -a <account> -c
 * <profile> %1` for Azure Trusted Signing, or `signtool sign /fd SHA256 /tr <timestamp url> /td
 * SHA256 /sha1 <thumbprint> %1` for a certificate in the store.
 *
 *   node scripts/sign-windows.ts <file>
 */
import { signWindowsFile } from './desktop/sign.ts';

const [file] = process.argv.slice(2);
const template = process.env.PR_QUEST_WINDOWS_SIGN_COMMAND;
if (file === undefined || template === undefined || template === '') {
  throw new Error(
    'Usage: PR_QUEST_WINDOWS_SIGN_COMMAND="... %1" node scripts/sign-windows.ts <file>',
  );
}
signWindowsFile(template, file);
