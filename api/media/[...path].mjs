/* GET /api/media/<object-key> — bytes for one uploaded photo or document.
 *
 * The bucket stays private, so this route is the only door: it validates the key
 * shape, confirms some row actually references the object (draft files remain
 * session-only), and lets the CDN cache the result for a week.
 */
import { handleMedia } from "../_lib/router.mjs";

export default async function handler(req, res) {
  await handleMedia(req, res);
}
