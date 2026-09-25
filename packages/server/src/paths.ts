/** True for the API and anything under it, in any letter case. */
export function isApiPath(url: string) {
  const [pathname = ""] = url.split("?");
  const path = pathname.toLowerCase();
  return path === "/api" || path.startsWith("/api/");
}
