import type { Command } from "../cli/command.js";
import { access, account, hub, RemoteError } from "../remote/client.js";

/**
 * Sharing a hosted catalog. The invite carries network access only: the
 * decryption key is handed over out of band, so a leaked invite reaches
 * sealed bytes and nothing else.
 */

const USAGE = "envs team <ls|invite|join <code>|remove <member>>";

type Ctx = Parameters<NonNullable<Command["run"]>>[0];

const report = (ui: Ctx["ui"], error: unknown): number => {
  if (error instanceof RemoteError) {
    ui.error(error.message, error.detail);
    return 1;
  }
  throw error;
};

async function list({ ui, env }: Ctx): Promise<number> {
  const who = await account(await access(env));
  ui.heading(who.userId);
  if (!who.teamManagement) {
    ui.warn(
      "team sharing is not on this plan",
      "invites will be refused; see envs.build for the plan that carries it",
    );
  }
  if (who.members.length === 0) ui.info("shared with", "nobody yet");
  else ui.table(who.members.map((member) => [member, "member"]));
  if (who.teams.length > 0) {
    ui.table(who.teams.map((owner) => [owner, "you are a member"]));
  }
  return 0;
}

async function invite({ ui, env }: Ctx): Promise<number> {
  const response = await hub(await access(env), {
    method: "POST",
    path: "/v1/invites",
  });
  const body = (await response.json()) as {
    invite?: unknown;
    expiresAt?: unknown;
  };
  if (typeof body.invite !== "string") {
    ui.error("the remote answered without an invite");
    return 1;
  }
  // The code is the answer, so it goes to stdout and can be piped. Everything
  // a person reads about it stays on stderr.
  ui.data(`${body.invite}\n`);
  ui.success("invite created", "one use only, and it is not stored anywhere");
  if (typeof body.expiresAt === "string") ui.info("expires", body.expiresAt);
  ui.info(
    "they also need the key",
    "send ENVS_KEK or a recovery code separately; the invite alone opens nothing",
  );
  return 0;
}

async function join(ctx: Ctx, code: string): Promise<number> {
  const { ui, env } = ctx;
  const response = await hub(await access(env), {
    method: "POST",
    path: "/v1/invites/accept",
    body: new TextEncoder().encode(JSON.stringify({ invite: code })),
    headers: { "content-type": "application/json" },
  });
  const body = (await response.json()) as { owner?: unknown };
  ui.success(
    "joined",
    typeof body.owner === "string" ? `shared by ${body.owner}` : undefined,
  );
  ui.info(
    "next",
    "ask the owner for the key, then envs restore --provider envs",
  );
  return 0;
}

async function remove(ctx: Ctx, member: string): Promise<number> {
  const { ui, env } = ctx;
  await hub(await access(env), {
    method: "DELETE",
    path: `/v1/members/${encodeURIComponent(member)}`,
  });
  ui.success("removed", member);
  // Said plainly because it is the part the service cannot do: their copy of
  // the key still works on any bytes they already hold.
  ui.warn(
    "rotate the key if they had it",
    "envs rotate --key, then back up again",
  );
  return 0;
}

export const teamCommand: Command = {
  name: "team",
  describe: "share a hosted catalog, and see who has it",
  usage: USAGE,
  group: "hosted account",

  async run(ctx) {
    const [verb, argument] = ctx.args.positional;
    try {
      switch (verb) {
        case undefined:
        case "ls":
          return await list(ctx);
        case "invite":
          return await invite(ctx);
        case "join":
          if (argument === undefined) {
            ctx.ui.error("say which code", "envs team join <code>");
            return 2;
          }
          return await join(ctx, argument);
        case "remove":
          if (argument === undefined) {
            ctx.ui.error("say which member", "envs team remove <member>");
            return 2;
          }
          return await remove(ctx, argument);
        default:
          ctx.ui.error(`unknown "${verb}"`, USAGE);
          return 2;
      }
    } catch (error) {
      return report(ctx.ui, error);
    }
  },
};
