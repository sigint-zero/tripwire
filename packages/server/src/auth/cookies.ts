// The session cookie, read and written by hand: a dozen lines need no
// library.

export const SESSION_COOKIE = "tripwire_session";

/** The value of one cookie in a Cookie header. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  for (const part of header?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return null;
}

/**
 * The session cookie: HttpOnly, SameSite=Lax so a link from an alert opens
 * logged in, no expiry of its own (the server decides validity), and Secure
 * when the request arrived over TLS. An empty token clears it.
 */
export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    ...(token ? [] : ["Max-Age=0"]),
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
