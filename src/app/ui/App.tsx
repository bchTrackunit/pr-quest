import { ApproveDialog, ReviewResult } from '../../features/reviews/ui/index.ts';
import {
  findQuest,
  type GameState,
  PlayerHud,
  Toasts,
  XpPopups,
} from '../../features/game/ui/index.ts';
import { GitHubAccountControl, useGitHubAccount } from '../../features/auth/ui/index.ts';
import { QuestBoard } from '../../features/quests/ui/index.ts';
import { SettingsDialog } from '../../features/settings/ui/index.ts';
import { useStoreState } from '../../platform/ui/store.ts';
import { HeaderControls } from './HeaderControls.tsx';
import { PreferencesMenu } from './PreferencesMenu.tsx';
import { useGameController } from './useGameController.ts';

const selectState = (state: GameState): GameState => state;

export const App = () => {
  const { store, actions } = useGameController();
  const github = useGitHubAccount(actions.resync);
  const state = useStoreState(store, selectState);
  const openRun = state.openRunId ? state.runs[state.openRunId] : undefined;
  const approveQuest = findQuest(state, state.approveQuestId);

  return (
    <div className="app">
      <a className="skip-link" href="#quest-board">
        Skip to quests
      </a>
      <header className="app__header">
        <div className="app__topbar">
          <h1 className="app__title pixel">
            <span aria-hidden="true">⚔️</span> PR Quest
          </h1>
          <HeaderControls
            account={
              <GitHubAccountControl actions={github.actions} state={github.state}>
                <PreferencesMenu
                  notificationAccess={state.notificationAccess}
                  notificationsEnabled={state.notificationsEnabled}
                  onClickNotifications={actions.toggleNotifications}
                  onClickSettings={() => actions.openSettings()}
                  onClickSound={actions.toggleSound}
                  soundEnabled={state.soundEnabled}
                />
              </GitHubAccountControl>
            }
            connection={state.connection}
          />
        </div>
        <div className="app__hud">
          <PlayerHud
            achievements={state.achievements}
            achievementsError={state.achievementsError}
            player={state.player}
            playerError={state.playerError}
          />
          <XpPopups onDone={actions.dismissXpPopup} popups={state.xpPopups} />
        </div>
      </header>

      <main className="app__main" id="quest-board" tabIndex={-1}>
        {state.runsError ? (
          <p className="notice notice--warning" role="alert">
            Couldn&apos;t load your review runs: {state.runsError}
          </p>
        ) : null}
        <QuestBoard
          error={state.questsError}
          fetchedAt={state.questsFetchedAt}
          loadState={state.questsLoad}
          onClickApprove={actions.requestApprove}
          onClickOpenResult={actions.openResult}
          onClickOpenSettings={actions.openSettings}
          onClickRefresh={actions.refreshQuests}
          onClickSendAgent={actions.sendReviewAgent}
          questActionErrors={state.questActionErrors}
          questActions={state.questActions}
          quests={state.quests}
          rateLimit={state.questsRateLimit}
          runs={state.runs}
          source={state.questSource}
          stale={state.questsStale}
        />
      </main>

      {openRun ? (
        <ReviewResult
          key={openRun.id}
          onClickApprove={actions.requestApprove}
          onClickClose={actions.closeResult}
          onDiscard={() => actions.discardFindings(openRun.id)}
          onPost={(event) => actions.postFindings(openRun.id, event)}
          quest={findQuest(state, openRun.questId)}
          run={openRun}
        />
      ) : null}

      {approveQuest ? (
        <ApproveDialog
          key={approveQuest.id}
          onClickClose={actions.cancelApprove}
          onConfirm={(comment, headSha) =>
            actions.confirmApprove(approveQuest.id, headSha, comment)
          }
          quest={approveQuest}
        />
      ) : null}

      {state.settings ? (
        <SettingsDialog
          github={github}
          onClickClose={actions.closeSettings}
          target={state.settings}
        />
      ) : null}

      <Toasts
        onClickOpenResult={actions.openResult}
        onDismiss={actions.dismissToast}
        toasts={state.toasts}
      />
    </div>
  );
};
