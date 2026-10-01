/* GET /api/public/* — published content for the website.
 *
 * Read-only, no authentication, and it only ever answers with rows whose status
 * is 'published'. Drafts are unreachable here by construction: the query in
 * api/_lib/content.mjs filters on status, not the browser.
 */
import { handlePublic } from "../_lib/router.mjs";

export default async function handler(req, res) {
  await handlePublic(req, res);
}
