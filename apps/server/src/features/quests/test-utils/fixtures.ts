import { readFileSync } from 'node:fs';

import {
  parsePullRequestBatch,
  parseSearchResults,
  type PullRequestDetails,
  type ReviewRequestData,
} from '../github.ts';

/** A recorded GitHub response from `apps/server/src/platform/fixtures/github`. */
export const fixture = (name: string): string =>
  readFileSync(new URL(`../../../platform/fixtures/github/${name}`, import.meta.url), 'utf8');

function batchDetails(): Array<PullRequestDetails> {
  return parsePullRequestBatch(fixture('graphql-batch.json'), 2).entries.map((entry) => {
    if (!('details' in entry)) {
      throw new Error('graphql-batch.json must resolve both PRs');
    }
    return entry.details;
  });
}

/** The two fixture PRs: `Trackunit/circleci-configuration#930` (team) and `Trackunit/state-of-code#24` (direct). */
export function reviewRequests(): Array<ReviewRequestData> {
  const [teamItem, directItem] = parseSearchResults(fixture('search-all.json'));
  const [teamDetails, directDetails] = batchDetails();
  if (!teamItem || !directItem || !teamDetails || !directDetails) {
    throw new Error('the search and batch fixtures need two PRs');
  }
  return [
    { item: teamItem, details: teamDetails, direct: false },
    { item: directItem, details: directDetails, direct: true },
  ];
}
