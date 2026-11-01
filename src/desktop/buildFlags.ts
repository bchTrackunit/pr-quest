/** Replaced by esbuild in scripts/build-desktop.ts; undefined anywhere else, such as in tests. */
declare const __PR_QUEST_RELEASE_BUILD__: boolean | undefined;

/** True only in a bundle built with `PR_QUEST_RELEASE_BUILD=1`, which a release pipeline sets. */
export const RELEASE_BUILD =
  typeof __PR_QUEST_RELEASE_BUILD__ === 'boolean' && __PR_QUEST_RELEASE_BUILD__;
