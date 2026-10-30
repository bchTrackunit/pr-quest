import { ApproveDialog } from './ApproveDialog.tsx';
import { findQuest, type GameState } from './gameState.ts';
import { PlayerHud } from './PlayerHud.tsx';
import { QuestBoard } from './QuestBoard.tsx';
import { ReviewResult } from './ReviewResult.tsx';
import { useStoreState } from './store.ts';
import { Toasts } from './Toasts.tsx';
import { useGameController } from './useGameController.ts';
import { XpPopups } from './XpPopups.tsx';

const selectState = (state: GameState): GameState => state;

export const App = () => {
  const { store, actions } = useGameController();
  const state = useStoreState(store, selectState);
  const openRun = state.openRunId ? state.runs[state.openRunId] : undefined;
  const approveQuest = findQuest(state, state.approveQuestId);

  return (
    <div className="app">
      <a className="skip-link" href="#quest-board">
        Skip to quests
      </a>
      <header className="app__header">
        <h1 className="app__title pixel">
          <span aria-hidden="true">⚔️</span> PR Quest
        </h1>
        <PlayerHud
          achievements={state.achievements}
          achievementsError={state.achievementsError}
          connection={state.connection}
          notificationAccess={state.notificationAccess}
          notificationsEnabled={state.notificationsEnabled}
          onClickNotifications={actions.toggleNotifications}
          onClickSound={actions.toggleSound}
          player={state.player}
          playerError={state.playerError}
          soundEnabled={state.soundEnabled}
        />
        <XpPopups onDone={actions.dismissXpPopup} popups={state.xpPopups} />
      </header>

      <main className="app__main" id="quest-board" tabIndex={-1}>
        <QuestBoard
          error={state.questsError}
          fetchedAt={state.questsFetchedAt}
          loadState={state.questsLoad}
          onClickApprove={actions.requestApprove}
          onClickOpenResult={actions.openResult}
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

      <Toasts
        onClickOpenResult={actions.openResult}
        onDismiss={actions.dismissToast}
        toasts={state.toasts}
      />
    </div>
  );
};
