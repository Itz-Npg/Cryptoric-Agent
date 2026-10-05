/**
 * Limits shared by the main process and the renderer.
 *
 * This file deliberately imports nothing. `ipc-schemas.ts` pulls in zod, and the
 * renderer must not import it — a composer that wants to show a character count
 * should not cost the user the whole validation library in their bundle. So the
 * numbers live here and the schema imports *them*, which also means the limit the
 * user is shown and the limit that is enforced are the same value by
 * construction rather than by two people remembering to keep them in step.
 */

/**
 * Hard ceiling on one prompt, in characters.
 *
 * This used to be 20,000, which is roughly one screenful. The practical effect
 * was that pasting a real file or a long stack trace failed at the IPC boundary
 * with `String must contain at most 20000 character(s)` — an error the composer
 * had no way to anticipate and no way to show coming. 200,000 is about 50k
 * tokens, comfortably inside every model in the catalogue, and far past anything
 * a person actually pastes.
 */
export const MAX_PROMPT_CHARS = 200_000