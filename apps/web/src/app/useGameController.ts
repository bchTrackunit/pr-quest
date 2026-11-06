import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AUTHOR_XP_REASONS,
  type AchievementDef,
  type GameOutcome,
  type PostReviewEvent,
  type ReviewRun,
  type ServerEvent,
  type UnlockedAchievement,
  type XpGain,
  type XpReason,
} from '@pr-quest/contract/api';
import {
  ApiRequestError,
  approveQuest,
  describeError,
  discardRun,
  eventsUrl,
  fetchAchievements,
  fetchMyPullRequests,
  fetchPlayer,
  fetchQuests,
  fetchRuns,
  fetchSettings,
  postRun,
  saveFindingSelection,
  startReview,
  startSelfReview,
} from '../platform/apiClient.ts';
import { connectEventStream, type EventStream } from './eventStream.ts';
import {
  activeRateLimit,
  applyMyPullRequestList,
  applyQuestList,
  applyServerEvent,
  createInitialGameState,
  createLocalId,
  findQuest,
  markAchievementUnlocked,
  questLabel,
  replaceRuns,
  resetForAccountChange,
  upsertRun,
  upsertRuns,
  type BoardTab,
  type GameState,
  type QuestActionError,
  type Toast,
  XP_REASON_LABELS,
  playLootSound,
  rewardLabel,
  unlockAudio,
} from '../features/game/index.ts';
import {
  getNotificationAccess,
  requestNotificationAccess,
  showBrowserNotification,
} from '../platform/notifications.ts';
import { settingsTargetFor, type SettingsTarget } from '../features/settings/index.ts';
import { createStore, type Store } from '../platform/store.ts';

export interface GameActions {
  /** The only path that forces a GitHub refetch; does nothing while GitHub rate limits us. */
  refreshQuests: () => void;
  /** Forces a GitHub refetch of the player's own PRs; does nothing while GitHub rate limits us. */
  refreshMyPullRequests: () => void;
  selectTab: (tab: BoardTab) => void;
  /**
   * After the GitHub account changed: forgets the previous player's game, reconnects the event
   * stream and reloads quests, runs and player from the server's cache.
   */
  resync: () => void;
  sendReviewAgent: (questId: string) => void;
  /** Sends the agent at one of the player's own PRs; its findings are never posted. */
  sendSelfReview: (prId: string) => void;
  openResult: (runId: string) => void;
  closeResult: () => void;
  requestApprove: (questId: string) => void;
  cancelApprove: () => void;
  /**
   * Approves `headSha`, the commit the dialog showed. Rejects with the server error so the dialog
   * can show it and stay open; on `headChanged` it also reloads the quests to show the new commit.
   */
  confirmApprove: (questId: string, headSha: string, comment: string) => Promise<void>;
  /** Saves selections one request at a time per run, so they reach the server in order. */
  selectFindings: (
    runId: string,
    findingIndexes: Array<number>,
    selected: boolean,
  ) => Promise<void>;
  /** Waits for the run's selection to be saved, then posts the selected findings the player confirmed. */
  postFindings: (
    runId: string,
    event: PostReviewEvent,
    findingIndexes: Array<number>,
  ) => Promise<void>;
  discardFindings: (runId: string) => Promise<void>;
  openSettings: (target?: SettingsTarget) => void;
  closeSettings: () => void;
  dismissToast: (toastId: string) => void;
  dismissXpPopup: (popupId: string) => void;
  toggleNotifications: () => void;
  toggleSound: () => void;
}

export interface GameController {
  store: Store<GameState>;
  actions: GameActions;
}

interface InternalHandlers {
  handleServerEvent: (event: ServerEvent) => void;
  loadQuests: (signal?: AbortSignal, options?: { refresh?: boolean }) => void;
  loadMyPullRequests: (signal?: AbortSignal, options?: { refresh?: boolean }) => void;
  loadSideData: (signal?: AbortSignal) => void;
}

const AUTHOR_XP_ICONS: Partial<Record<XpReason, string>> = {
  prMerged: '🚀',
  prApproved: '✅',
  threadResolved: '🧵',
};

