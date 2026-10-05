/* GET /api/media?path=<object-key> — bytes for one uploaded photo or document.
 *
 * The bucket stays private, so this route is the only door: it validates the key
 * shape, confirms some row actually references the object (draft files remain
 * session-only), and lets the CDN cache the result for a week.
 *
 * This file sits at api/media.mjs, not inside a media/ folder, on purpose: a
 * top-level function file is mapped by Vercel to exactly /api/media, which is the
 * URL api/_lib/media.mjs mints (the key travels in ?path= because a storage key is
 * three segments and a nested function would leave anything deeper unroutable).
 */
import { handleMedia } from "./_lib/router.mjs";

export default async function handler(req, res) {
  await handleMedia(req, res);
}
