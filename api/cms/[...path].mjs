/* POST/GET/PATCH/DELETE /api/cms/* — the admin API.
 *
 * The whole surface lives in api/_lib/router.mjs so the same code runs on Vercel
 * and in the local dev server. Nothing here reads configuration or touches the
 * database: that keeps the security rules in exactly one auditable place.
 *
 * Everything under /api/cms requires a valid session cookie, except
 * /api/cms/status, /login, /logout and the one-time /setup.
 */
import { handleCms } from "../_lib/router.mjs";

export default async function handler(req, res) {
  await handleCms(req, res);
}