const isFailure = (run: ReviewRun): boolean =>
  run.status === 'error' || run.status === 'startupFailed';

function withoutKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

/** Owns the game store, the initial loads, the event stream and every user action. */
export function useGameController(): GameController {
  const [store] = useState(() => createStore(createInitialGameState(getNotificationAccess())));
  const streamRef = useRef<EventStream | undefined>(undefined);

  const controller = useMemo<GameController & InternalHandlers>(() => {
    const announcedAchievements = new Set<string>();
    const announcedRuns = new Set<string>();
    const shownXpGains = new Set<string>();
    /** The latest selection save per run; each new save waits for the one before it. */
    const selectionSaves = new Map<string, Promise<unknown>>();
    /** Bumped on every account change; responses started for an older account are dropped. */
    const account = { generation: 0 };
    const isCurrent = (started: number): boolean => started === account.generation;

    const pushToast = (toast: Omit<Toast, 'id'>): void => {
      store.setState((state) => ({
        ...state,
        toasts: [...state.toasts, { ...toast, id: createLocalId('toast') }],
      }));
    };

    /**
     * The same gain arrives over REST and SSE; `eventId` makes sure it pops once. Author XP also
     * gets a toast, because a merged PR has already left the list by the time it pays.
     */
    const pushXpGain = ({ eventId, amount, reason, questId }: XpGain): void => {
      if (amount <= 0 || shownXpGains.has(eventId)) {
        return;
      }
      shownXpGains.add(eventId);
      store.setState((state) => ({
        ...state,
        xpPopups: [...state.xpPopups, { id: createLocalId('xp'), amount, reason }],
      }));
      if (AUTHOR_XP_REASONS.includes(reason)) {
        const pr = store.getState().myPullRequests.find((entry) => entry.id === questId);
        const message = pr ? `${questLabel(pr)}: ${pr.title}` : questId;
        pushToast({
          kind: 'success',
          title: `${XP_REASON_LABELS[reason]}: +${amount} XP`,
          ...(message ? { message } : {}),
          icon: AUTHOR_XP_ICONS[reason] ?? '⭐',
        });
      }
    };

    const announceAchievement = (achievement: AchievementDef): void => {
      if (announcedAchievements.has(achievement.id)) {
        return;
      }
      announcedAchievements.add(achievement.id);
      pushToast({
        kind: 'achievement',
        title: `Achievement unlocked: ${achievement.name}`,
        message: achievement.description,
        icon: achievement.icon,
        ...(achievement.xpReward > 0 ? { reward: rewardLabel(achievement) } : {}),
      });
    };

    const openResult = (runId: string): void => {
      store.setState((state) => ({ ...state, openRunId: runId }));
    };

    const announceRunTransition = (previous: ReviewRun | undefined, run: ReviewRun): void => {
      if (previous?.status === run.status || announcedRuns.has(`${run.id}:${run.status}`)) {
        return;
      }
      announcedRuns.add(`${run.id}:${run.status}`);
      const label = questLabel(run.quest);
      if (run.status === 'finished') {
        pushToast({
          kind: 'loot',
          title: 'Loot ready!',
          message: `The review agent returned from ${label}.`,
          icon: '💰',
          runId: run.id,
        });
        const { soundEnabled, notificationsEnabled } = store.getState();
        if (soundEnabled) {
          playLootSound();
        }
        if (notificationsEnabled) {
          showBrowserNotification({
            title: 'PR Quest: loot ready',
            body: `Review finished for ${label}: ${run.quest.title}`,
            tag: `run-${run.id}`,
            onSelect: () => openResult(run.id),
          });
        }
      } else if (isFailure(run)) {
        pushToast({
          kind: 'error',
          title: `The agent fell on ${label}`,
          message: run.error?.message ?? 'The review run failed.',
          icon: '💀',
        });
      }
    };

    const handleServerEvent = (event: ServerEvent): void => {
      const previous =
        event.type === 'runUpdated' ? store.getState().runs[event.run.id] : undefined;
      store.setState((state) => applyServerEvent(state, event));
      switch (event.type) {
        case 'runUpdated':
          announceRunTransition(previous, event.run);
          break;
        case 'xpGained':
          pushXpGain(event);
          break;
        case 'achievementUnlocked':
          announceAchievement(event.achievement);
          break;
        default:
          break;
      }
    };

    /** Applies the outcome a REST action returned; SSE repeats parts of it, de-duplicated by id. */
    const applyOutcome = (outcome: GameOutcome): void => {
      store.setState((state) => ({ ...state, player: outcome.player }));
      outcome.gains.forEach(pushXpGain);
      outcome.unlocked.forEach((unlocked: UnlockedAchievement) => {
        const sent = outcome.achievements?.find((entry) => entry.id === unlocked.id);
        const known = store.getState().achievements.find((entry) => entry.id === unlocked.id);
        const definition: AchievementDef = sent ??
          known ?? {
            id: unlocked.id,
            name: unlocked.id,
            description: '',
            icon: '🏅',
            xpReward: 0,
          };
        store.setState((state) => markAchievementUnlocked(state, definition, unlocked.unlockedAt));
        announceAchievement(definition);
      });
    };

    const setQuestAction = (
      questId: string,
      action: 'review' | undefined,
      error?: QuestActionError,
    ): void => {
      store.setState((state) => ({
        ...state,
        questActions: action
          ? { ...state.questActions, [questId]: action }
          : withoutKey(state.questActions, questId),
        questActionErrors: error
          ? { ...state.questActionErrors, [questId]: error }
          : withoutKey(state.questActionErrors, questId),
      }));
    };

    const loadQuests = (signal?: AbortSignal, options: { refresh?: boolean } = {}): void => {
      const started = account.generation;
      store.setState((state) => ({ ...state, questsLoad: 'loading', questsError: undefined }));
      fetchQuests(signal, options)
        .then((response) => {
          if (isCurrent(started)) {
            store.setState((state) => applyQuestList(state, response));
          }
        })
        .catch((reason: unknown) => {
          if (!signal?.aborted && isCurrent(started)) {
            store.setState((state) => ({
              ...state,
              questsLoad: 'error',
              questsError: describeError(reason),
            }));
          }
        });
    };

    const loadMyPullRequests = (
      signal?: AbortSignal,
      options: { refresh?: boolean } = {},
    ): void => {
      const started = account.generation;
      store.setState((state) => ({
        ...state,
        myPullRequestsLoad: 'loading',
        myPullRequestsError: undefined,
      }));
      fetchMyPullRequests(signal, options)
        .then((response) => {
          if (isCurrent(started)) {
            store.setState((state) => applyMyPullRequestList(state, response));
          }
        })
        .catch((reason: unknown) => {
          if (!signal?.aborted && isCurrent(started)) {
            store.setState((state) => ({
              ...state,
              myPullRequestsLoad: 'error',
              myPullRequestsError: describeError(reason),
            }));
          }
        });
    };

    /** Bumped per settings read, so an older response can't overwrite the provider a newer one read. */
    const providerReads = { latest: 0 };

    /** Lets quest cards say up front which quests the Cursor agent refuses; the server still checks. */
    const loadReviewProvider = (signal?: AbortSignal): void => {
      providerReads.latest += 1;
      const read = providerReads.latest;
      fetchSettings(signal)
        .then((response) => {
          if (read !== providerReads.latest) {
            return;
          }
          store.setState((state) =>
            state.reviewProvider === response.reviewProvider
              ? state
              : { ...state, reviewProvider: response.reviewProvider },
          );
        })
        .catch(() => undefined);
    };

    /** `replaceRuns` drops runs the server no longer lists, e.g. another player's. */
    const loadSideData = (signal?: AbortSignal, options: { replaceRuns?: boolean } = {}): void => {
      const started = account.generation;
      loadReviewProvider(signal);
      fetchRuns(signal)
        .then((response) => {
          if (isCurrent(started)) {
            store.setState((state) => ({
              ...(options.replaceRuns ? replaceRuns : upsertRuns)(state, response.runs),
              runsError: undefined,
            }));
          }
        })
        .catch((reason: unknown) => {
          if (signal?.aborted || !isCurrent(started)) {
            return;
          }
          // An older server has no runs route, and the quest board already says to sign in.
          const isExplained =
            reason instanceof ApiRequestError &&
            (reason.code === 'notImplemented' ||
              reason.code === 'notSignedIn' ||
              reason.status === 404 ||
              reason.status === 501);
          store.setState((state) => ({
            ...state,
            runsError: isExplained ? undefined : describeError(reason),
          }));
        });
      fetchPlayer(signal)
        .then((response) => {
          if (isCurrent(started)) {
            store.setState((state) => ({
              ...state,
              player: response.player,
              playerError: undefined,
            }));
          }
        })
        .catch((reason: unknown) => {
          if (!signal?.aborted && isCurrent(started)) {
            store.setState((state) => ({ ...state, playerError: describeError(reason) }));
          }
        });
      fetchAchievements(signal)
        .then((response) => {
          if (!isCurrent(started)) {
            return;
          }
          store.setState((state) => ({
            ...state,
            achievements: response.achievements,
            achievementsError: undefined,
          }));
        })
        .catch((reason: unknown) => {
          if (!signal?.aborted && isCurrent(started)) {
            store.setState((state) => ({ ...state, achievementsError: describeError(reason) }));
          }
        });
    };

    const sendAgent = (id: string, start: (id: string) => Promise<{ run: ReviewRun }>): void => {
      const started = account.generation;
      unlockAudio();
      setQuestAction(id, 'review');
      start(id)
        .then((response) => {
          if (isCurrent(started)) {
            store.setState((state) => upsertRun(state, response.run));
            setQuestAction(id, undefined);
          }
        })
        .catch((reason: unknown) => {
          if (isCurrent(started)) {
            setQuestAction(id, undefined, {
              message: describeError(reason),
              settings: settingsTargetFor(reason),
            });
          }
        });
    };

    const actions: GameActions = {
      refreshQuests: () => {
        if (activeRateLimit(store.getState().questsRateLimit, Date.now())) {
          return;
        }
        loadQuests(undefined, { refresh: true });
      },
      refreshMyPullRequests: () => {
        if (activeRateLimit(store.getState().myPullRequestsRateLimit, Date.now())) {
          return;
        }
        loadMyPullRequests(undefined, { refresh: true });
      },
      selectTab: (tab) =>
        store.setState((state) => (state.tab === tab ? state : { ...state, tab })),
      resync: () => {
        account.generation += 1;
        announcedAchievements.clear();
        announcedRuns.clear();
        shownXpGains.clear();
        store.setState(resetForAccountChange);
        // The open stream was authorised for the previous account, or failed while signed out.
        streamRef.current?.reconnectNow();
        loadQuests();
        loadMyPullRequests();
        loadSideData(undefined, { replaceRuns: true });
      },
      sendReviewAgent: (questId) => sendAgent(questId, startReview),
      sendSelfReview: (prId) => sendAgent(prId, startSelfReview),
      openResult,
      closeResult: () => store.setState((state) => ({ ...state, openRunId: undefined })),
      requestApprove: (questId) =>
        store.setState((state) => ({ ...state, approveQuestId: questId })),
      cancelApprove: () => store.setState((state) => ({ ...state, approveQuestId: undefined })),
      confirmApprove: async (questId, headSha, comment) => {
        const started = account.generation;
        const quest = findQuest(store.getState(), questId);
        const response = await approveQuest(questId, headSha, comment.trim() || undefined).catch(
          (reason: unknown) => {
            if (
              reason instanceof ApiRequestError &&
              reason.code === 'headChanged' &&
              isCurrent(started)
            ) {
              // The server already recorded the new head; this reads it from its cache.
              loadQuests();
            }
            throw reason;
          },
        );
        if (!isCurrent(started)) {
          return;
        }
        store.setState((state) => {
          const openRun = state.openRunId ? state.runs[state.openRunId] : undefined;
          return {
            ...state,
            quests: state.quests.filter((entry) => entry.id !== response.questId),
            approveQuestId: undefined,
            openRunId: openRun?.questId === response.questId ? undefined : state.openRunId,
          };
        });
        pushToast({
          kind: 'success',
          title: 'Quest complete',
          message: `Approved ${quest ? questLabel(quest) : questId}.`,
          icon: '✅',
        });
        applyOutcome(response.outcome);
      },
      selectFindings: async (runId, findingIndexes, selected) => {
        const started = account.generation;
        const previous = selectionSaves.get(runId) ?? Promise.resolve();
        const save = previous
          .catch(() => undefined)
          .then(() => saveFindingSelection(runId, { findingIndexes, selected }));
        selectionSaves.set(runId, save);
        try {
          const response = await save;
          if (isCurrent(started)) {
            store.setState((state) => upsertRun(state, response.run));
          }
        } finally {
          if (selectionSaves.get(runId) === save) {
            selectionSaves.delete(runId);
          }
        }
      },
      postFindings: async (runId, event, findingIndexes) => {
        const started = account.generation;
        await selectionSaves.get(runId)?.catch(() => undefined);
        const response = await postRun(runId, { event, findingIndexes });
        if (!isCurrent(started)) {
          return;
        }
        store.setState((state) => ({ ...upsertRun(state, response.run), openRunId: undefined }));
        pushToast({
          kind: 'success',
          title: 'Review posted',
          message: 'The findings are on the PR.',
          icon: '📜',
          href: response.reviewUrl,
        });
        applyOutcome(response.outcome);
      },
      discardFindings: async (runId) => {
        const started = account.generation;
        const response = await discardRun(runId);
        if (isCurrent(started)) {
          store.setState((state) => ({ ...upsertRun(state, response.run), openRunId: undefined }));
        }
      },
      openSettings: (target = { section: 'github' }) =>
        store.setState((state) => ({ ...state, settings: target })),
      closeSettings: () => {
        store.setState((state) => ({ ...state, settings: undefined }));
        loadReviewProvider();
      },
      dismissToast: (toastId) =>
        store.setState((state) => ({
          ...state,
          toasts: state.toasts.filter((toast) => toast.id !== toastId),
        })),
      dismissXpPopup: (popupId) =>
        store.setState((state) => ({
          ...state,
          xpPopups: state.xpPopups.filter((popup) => popup.id !== popupId),
        })),
      toggleNotifications: () => {
        const { notificationAccess, notificationsEnabled } = store.getState();
        if (notificationAccess === 'granted') {
          store.setState((state) => ({ ...state, notificationsEnabled: !notificationsEnabled }));
          return;
        }
        if (notificationAccess !== 'default') {
          return;
        }
        requestNotificationAccess()
          .then((access) => {
            store.setState((state) => ({
              ...state,
              notificationAccess: access,
              notificationsEnabled: access === 'granted',
            }));
          })
          .catch(() => undefined);
      },
      toggleSound: () => {
        unlockAudio();
        store.setState((state) => ({ ...state, soundEnabled: !state.soundEnabled }));
      },
    };

    return { store, actions, handleServerEvent, loadQuests, loadMyPullRequests, loadSideData };
  }, [store]);

  useEffect(() => {
    const abort = new AbortController();
    controller.loadQuests(abort.signal);
    controller.loadMyPullRequests(abort.signal);
    controller.loadSideData(abort.signal);
    return () => abort.abort();
  }, [controller]);

  useEffect(() => {
    const stream = connectEventStream({
      url: eventsUrl,
      onEvent: controller.handleServerEvent,
      onStatusChange: (connection, reconnected) => {
        store.setState((state) =>
          state.connection === connection ? state : { ...state, connection },
        );
        if (reconnected) {
          // Never `refresh: true`: a flapping connection must not turn into GitHub calls.
          controller.loadQuests();
          controller.loadMyPullRequests();
          controller.loadSideData();
        }
      },
    });
    streamRef.current = stream;
    return () => {
      streamRef.current = undefined;
      stream.close();
    };
  }, [store, controller]);

  return controller;
}
