import { useEffect, useMemo, useState } from 'react';

import type {
  AchievementDef,
  GameOutcome,
  PostReviewEvent,
  ReviewRun,
  ServerEvent,
  UnlockedAchievement,
  XpGain,
} from '../shared/api.ts';
import {
  ApiRequestError,
  approveQuest,
  describeError,
  discardRun,
  eventsUrl,
  fetchAchievements,
  fetchPlayer,
  fetchQuests,
  fetchRuns,
  postRun,
  startReview,
} from './apiClient.ts';
import { connectEventStream } from './eventStream.ts';
import {
  activeRateLimit,
  applyQuestList,
  applyServerEvent,
  createInitialGameState,
  createLocalId,
  findQuest,
  markAchievementUnlocked,
  questLabel,
  upsertRun,
  upsertRuns,
  type GameState,
  type Toast,
} from './gameState.ts';
import {
  getNotificationAccess,
  requestNotificationAccess,
  showBrowserNotification,
} from './notifications.ts';
import { playLootSound, unlockAudio } from './sound.ts';
import { createStore, type Store } from './store.ts';

export interface GameActions {
  /** The only path that forces a GitHub refetch; does nothing while GitHub rate limits us. */
  refreshQuests: () => void;
  /** Reloads quests, runs and player from the server's cache, e.g. after the GitHub user changed. */
  resync: () => void;
  sendReviewAgent: (questId: string) => void;
  openResult: (runId: string) => void;
  closeResult: () => void;
  requestApprove: (questId: string) => void;
  cancelApprove: () => void;
  /**
   * Approves `headSha`, the commit the dialog showed. Rejects with the server error so the dialog
   * can show it and stay open; on `headChanged` it also reloads the quests to show the new commit.
   */
  confirmApprove: (questId: string, headSha: string, comment: string) => Promise<void>;
  postFindings: (runId: string, event: PostReviewEvent) => Promise<void>;
  discardFindings: (runId: string) => Promise<void>;
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
  loadSideData: (signal?: AbortSignal) => void;
}

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

  const controller = useMemo<GameController & InternalHandlers>(() => {
    const announcedAchievements = new Set<string>();
    const announcedRuns = new Set<string>();
    const shownXpGains = new Set<string>();

    const pushToast = (toast: Omit<Toast, 'id'>): void => {
      store.setState((state) => ({
        ...state,
        toasts: [...state.toasts, { ...toast, id: createLocalId('toast') }],
      }));
    };

    /** The same gain arrives over REST and SSE; `eventId` makes sure it pops once. */
    const pushXpGain = ({ eventId, amount, reason }: XpGain): void => {
      if (amount <= 0 || shownXpGains.has(eventId)) {
        return;
      }
      shownXpGains.add(eventId);
      store.setState((state) => ({
        ...state,
        xpPopups: [...state.xpPopups, { id: createLocalId('xp'), amount, reason }],
      }));
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
        const known = store.getState().achievements.find((entry) => entry.id === unlocked.id);
        const definition: AchievementDef = known ?? {
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
      error?: string,
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
      store.setState((state) => ({ ...state, questsLoad: 'loading', questsError: undefined }));
      fetchQuests(signal, options)
        .then((response) => {
          store.setState((state) => applyQuestList(state, response));
        })
        .catch((reason: unknown) => {
          if (!signal?.aborted) {
            store.setState((state) => ({
              ...state,
              questsLoad: 'error',
              questsError: describeError(reason),
            }));
          }
        });
    };

    const loadSideData = (signal?: AbortSignal): void => {
      fetchRuns(signal)
        .then((response) => store.setState((state) => upsertRuns(state, response.runs)))
        .catch(() => undefined);
      fetchPlayer(signal)
        .then((response) =>
          store.setState((state) => ({
            ...state,
            player: response.player,
            playerError: undefined,
          })),
        )
        .catch((reason: unknown) => {
          if (!signal?.aborted) {
            store.setState((state) => ({ ...state, playerError: describeError(reason) }));
          }
        });
      fetchAchievements(signal)
        .then((response) => {
          for (const achievement of response.achievements) {
            if (achievement.unlockedAt) {
              announcedAchievements.add(achievement.id);
            }
          }
          store.setState((state) => ({
            ...state,
            achievements: response.achievements,
            achievementsError: undefined,
          }));
        })
        .catch((reason: unknown) => {
          if (!signal?.aborted) {
            store.setState((state) => ({ ...state, achievementsError: describeError(reason) }));
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
      resync: () => {
        loadQuests();
        loadSideData();
      },
      sendReviewAgent: (questId) => {
        unlockAudio();
        setQuestAction(questId, 'review');
        startReview(questId)
          .then((response) => {
            store.setState((state) => upsertRun(state, response.run));
            setQuestAction(questId, undefined);
          })
          .catch((reason: unknown) => setQuestAction(questId, undefined, describeError(reason)));
      },
      openResult,
      closeResult: () => store.setState((state) => ({ ...state, openRunId: undefined })),
      requestApprove: (questId) =>
        store.setState((state) => ({ ...state, approveQuestId: questId })),
      cancelApprove: () => store.setState((state) => ({ ...state, approveQuestId: undefined })),
      confirmApprove: async (questId, headSha, comment) => {
        const quest = findQuest(store.getState(), questId);
        const response = await approveQuest(questId, headSha, comment.trim() || undefined).catch(
          (reason: unknown) => {
            if (reason instanceof ApiRequestError && reason.code === 'headChanged') {
              // The server already recorded the new head; this reads it from its cache.
              loadQuests();
            }
            throw reason;
          },
        );
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
      postFindings: async (runId, event) => {
        const response = await postRun(runId, { event });
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
        const response = await discardRun(runId);
        store.setState((state) => ({ ...upsertRun(state, response.run), openRunId: undefined }));
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

    return { store, actions, handleServerEvent, loadQuests, loadSideData };
  }, [store]);

  useEffect(() => {
    const abort = new AbortController();
    controller.loadQuests(abort.signal);
    controller.loadSideData(abort.signal);
    return () => abort.abort();
  }, [controller]);

  useEffect(
    () =>
      connectEventStream({
        url: eventsUrl,
        onEvent: controller.handleServerEvent,
        onStatusChange: (connection, reconnected) => {
          store.setState((state) =>
            state.connection === connection ? state : { ...state, connection },
          );
          if (reconnected) {
            // Never `refresh: true`: a flapping connection must not turn into GitHub calls.
            controller.loadQuests();
            controller.loadSideData();
          }
        },
      }),
    [store, controller],
  );

  return controller;
}
