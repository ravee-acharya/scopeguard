import { invoke } from '@forge/bridge';

/** Resolvers return either the data or `{ error }` for expected, user-facing failures. */
export type Maybe<T> = T | { error: string };

export const isError = <T>(v: Maybe<T>): v is { error: string } =>
  typeof v === 'object' && v !== null && 'error' in v;

/**
 * Typed wrapper over `invoke`. Without the optional metadata argument the
 * bridge resolves to the resolver's raw return value, so the cast is safe.
 */
export async function callResolver<T>(key: string, payload: Record<string, unknown> = {}): Promise<Maybe<T>> {
  return (await invoke<Maybe<T>>(key, payload)) as Maybe<T>;
}
