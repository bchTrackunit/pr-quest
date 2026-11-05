export interface PullRequestLinksProps {
  githubUrl: string;
  /** Linear review page, when Linear resolved the PR. */
  linearUrl?: string;
}

/**
 * The PR's Guide tab in Linear, whose view-mode path segment is `review`. Without a Linear review
 * page, `linear.review` takes the GitHub path and redirects to the PR in the reader's workspace.
 */
export function linearGuideUrl({ githubUrl, linearUrl }: PullRequestLinksProps): string {
  const url = new URL(linearUrl ?? githubUrl);
  if (linearUrl === undefined) {
    url.host = 'linear.review';
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/review`;
  return url.toString();
}

export const PullRequestLinks = (props: PullRequestLinksProps) => (
  <>
    <a className="button" href={linearGuideUrl(props)} rel="noopener noreferrer" target="_blank">
      Open in Linear
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
    <a className="button" href={props.githubUrl} rel="noopener noreferrer" target="_blank">
      Open on GitHub
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  </>
);
