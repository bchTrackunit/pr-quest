/**
 * The GitHub repository that hosts PR Quest and its releases. electron-builder publishes installers
 * there, the app checks its releases for updates, and Help opens its README. Change it here when the
 * repository moves; it is the only place that names it.
 */
export const RELEASE_REPO = { owner: 'CHANGE-ME', repo: 'pr-quest' } as const;

export const README_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}#readme`;
