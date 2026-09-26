/** True for the API and the MCP endpoint, and anything under them, in any letter case. */
export function isApiPath(url: string) {
  const [pathname = ""] = url.split("?");
  const path = pathname.toLowerCase();
  return ["/api", "/mcp"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}
