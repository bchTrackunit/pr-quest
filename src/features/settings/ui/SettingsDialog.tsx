import { useEffect, useId, useState, type FormEvent } from 'react';

import {
  API_KEY_NAMES,
  type ApiKeyName,
  type ListModelsResponse,
  type ReviewProvider,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '../../../shared/api.ts';
import {
  ApiRequestError,
  describeError,
  fetchModels,
  fetchSettings,
  removeApiKey,
  setApiKey,
  updateSettings,
} from '../../../platform/ui/apiClient.ts';
import { ApiKeyRow } from './ApiKeyRow.tsx';
import {
  DeviceCodePanel,
  AccountAvatar,
  FallbackNotice,
  TokenSourceBadge,
  TOKEN_SOURCE_DESCRIPTIONS,
  type GitHubAccountController,
} from '../../auth/ui/index.ts';
import { Modal } from '../../../platform/ui/Modal.tsx';
import {
  KEY_META,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  REVIEW_PROVIDERS,
  type SettingsSection,
  type SettingsTarget,
} from './settingsModel.ts';

export interface SettingsDialogProps {
  target: SettingsTarget;
  github: GitHubAccountController;
  onClickClose: () => void;
}

type SettingsLoad =
  | { state: 'loading' }
  | { state: 'ready'; settings: SettingsResponse }
  | { state: 'unavailable' }
  | { state: 'error'; error: string };

/** `unsupported`: the server has no models endpoint yet, so the model is typed in. */
type ModelsLoad =
  | { state: 'ready'; response: ListModelsResponse }
  | { state: 'unsupported' }
  | { state: 'error'; error: string };

function isUnsupported(reason: unknown): boolean {
  return (
    reason instanceof ApiRequestError &&
    (reason.code === 'notImplemented' || reason.status === 404 || reason.status === 501)
  );
}

const SECTION_TITLES: Record<SettingsSection, string> = {
  github: 'GitHub account',
  provider: 'Review provider',
  keys: 'API keys',
};

/** Heading that the popup focuses when it opens at that section. */
const SectionHeading = ({
  id,
  section,
  target,
}: {
  id: string;
  section: SettingsSection;
  target: SettingsTarget;
}) => (
  <h3
    className="settings__heading pixel"
    data-autofocus={target.section === section ? '' : undefined}
    id={id}
    tabIndex={-1}
  >
    {SECTION_TITLES[section]}
  </h3>
);

export const SettingsDialog = ({ target, github, onClickClose }: SettingsDialogProps) => {
  const [load, setLoad] = useState<SettingsLoad>({ state: 'loading' });
  const [models, setModels] = useState<Partial<Record<ReviewProvider, ModelsLoad>>>({});
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const baseId = useId();
  const keyInputId = (name: ApiKeyName): string => `${baseId}-key-${name}`;

  useEffect(() => {
    const abort = new AbortController();
    fetchSettings(abort.signal)
      .then((loaded) => setLoad({ state: 'ready', settings: loaded }))
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) {
          setLoad(
            isUnsupported(reason)
              ? { state: 'unavailable' }
              : { state: 'error', error: describeError(reason) },
          );
        }
      });
    return () => abort.abort();
  }, []);

  const settings = load.state === 'ready' ? load.settings : undefined;
  const provider = settings?.reviewProvider;
  const hasModels = provider !== undefined && models[provider] !== undefined;

  useEffect(() => {
    if (!provider || hasModels) {
      return undefined;
    }
    const abort = new AbortController();
    fetchModels(provider, abort.signal)
      .then((response) =>
        setModels((current) => ({ ...current, [provider]: { state: 'ready', response } })),
      )
      .catch((reason: unknown) => {
        if (abort.signal.aborted) {
          return;
        }
        setModels((current) => ({
          ...current,
          [provider]: isUnsupported(reason)
            ? { state: 'unsupported' }
            : { state: 'error', error: describeError(reason) },
        }));
      });
    return () => abort.abort();
  }, [provider, hasModels]);

  /** Runs one write at a time and reports it in the live region. */
  const save = async (
    operation: string,
    request: () => Promise<SettingsResponse>,
    done: string,
    optimistic?: SettingsResponse,
  ): Promise<void> => {
    const previous = settings;
    setPending(operation);
    setSaveError(undefined);
    setSaveStatus('Saving…');
    if (optimistic) {
      setLoad({ state: 'ready', settings: optimistic });
    }
    try {
      const next = await request();
      setLoad({ state: 'ready', settings: next });
      setSaveStatus(done);
    } catch (reason) {
      if (previous) {
        setLoad({ state: 'ready', settings: previous });
      }
      setSaveStatus('');
      setSaveError(`Couldn't save: ${describeError(reason)}`);
      throw reason;
    } finally {
      setPending(undefined);
    }
  };

  const isBusy = pending !== undefined;

  /**
   * Ignored while another write runs, so responses can't land out of order and a failed write
   * can't roll back to a snapshot that predates the other one.
   */
  const saveSettings = (body: UpdateSettingsRequest, done: string, operation: string): void => {
    if (!settings || isBusy) {
      return;
    }
    const optimistic: SettingsResponse = {
      ...settings,
      reviewProvider: body.reviewProvider ?? settings.reviewProvider,
      models: { ...settings.models },
    };
    for (const name of REVIEW_PROVIDERS) {
      const model = body.models?.[name];
      if (model === null) {
        delete optimistic.models[name];
      } else if (model !== undefined) {
        optimistic.models[name] = model;
      }
    }
    save(operation, () => updateSettings(body), done, optimistic).catch(() => undefined);
  };

  const chooseModel = (forProvider: ReviewProvider, model: string): void => {
    const label = PROVIDER_LABELS[forProvider];
    saveSettings(
      { models: { [forProvider]: model || null } },
      model ? `${label} reviews use ${model}.` : `${label} reviews use the default model.`,
      'model',
    );
  };

  /** A provider's model list depends on its key, so a changed key reloads it. */
  const forgetModelsFor = (name: ApiKeyName): void =>
    setModels((current) => {
      const next = { ...current };
      for (const option of REVIEW_PROVIDERS) {
        if (PROVIDER_KEYS[option] === name) {
          delete next[option];
        }
      }
      return next;
    });

  const saveKey = (name: ApiKeyName, value: string): Promise<void> =>
    save(
      `key:${name}`,
      () => setApiKey(name, value),
      `Saved the ${KEY_META[name].label} key.`,
    ).then(() => forgetModelsFor(name));

  const removeKey = (name: ApiKeyName): Promise<void> =>
    save(
      `remove:${name}`,
      () => removeApiKey(name),
      `Removed the ${KEY_META[name].label} key.`,
    ).then(() => forgetModelsFor(name));

  const renderGitHub = () => {
    const { state, actions } = github;
    if (state.load === 'loading') {
      return <p className="muted">Checking GitHub…</p>;
    }
    if (state.load === 'unavailable') {
      return <p className="muted">This server doesn&apos;t support GitHub sign-in yet.</p>;
    }
    const { account, device } = state;
    const isOAuthIdle = account?.tokenSource === 'oauth' && device.state === 'idle';
    return (
      <>
        {state.load === 'error' ? (
          <p className="form-error">GitHub account unknown: {state.loadError}</p>
        ) : null}
        <FallbackNotice actions={actions} state={state} />
        {account ? (
          <div className="settings__account">
            <AccountAvatar account={account} />
            <div>
              <p>
                <strong>@{account.login}</strong>
                {account.name ? <span className="muted"> · {account.name}</span> : null}
              </p>
              <p className="muted">{TOKEN_SOURCE_DESCRIPTIONS[account.tokenSource]}</p>
            </div>
            <TokenSourceBadge account={account} />
          </div>
        ) : (
          <p>Not signed in to GitHub.</p>
        )}
        {state.accountError ? (
          <p className="form-error">GitHub rejected the token: {state.accountError}</p>
        ) : null}
        {account?.tokenSource === 'gh' ? (
          <p className="muted">
            Sign in with GitHub to give PR Quest its own token instead of the gh CLI login.
          </p>
        ) : null}
        {account?.tokenSource === 'oauth' ? (
          <div className="button-row">
            <button
              className="button"
              disabled={state.pending === 'signOut'}
              onClick={actions.signOut}
              type="button"
            >
              {state.pending === 'signOut' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        ) : null}
        {isOAuthIdle ? null : <DeviceCodePanel actions={actions} autoFocus={false} state={state} />}
      </>
    );
  };

  const renderModel = (forProvider: ReviewProvider, current: SettingsResponse) => {
    const label = PROVIDER_LABELS[forProvider];
    const saved = current.models[forProvider];
    const modelId = `${baseId}-model-${forProvider}`;
    const entry = models[forProvider];
    if (!entry) {
      return (
        <p aria-busy="true" className="muted" role="status">
          Loading {label} models…
        </p>
      );
    }
    if (entry.state !== 'ready') {
      const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get('model');
        chooseModel(forProvider, typeof value === 'string' ? value.trim() : '');
      };
      return (
        <form className="settings__model-form" key={saved ?? ''} onSubmit={handleSubmit}>
          <label className="field" htmlFor={modelId}>
            <span className="field__label">{label} model</span>
            <input
              className="field__input"
              defaultValue={saved ?? ''}
              id={modelId}
              name="model"
              placeholder="Leave empty for the default model"
              spellCheck={false}
              type="text"
            />
          </label>
          <button className="button" disabled={isBusy} type="submit">
            Save model
          </button>
          <p className="muted settings__note">
            {entry.state === 'unsupported'
              ? "This server can't list models yet; type a model id."
              : `Couldn't load the models (${entry.error}); type a model id.`}
          </p>
        </form>
      );
    }
    const { response } = entry;
    const isKnown = saved === undefined || response.models.some((model) => model.id === saved);
    return (
      <div className="stack">
        <label className="field" htmlFor={modelId}>
          <span className="field__label">{label} model</span>
          {/* aria-disabled rather than disabled, so a keyboard player keeps focus here. */}
          <select
            aria-disabled={isBusy || undefined}
            className="field__input"
            id={modelId}
            onChange={(event) => chooseModel(forProvider, event.target.value)}
            value={saved ?? ''}
          >
            <option value="">{label} default</option>
            {isKnown || !saved ? null : <option value={saved}>{saved} (saved)</option>}
            {response.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        {response.source === 'fallback' ? (
          <p className="muted settings__note">
            Fallback list: {label} couldn&apos;t be asked for its models
            {response.error ? ` (${response.error})` : ''}, so this is PR Quest&apos;s built-in
            list.
          </p>
        ) : null}
      </div>
    );
  };

  const renderProvider = () => {
    if (!settings || !provider) {
      return null;
    }
    const keyName = PROVIDER_KEYS[provider];
    return (
      <>
        <fieldset className="settings__providers">
          <legend className="field__label">Who reviews your quests</legend>
          {REVIEW_PROVIDERS.map((option) => (
            <label className="radio" key={option}>
              <input
                aria-disabled={isBusy || undefined}
                checked={provider === option}
                name={`${baseId}-provider`}
                onChange={() =>
                  saveSettings(
                    { reviewProvider: option },
                    `${PROVIDER_LABELS[option]} reviews your quests now.`,
                    'provider',
                  )
                }
                type="radio"
                value={option}
              />{' '}
              {PROVIDER_LABELS[option]}
            </label>
          ))}
        </fieldset>
        {settings.keys[keyName].set ? null : (
          <p className="notice notice--warning">
            <span aria-hidden="true">🗝️</span> {PROVIDER_LABELS[provider]} has no API key yet, so
            reviews will fail.{' '}
            <button
              className="link-button"
              onClick={() => document.getElementById(keyInputId(keyName))?.focus()}
              type="button"
            >
              Add the {KEY_META[keyName].label} key
            </button>
          </p>
        )}
        {renderModel(provider, settings)}
      </>
    );
  };

  /** `announce` is set for the first section only, so screen readers hear the state once. */
  const renderSettingsState = (announce: boolean) => {
    if (load.state === 'loading') {
      return (
        <p aria-busy="true" className="muted" role={announce ? 'status' : undefined}>
          Loading settings…
        </p>
      );
    }
    if (load.state === 'unavailable') {
      return <p className="muted">This server doesn&apos;t support settings yet.</p>;
    }
    if (load.state === 'error') {
      return (
        <p className="form-error" role={announce ? 'alert' : undefined}>
          Settings are unavailable: {load.error}
        </p>
      );
    }
    return null;
  };

  return (
    <Modal className="modal--wide" isBusy={isBusy} onClickClose={onClickClose} title="Settings">
      <p className="settings__status" role="status">
        {saveStatus}
      </p>
      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <section aria-labelledby={`${baseId}-github`} className="settings__section">
        <SectionHeading id={`${baseId}-github`} section="github" target={target} />
        {renderGitHub()}
      </section>

      <section aria-labelledby={`${baseId}-provider`} className="settings__section">
        <SectionHeading id={`${baseId}-provider`} section="provider" target={target} />
        {renderSettingsState(true) ?? renderProvider()}
      </section>

      <section aria-labelledby={`${baseId}-keys`} className="settings__section">
        <SectionHeading id={`${baseId}-keys`} section="keys" target={target} />
        <p className="muted settings__note">
          Keys are stored on this computer and shared by every GitHub account that signs in here.
        </p>
        {renderSettingsState(false) ??
          (settings ? (
            <ul className="key-list">
              {API_KEY_NAMES.map((name) => (
                <ApiKeyRow
                  inputId={keyInputId(name)}
                  isDisabled={isBusy}
                  isHighlighted={target.key === name && !settings.keys[name].set}
                  key={name}
                  name={name}
                  onRemove={removeKey}
                  onSave={saveKey}
                  status={settings.keys[name]}
                />
              ))}
            </ul>
          ) : null)}
      </section>
    </Modal>
  );
};
