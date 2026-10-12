/**
 * meta keys a strip POST may carry, and their shape. Kept separate from wire.ts so the contract stays
 * engine-neutral: Breakout says what a score is, the wire only says which key names are allowed.
 * (Not a validator - `validateStripPost` already sanitises values. This is a whitelist + a text field.)
 */
export type StatusMeta = { [key: string]: string | number };

/** Echoed straight into the phone page, so the key set is explicit rather than "whatever the game sent". */
export const STATUS_META_KEYS = ['text', 'score', 'lives', 'level', 'bricks', 'status'] as const;

/** Nothing to add per-strip; present so `status.ts` has one place to state its meta contract. */
export const STATUS_META_LIMITS: StatusMeta = {};

export const isKnownMetaKey = (key: string): boolean => (STATUS_META_KEYS as readonly string[]).includes(key);
