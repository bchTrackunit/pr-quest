/**
 * How one saved JSON document is read and written, whether it lives in a file or a database row.
 * Every document carries a numeric `version`; a store refuses one above `version` with
 * `refuseNewerVersion` before decoding it, so an older build never overwrites a newer one's data.
 */
export interface DocumentCodec<TValue> {
  /** The version `encode` writes and the newest `decode` reads. */
  readonly version: number;
  /** The value before anything was saved. */
  readonly empty: () => TValue;
  /** The value `json` holds, upgraded from an older version; `undefined` when it is unreadable. */
  readonly decode: (json: unknown) => TValue | undefined;
  /** `value` as JSON, with `version` in it. */
  readonly encode: (value: TValue) => unknown;
}

/** The `version` a parsed document carries, if it has a numeric one. */
export function documentVersion(json: unknown): number | undefined {
  return typeof json === 'object' && json !== null && 'version' in json
    ? typeof json.version === 'number'
      ? json.version
      : undefined
    : undefined;
}
