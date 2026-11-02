export interface ReleaseRepo {
  owner: string;
  repo: string;
}

/** The part of electron-builder's GitHub publish options this sets. */
export interface GithubPublishSettings extends ReleaseRepo {
  provider: 'github';
  releaseType: 'draft';
}

/** Stands in for the real owner until the repository is public. Nothing publishes to it or updates from it. */
export const PLACEHOLDER_OWNER = 'CHANGE-ME';

/**
 * The GitHub repository that hosts PR Quest and its releases. electron-builder publishes installers
 * there, the app checks its releases for updates, and Help opens its README. Change it here when the
 * repository moves; it is the only place that names it.
 */
export const RELEASE_REPO: ReleaseRepo = { owner: PLACEHOLDER_OWNER, repo: 'pr-quest' };

export const README_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}#readme`;

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

/** Whether `repo` names a real repository that releases may be published to and updates read from. */
export function isPublishable(repo: ReleaseRepo): boolean {
  // GitHub owner names are case-insensitive, so `change-me` is the placeholder too.
  return (
    repo.owner.toLowerCase() !== PLACEHOLDER_OWNER.toLowerCase() &&
    GITHUB_NAME.test(repo.owner) &&
    GITHUB_NAME.test(repo.repo)
  );
}

/**
 * electron-builder's `publish` setting. It also decides whether a build writes `app-update.yml`,
 * the file the app's updater reads, so only a release build of a real repository gets one.
 */
export function publishSettings(options: {
  releaseBuild: boolean;
  repo: ReleaseRepo;
}): GithubPublishSettings | null {
  if (!options.releaseBuild) {
    return null;
  }
  if (!isPublishable(options.repo)) {
    throw new Error(
      `A release build needs a real repository, but RELEASE_REPO is ${options.repo.owner}/${options.repo.repo}. Set it in src/desktop/release.ts.`,
    );
  }
  return {
    provider: 'github',
    owner: options.repo.owner,
    repo: options.repo.repo,
    releaseType: 'draft',
  };
}
