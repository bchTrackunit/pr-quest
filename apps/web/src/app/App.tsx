import { ApproveDialog, ReviewResult } from '../features/reviews/index.ts';
import { findQuest, type GameState, PlayerHud, Toasts, XpPopups } from '../features/game/index.ts';
import { GitHubAccountControl, useGitHubAccount } from '../features/auth/index.ts';
import { countNeedingMyAction, MyPullRequestBoard, QuestBoard } from '../features/quests/index.ts';
import { SettingsDialog } from '../features/settings/index.ts';
import { useStoreState } from '../platform/store.ts';
import { BOARD_PANEL_ID, BoardTabs, boardTabId } from './BoardTabs.tsx';
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
        Skip to the board
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
        <BoardTabs
          needsMyAction={
            state.myPullRequestsFetchedAt === undefined
              ? undefined
              : countNeedingMyAction(state.myPullRequests)
          }
          onSelect={actions.selectTab}
          tab={state.tab}
        />
        <div aria-labelledby={boardTabId(state.tab)} id={BOARD_PANEL_ID} role="tabpanel">
          {state.tab === 'mine' ? (
            <MyPullRequestBoard
              error={state.myPullRequestsError}
              fetchedAt={state.myPullRequestsFetchedAt}
              loadState={state.myPullRequestsLoad}
              onClickOpenResult={actions.openResult}
              onClickOpenSettings={actions.openSettings}
              onClickRefresh={actions.refreshMyPullRequests}
              onClickSelfReview={actions.sendSelfReview}
              pullRequests={state.myPullRequests}
              questActionErrors={state.questActionErrors}
              questActions={state.questActions}
              rateLimit={state.myPullRequestsRateLimit}
              reviewProvider={state.reviewProvider}
              runs={state.runs}
              stale={state.myPullRequestsStale}
            />
          ) : (
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
              reviewProvider={state.reviewProvider}
              runs={state.runs}
              source={state.questSource}
              stale={state.questsStale}
            />
          )}
        </div>
      </main>

      {openRun ? (
        <ReviewResult
          key={openRun.id}
          onClickApprove={actions.requestApprove}
          onClickClose={actions.closeResult}
          onDiscard={() => actions.discardFindings(openRun.id)}
          onPost={(event, findingIndexes) =>
            actions.postFindings(openRun.id, event, findingIndexes)
          }
          onSelect={(findingIndexes, selected) =>
            actions.selectFindings(openRun.id, findingIndexes, selected)
          }
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
