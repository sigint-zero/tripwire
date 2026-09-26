import { AccountError, McpTokens, Users } from "@tripwire/server";

// `tripwire user …`: works on users.json directly, so it works with the
// server stopped, and is how a forgotten password is recovered: whoever
// can run commands on this machine already owns the installation.

/** Reads a password with echo off, or from TRIPWIRE_PASSWORD for scripts. */
export async function askPassword(prompt: string): Promise<string> {
  const scripted = process.env.TRIPWIRE_PASSWORD;
  if (scripted !== undefined) return scripted;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "No terminal to read a password from; set TRIPWIRE_PASSWORD.",
    );
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function newPassword(): Promise<string> {
  const password = await askPassword("Password (12 characters or more): ");
  if (process.env.TRIPWIRE_PASSWORD === undefined) {
    if ((await askPassword("Again: ")) !== password) {
      throw new AccountError("invalid_password", "The passwords do not match.");
    }
  }
  return password;
}

export async function userCommand(
  home: string,
  args: string[],
  fail: (message: string) => never,
) {
  const users = new Users(home);
  const [verb, name, ...extra] = args;
  if (extra.length > 0) fail(`Unexpected: ${extra.join(" ")}`);
  const named = async () => {
    if (!name) fail(`tripwire user ${verb} needs a username.`);
    const user = await users.find(name);
    if (!user) fail(`No account is "${name}".`);
    return user;
  };
  try {
    switch (verb) {
      case "add": {
        if (!name) fail("tripwire user add needs a username.");
        const user = await users.add(name, await newPassword());
        console.log(`Added "${user.username}".`);
        return;
      }
      case "passwd": {
        const user = await named();
        await users.setPassword(user.id, await newPassword());
        console.log(
          `Set a new password for "${user.username}"; its sessions have ended.`,
        );
        return;
      }
      case "remove": {
        const user = await named();
        await users.remove(user.id);
        await new McpTokens(home).revokeUser(user.id);
        console.log(
          `Removed "${user.username}", its sessions and its MCP tokens.`,
        );
        return;
      }
      case "list": {
        const all = await users.all();
        if (all.length === 0) console.log("No accounts yet.");
        for (const u of all) {
          console.log(
            `${u.username}  created ${u.createdAt}${u.failedLogins > 0 ? `  ${u.failedLogins} failed logins` : ""}`,
          );
        }
        return;
      }
      case "unlock": {
        const user = await named();
        await users.clearFailures(user.id);
        console.log(`Cleared the failed logins of "${user.username}".`);
        return;
      }
      default:
        fail(`Unknown command: user ${args.join(" ")}`);
    }
  } catch (error) {
    if (error instanceof AccountError) fail(error.message);
    throw error;
  }
}
