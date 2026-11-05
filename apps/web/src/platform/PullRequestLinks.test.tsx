// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { PullRequestLinks } from './PullRequestLinks.tsx';

const GITHUB_URL = 'https://github.com/Trackunit/manager/pull/101';

describe('PullRequestLinks', () => {
  afterEach(cleanup);

  test("opens the PR's Linear guide and GitHub page in new tabs", () => {
    render(
      <PullRequestLinks
        githubUrl={GITHUB_URL}
        linearUrl="https://linear.app/trackunit/review/manager-101"
      />,
    );

    const linear = screen.getByRole('link', { name: /Open in Linear/ });
    expect(linear.getAttribute('href')).toBe(
      'https://linear.app/trackunit/review/manager-101/review',
    );
    expect(linear.getAttribute('target')).toBe('_blank');
    const github = screen.getByRole('link', { name: /Open on GitHub/ });
    expect(github.getAttribute('href')).toBe(GITHUB_URL);
    expect(github.getAttribute('target')).toBe('_blank');
  });

  test('opens the guide through linear.review when Linear has not resolved the PR', () => {
    render(<PullRequestLinks githubUrl={GITHUB_URL} />);

    expect(screen.getByRole('link', { name: /Open in Linear/ }).getAttribute('href')).toBe(
      'https://linear.review/Trackunit/manager/pull/101/review',
    );
  });
});
