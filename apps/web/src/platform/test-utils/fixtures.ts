import type {
  AchievementStatus,
  PlayerState,
  Quest,
  ReviewResult,
  ReviewRun,
} from '@pr-quest/contract/api';

export function makeQuest(overrides: Partial<Quest> = {}): Quest {
  const number = overrides.number ?? 101;
  return {
    id: `Trackunit/manager#${number}`,
    title: 'Add the fleet health widget',
    repo: { owner: 'Trackunit', name: 'manager' },
    number,
    author: { name: 'Ada Lovelace', githubLogin: 'ada' },
    sourceBranch: 'feature/fleet-health',
    targetBranch: 'main',
    headSha: '0123456789abcdef0123456789abcdef01234567',
    status: 'open',
    isDraft: false,
    approvedByOthers: false,
    approvalCount: 0,
    diffStats: { fileCount: 4, additions: 120, deletions: 30 },
    difficulty: 'Normal',
    requestKind: 'direct',
    requestedTeams: [],
    needsAttention: false,
    githubUrl: `https://github.com/Trackunit/manager/pull/${number}`,
    linearUrl: `https://linear.app/trackunit/review/manager-${number}`,
    openedAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
    requestedAt: '2026-10-28T10:00:00.000Z',
    source: 'linear',
    ...overrides,
  };
}

export function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'Solid change with one risky query.',
    verdict: 'comment',
    findings: [
      { file: 'src/widget.tsx', line: 12, severity: 'minor', body: 'Name this constant.' },
      { file: 'src/query.ts', line: 40, severity: 'critical', body: 'This query is unbounded.' },
      { file: 'README.md', severity: 'nit', body: 'Typo in heading.' },
    ],
    ...overrides,
  };
}

export function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-1',
    questId: 'Trackunit/manager#101',
    quest: {
      title: 'Add the fleet health widget',
      repo: { owner: 'Trackunit', name: 'manager' },
      number: 101,
      githubUrl: 'https://github.com/Trackunit/manager/pull/101',
      linearUrl: 'https://linear.app/trackunit/review/manager-101',
    },
    provider: 'cursor',
    status: 'queued',
    disposition: 'pending',
    startedAt: '2026-10-30T10:00:00.000Z',
    ...overrides,
  };
}

export function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    xp: 450,
    level: 3,
    xpIntoLevel: 150,
    xpForNextLevel: 400,
    streakDays: 2,
    achievements: [{ id: 'first-blood', unlockedAt: '2026-10-20T10:00:00.000Z' }],
    counters: {
      reviewsPosted: 3,
      approvals: 2,
      changesRequested: 0,
      agentReviews: 4,
      teamReviews: 3,
      bossesSlain: 0,
      quickDraws: 1,
    },
    ...overrides,
  };
}

export function makeAchievements(): Array<AchievementStatus> {
  return [
    {
      id: 'first-blood',
      name: 'First Blood',
      description: 'Post your first review.',
      icon: '🩸',
      xpReward: 25,
      rarity: 'common',
      category: 'milestones',
      unlockedAt: '2026-10-20T10:00:00.000Z',
    },
    {
      id: 'team-player',
      name: 'Team Player',
      description: 'Review 10 team-requested PRs.',
      icon: '🤝',
      xpReward: 50,
      rarity: 'rare',
      category: 'milestones',
      target: 10,
      progress: 3,
    },
    {
      id: 'on-fire',
      name: 'On Fire',
      description: 'Keep a 5-day streak.',
      icon: '🔥',
      xpReward: 100,
      rarity: 'epic',
      category: 'streaks',
      secret: true,
    },
  ];
}
