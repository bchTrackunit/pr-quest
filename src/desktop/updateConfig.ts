/**
 * What's wrong with a packaged `app-update.yml`, the settings electron-updater reads in the
 * installed app, or nothing. electron-builder writes the file as flat YAML: one top-level key per
 * line, and `publisherName` as a list of `- ` items below its key.
 *
 * - A `channel` makes the app look for that channel's update files, such as `beta-mac.yml`, while
 *   releases publish only the `latest` ones.
 * - A signed Windows build must name its publisher, or the updater installs an update without
 *   checking who signed it.
 */
export function updateConfigProblems(text: string, options: { signed: boolean }): Array<string> {
  const values = topLevelValues(text);
  const problems: Array<string> = [];
  if (!values.has('provider')) {
    problems.push('it names no provider, so no updater can use it');
  }
  if (values.has('channel')) {
    problems.push(
      "it sets a channel, so the app would look for that channel's update files, which releases don't publish",
    );
  }
  if (options.signed && (values.get('publisherName') ?? []).length === 0) {
    problems.push(
      "it has no publisherName, so the updater wouldn't check who signed an update; electron-builder takes it from AZURE_SIGNING_PUBLISHER or the certificate",
    );
  }
  return problems;
}

/** Each top-level key with its inline value or its list items, unquoted. */
function topLevelValues(text: string): Map<string, Array<string>> {
  const values = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (key?.[1] !== undefined) {
      const inline = unquote(key[2] ?? '');
      current = inline === '' || inline === '[]' ? [] : [inline];
      values.set(key[1], current);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line)?.[1];
    if (item !== undefined && current !== undefined && unquote(item) !== '') {
      current.push(unquote(item));
    }
  }
  return values;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
