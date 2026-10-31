import { useId, useState, type FormEvent } from 'react';

import type { ApiKeyName, ApiKeyStatus } from '../shared/api.ts';
import { KEY_META } from './settingsModel.ts';

export interface ApiKeyRowProps {
  name: ApiKeyName;
  status: ApiKeyStatus;
  /** The id of the password input, so other parts of the popup can focus it. */
  inputId: string;
  /** Another request is in flight; the row's buttons wait for it. */
  isDisabled: boolean;
  /** Points at the row because a review needs this key. */
  isHighlighted?: boolean;
  onSave: (name: ApiKeyName, value: string) => Promise<void>;
  onRemove: (name: ApiKeyName) => Promise<void>;
}

function maskedKey(status: ApiKeyStatus): string {
  if (!status.set) {
    return 'Not set';
  }
  return status.last4 ? `••••${status.last4}` : '••••';
}

/**
 * One API key: its masked value and source, and setting, replacing or removing it. The input is
 * uncontrolled, so the key only lives in the DOM until it is sent, and is cleared after saving.
 */
export const ApiKeyRow = ({
  name,
  status,
  inputId,
  isDisabled,
  isHighlighted = false,
  onSave,
  onRemove,
}: ApiKeyRowProps) => {
  const meta = KEY_META[name];
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const [validation, setValidation] = useState<string | undefined>(undefined);
  const headingId = useId();
  const hintId = useId();
  const isEnv = status.source === 'env';

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('value');
    if (typeof value !== 'string' || value.trim() === '') {
      setValidation(`Enter the ${meta.label} key first.`);
      return;
    }
    setValidation(undefined);
    onSave(name, value.trim())
      .then(() => form.reset())
      .catch(() => undefined);
  };

  return (
    <li
      aria-labelledby={headingId}
      className={['key-row', isHighlighted ? 'key-row--highlight' : ''].filter(Boolean).join(' ')}
    >
      <div className="key-row__head">
        <h4 className="key-row__name" id={headingId}>
          {meta.label}
        </h4>
        <code className="key-row__value">
          <span className="visually-hidden">Current key: </span>
          {maskedKey(status)}
        </code>
        {status.source ? (
          <span className={['badge', `badge--key-${status.source}`].join(' ')}>
            <span className="visually-hidden">Source: </span>
            {status.source}
          </span>
        ) : null}
      </div>
      {isHighlighted ? (
        <p className="key-row__needed">
          <span aria-hidden="true">❗</span> Needed for {meta.purpose}.
        </p>
      ) : null}

      {isEnv ? (
        <p className="muted">
          Set by <code>{meta.envName}</code> in the environment or <code>.env.local</code>, so it
          is read-only here. Edit <code>.env.local</code> and restart PR Quest to change it.
        </p>
      ) : (
        <form className="key-row__form" onSubmit={handleSubmit}>
          <label className="field" htmlFor={inputId}>
            <span className="field__label">
              {status.set ? `Replace the ${meta.label} key` : `${meta.label} key`}
            </span>
            <input
              aria-describedby={validation ? hintId : undefined}
              autoComplete="off"
              className="field__input"
              id={inputId}
              name="value"
              spellCheck={false}
              type="password"
            />
          </label>
          <div className="button-row">
            <button
              aria-label={`${status.set ? 'Replace key' : 'Save key'} for ${meta.label}`}
              className="button button--primary"
              disabled={isDisabled}
              type="submit"
            >
              {status.set ? 'Replace key' : 'Save key'}
            </button>
            {status.set && !isConfirmingRemove ? (
              <button
                aria-label={`Remove the ${meta.label} key`}
                className="button button--danger"
                disabled={isDisabled}
                onClick={() => setIsConfirmingRemove(true)}
                type="button"
              >
                Remove
              </button>
            ) : null}
          </div>
          {validation ? (
            <p className="form-error" id={hintId} role="alert">
              {validation}
            </p>
          ) : null}
        </form>
      )}

      {isConfirmingRemove && !isEnv ? (
        <div className="key-row__confirm" role="group" aria-label={`Remove the ${meta.label} key?`}>
          <p>Remove the {meta.label} key? Features that need it stop working until you add one.</p>
          <div className="button-row">
            <button
              autoFocus
              className="button"
              disabled={isDisabled}
              onClick={() => setIsConfirmingRemove(false)}
              type="button"
            >
              Keep it
            </button>
            <button
              className="button button--danger"
              disabled={isDisabled}
              onClick={() => {
                onRemove(name)
                  .then(() => setIsConfirmingRemove(false))
                  .catch(() => undefined);
              }}
              type="button"
            >
              Remove the {meta.label} key
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
};
