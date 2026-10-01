/* Shared helper module guard.
 *
 * Every file under /api can become a route on Vercel. Modules in /api/_lib are
 * building blocks, not routes, so each of them re-exports this handler as its
 * default export: if the platform ever maps such a path to a function, it answers
 * 405 (no source disclosure, no side effect) instead of failing the build for a
 * missing default export.
 */

export const moduleOnly = async (req, res) => {
  const { json } = await import("./http.mjs");
  json(res, 405, { error: "not_a_route", message: "This API module is not a public route." });
};

export default moduleOnly;
