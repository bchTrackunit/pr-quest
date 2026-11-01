/* Replaced by esbuild in scripts/build-desktop.ts; undefined anywhere else, such as in tests. */
declare const __PR_QUEST_RELEASE_BUILD__: boolean | undefined;
declare const __PR_QUEST_RELEASE_REPO__: string | undefined;

/** True only in a bundle built with `PR_QUEST_RELEASE_BUILD=1`, which a release pipeline sets. */
export const RELEASE_BUILD =
  typeof __PR_QUEST_RELEASE_BUILD__ === 'boolean' && __PR_QUEST_RELEASE_BUILD__;

/** The PR_QUEST_RELEASE_REPO the bundle was built with, so the running app never reads its own. */
export const RELEASE_REPO_OVERRIDE =
  typeof __PR_QUEST_RELEASE_REPO__ === 'string' ? __PR_QUEST_RELEASE_REPO__ : undefined;
