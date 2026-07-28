const ROOT = new URL(".", import.meta.url);
const PUBLIC = new URL("./public/", ROOT);
const DATA = new URL("./data/polls/", ROOT);
const LOGS = new URL("./data/votes.ndjson", ROOT);
const COMMENTS = new URL("./data/comments.ndjson", ROOT);

export type Poll = {
  id: string;
  title: string;
  options: { id: string; label: string; votes: number }[];
  adminToken: string;
  createdAt: string;
  revision?: number;
};

const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const safeId = (value: string) => /^[a-zA-Z0-9_-]{6,64}$/.test(value);
const pollFile = (id: string) => new URL(`./${id}.json`, DATA);

async function readPoll(id: string): Promise<Poll | null> {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(await Deno.readTextFile(pollFile(id)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function writePoll(poll: Poll) {
  await Deno.mkdir(DATA, { recursive: true });
  const target = pollFile(poll.id);
  const temporary = new URL(`./${poll.id}.${crypto.randomUUID()}.tmp`, DATA);
  await Deno.writeTextFile(temporary, JSON.stringify(poll, null, 2));
  await Deno.rename(temporary, target);
}

function randomToken(bytes = 16) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return encodeBase64Url(data);
}

function encodeBase64Url(data: Uint8Array) {
  let value = "";
  for (const byte of data) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookie(request: Request, name: string) {
  const match = request.headers.get("cookie")?.match(
    new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

async function voterHash(poll: Poll, browserId: string) {
  const revision = poll.revision ?? 0;
  return await hash(
    revision === 0 ? `${poll.id}:${browserId}` : `${poll.id}:${revision}:${browserId}`,
  );
}

async function hasVoted(pollId: string, voterId: string) {
  try {
    const content = await Deno.readTextFile(LOGS);
    return content.split("\n").some((line) => {
      if (!line) return false;
      try {
        const event = JSON.parse(line);
        return event.pollId === pollId && event.voterHash === voterId;
      } catch {
        return false;
      }
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function appendVoteLog(event: Record<string, unknown>) {
  await Deno.mkdir(new URL("./data/", ROOT), { recursive: true });
  await Deno.writeTextFile(LOGS, `${JSON.stringify(event)}\n`, { append: true, create: true });
}

async function appendCommentLog(event: Record<string, unknown>) {
  await Deno.mkdir(new URL("./data/", ROOT), { recursive: true });
  await Deno.writeTextFile(COMMENTS, `${JSON.stringify(event)}\n`, {
    append: true,
    create: true,
  });
}

async function readCommentLogs(pollId: string) {
  try {
    const content = await Deno.readTextFile(COMMENTS);
    return content.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        const event = JSON.parse(line);
        return event.pollId === pollId ? [event] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function readVoteLogs(pollId: string) {
  try {
    const content = await Deno.readTextFile(LOGS);
    return content.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        const event = JSON.parse(line);
        return event.pollId === pollId ? [event] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

function publicPoll(poll: Poll) {
  return {
    id: poll.id,
    title: poll.title,
    options: poll.options.map(({ id, label }) => ({ id, label })),
    createdAt: poll.createdAt,
    revision: poll.revision ?? 0,
  };
}

async function api(request: Request, url: URL): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/polls") {
    let body: { title?: unknown; options?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON形式が正しくありません" }, 400);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const labels = Array.isArray(body.options)
      ? body.options.map((option) => typeof option === "string" ? option.trim() : "")
      : [];
    if (!title || title.length > 100) return json({ error: "タイトルは1〜100文字です" }, 400);
    if (
      labels.length < 2 || labels.length > 50 ||
      labels.some((label) => !label || label.length > 100)
    ) {
      return json({ error: "選択肢は2〜50個、各1〜100文字です" }, 400);
    }
    const poll: Poll = {
      id: randomToken(9),
      title,
      options: labels.map((label, index) => ({ id: String(index + 1), label, votes: 0 })),
      adminToken: randomToken(24),
      createdAt: new Date().toISOString(),
    };
    await writePoll(poll);
    return json({
      id: poll.id,
      voteUrl: `/vote/${poll.id}`,
      resultUrl: `/result/${poll.id}`,
      adminUrl: `/admin/${poll.id}?token=${poll.adminToken}`,
    }, 201);
  }

  const match = url.pathname.match(
    /^\/api\/polls\/([^/]+)(\/vote|\/comments|\/results|\/public-results|\/reset)?$/,
  );
  if (!match) return null;
  const [, id, action = ""] = match;
  const poll = await readPoll(id);
  if (!poll) return json({ error: "投票が見つかりません" }, 404);

  if (request.method === "GET" && action === "") return json(publicPoll(poll));

  if (request.method === "PATCH" && action === "") {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("token");
    if (token !== poll.adminToken) return json({ error: "管理トークンが正しくありません" }, 403);

    let body: { title?: unknown; options?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON形式が正しくありません" }, 400);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const labels = Array.isArray(body.options)
      ? body.options.map((option) => typeof option === "string" ? option.trim() : "")
      : [];
    if (!title || title.length > 100) return json({ error: "タイトルは1〜100文字です" }, 400);
    if (
      labels.length !== poll.options.length ||
      labels.some((label) => !label || label.length > 100)
    ) {
      return json({ error: "各選択肢は1〜100文字です" }, 400);
    }

    poll.title = title;
    poll.options.forEach((option, index) => option.label = labels[index]);
    await writePoll(poll);
    return json(publicPoll(poll));
  }

  if (request.method === "GET" && action === "/results") {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("token");
    if (token !== poll.adminToken) return json({ error: "管理トークンが正しくありません" }, 403);
    const logs = (await readVoteLogs(poll.id)).filter(
      (event) => (event.revision ?? 0) === (poll.revision ?? 0),
    );
    const comments = (await readCommentLogs(poll.id)).filter(
      (event) => (event.revision ?? 0) === (poll.revision ?? 0),
    );
    return json({
      ...publicPoll(poll),
      options: poll.options,
      totalVotes: poll.options.reduce((a, b) => a + b.votes, 0),
      logs: logs.map((event) => ({
        timestamp: event.timestamp,
        optionId: event.optionId,
        optionLabel: poll.options.find((option) => option.id === event.optionId)?.label ??
          "削除された選択肢",
        comment: typeof event.comment === "string" ? event.comment : "",
        userId: typeof event.voterHash === "string" ? event.voterHash.slice(0, 8) : "",
      })),
      comments: comments.map((event) => ({
        timestamp: event.timestamp,
        optionId: event.optionId,
        optionLabel: poll.options.find((option) => option.id === event.optionId)?.label ??
          "削除された選択肢",
        comment: typeof event.comment === "string" ? event.comment : "",
        userId: typeof event.voterHash === "string" ? event.voterHash.slice(0, 8) : "",
      })),
    });
  }

  if (request.method === "GET" && action === "/public-results") {
    const comments = (await readCommentLogs(poll.id)).filter(
      (event) => (event.revision ?? 0) === (poll.revision ?? 0),
    );
    return json({
      ...publicPoll(poll),
      options: poll.options,
      totalVotes: poll.options.reduce((a, b) => a + b.votes, 0),
      comments: comments.map((event) => ({
        timestamp: event.timestamp,
        optionId: event.optionId,
        optionLabel: poll.options.find((option) => option.id === event.optionId)?.label ??
          "削除された選択肢",
        comment: typeof event.comment === "string" ? event.comment : "",
        userId: typeof event.voterHash === "string" ? event.voterHash.slice(0, 8) : "",
      })),
    });
  }

  if (request.method === "POST" && action === "/comments") {
    let body: { optionId?: unknown; browserId?: unknown; comment?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON形式が正しくありません" }, 400);
    }
    const option = poll.options.find((item) => item.id === String(body.optionId ?? ""));
    if (!option) return json({ error: "チームが正しくありません" }, 400);
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (!comment || comment.length > 200) {
      return json({ error: "一言コメントは1〜200文字です" }, 400);
    }
    const suppliedBrowserId = typeof body.browserId === "string" && body.browserId.length >= 16
      ? body.browserId.slice(0, 100)
      : null;
    const browserId = cookie(request, "simple_vote_browser") ?? suppliedBrowserId;
    if (!browserId) return json({ error: "ブラウザIDが必要です" }, 400);
    await appendCommentLog({
      timestamp: new Date().toISOString(),
      pollId: poll.id,
      revision: poll.revision ?? 0,
      optionId: option.id,
      comment,
      voterHash: await voterHash(poll, browserId),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return json({ ok: true }, 201, {
      "set-cookie": `simple_vote_browser=${
        encodeURIComponent(browserId)
      }; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
    });
  }

  if (request.method === "POST" && action === "/reset") {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("token");
    if (token !== poll.adminToken) return json({ error: "管理トークンが正しくありません" }, 403);

    poll.options.forEach((option) => option.votes = 0);
    poll.revision = (poll.revision ?? 0) + 1;
    await writePoll(poll);
    return json({ ok: true, revision: poll.revision });
  }

  if (request.method === "POST" && action === "/vote") {
    let body: { optionId?: unknown; browserId?: unknown; comment?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON形式が正しくありません" }, 400);
    }
    const suppliedBrowserId = typeof body.browserId === "string" && body.browserId.length >= 16
      ? body.browserId.slice(0, 100)
      : null;
    // Prefer the server-issued HttpOnly cookie on later visits. This keeps the
    // browser identity even if localStorage is cleared.
    const browserId = cookie(request, "simple_vote_browser") ?? suppliedBrowserId;
    if (!browserId) return json({ error: "ブラウザIDが必要です" }, 400);
    const option = poll.options.find((item) => item.id === String(body.optionId ?? ""));
    if (!option) return json({ error: "選択肢が正しくありません" }, 400);
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (comment.length > 200) return json({ error: "一言コメントは200文字以内です" }, 400);
    const revision = poll.revision ?? 0;
    const hashedVoter = await voterHash(poll, browserId);
    if (await hasVoted(poll.id, hashedVoter)) {
      return json({ error: "このブラウザからは投票済みです" }, 409);
    }

    // The single Deno process serializes this short critical section in normal operation.
    option.votes++;
    await writePoll(poll);
    await appendVoteLog({
      timestamp: new Date().toISOString(),
      pollId: poll.id,
      revision,
      optionId: option.id,
      comment,
      voterHash: hashedVoter,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return json({ ok: true }, 201, {
      "set-cookie": `simple_vote_browser=${
        encodeURIComponent(browserId)
      }; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
    });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function staticFile(pathname: string) {
  const name = pathname.startsWith("/assets/") ? pathname.slice(1) : "index.html";
  if (name.includes("..")) return new Response("Not found", { status: 404 });
  try {
    const body = await Deno.readFile(new URL(name, PUBLIC));
    const type = name.endsWith(".css")
      ? "text/css"
      : name.endsWith(".js")
      ? "text/javascript"
      : "text/html";
    return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export async function handler(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return await api(request, url) ?? json({ error: "Not found" }, 404);
    }
    return await staticFile(url.pathname);
  } catch (error) {
    console.error(error);
    return json({ error: "サーバーエラーが発生しました" }, 500);
  }
}

export default { fetch: handler };
