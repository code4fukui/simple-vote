import { handler } from "./server.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}

Deno.test("unknown poll returns 404", async () => {
  const response = await handler(new Request("http://localhost/api/polls/notfound"));
  assertEquals(response.status, 404);
});

Deno.test("rejects too few options", async () => {
  const response = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "Test", options: ["Only one"] }),
    }),
  );
  assertEquals(response.status, 400);
});

Deno.test("accepts up to 50 options and rejects 51", async () => {
  const options = Array.from({ length: 50 }, (_, index) => `Team ${index + 1}`);
  const accepted = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "50 teams", options }),
    }),
  );
  assertEquals(accepted.status, 201);

  const rejected = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "51 teams", options: [...options, "Team 51"] }),
    }),
  );
  assertEquals(rejected.status, 400);
});

Deno.test("poll content update requires a valid admin token", async () => {
  const create = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "Before", options: ["A", "B"] }),
    }),
  );
  const created = await create.json();

  const forbidden = await handler(
    new Request(`http://localhost/api/polls/${created.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer wrong-token" },
      body: JSON.stringify({ title: "After", options: ["C", "D"] }),
    }),
  );
  assertEquals(forbidden.status, 403);

  const token = new URL(created.adminUrl, "http://localhost").searchParams.get("token");
  const updated = await handler(
    new Request(`http://localhost/api/polls/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "  After  ", options: ["  C  ", "D"] }),
    }),
  );
  assertEquals(updated.status, 200);
  const result = await updated.json();
  assertEquals(result.title, "After");
  assertEquals(result.options[0].label, "C");
});

Deno.test("reset clears votes and starts a new voting revision", async () => {
  const create = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "Reset test", options: ["A", "B"] }),
    }),
  );
  const created = await create.json();
  const token = new URL(created.adminUrl, "http://localhost").searchParams.get("token");
  const browserId = "test-browser-id-1234567890";
  const vote = () =>
    handler(
      new Request(`http://localhost/api/polls/${created.id}/vote`, {
        method: "POST",
        body: JSON.stringify({ optionId: "1", browserId, comment: "  すてきでした  " }),
      }),
    );

  assertEquals((await vote()).status, 201);
  const reset = await handler(
    new Request(`http://localhost/api/polls/${created.id}/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assertEquals(reset.status, 200);
  assertEquals((await vote()).status, 201);

  const results = await handler(
    new Request(`http://localhost/api/polls/${created.id}/results`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const result = await results.json();
  assertEquals(result.totalVotes, 1);
  assertEquals(result.revision, 1);
  assertEquals(result.logs.at(-1).optionLabel, "A");
  assertEquals(result.logs.at(-1).comment, "すてきでした");
});

Deno.test("a team comment can be sent without casting a vote", async () => {
  const create = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "Comment test", options: ["Team A", "Team B"] }),
    }),
  );
  const created = await create.json();
  const token = new URL(created.adminUrl, "http://localhost").searchParams.get("token");
  const comment = await handler(
    new Request(`http://localhost/api/polls/${created.id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        optionId: "1",
        browserId: "comment-browser-id-123456",
        comment: "  最高でした！  ",
      }),
    }),
  );
  assertEquals(comment.status, 201);
  const vote = await handler(
    new Request(`http://localhost/api/polls/${created.id}/vote`, {
      method: "POST",
      body: JSON.stringify({
        optionId: "1",
        browserId: "comment-browser-id-123456",
      }),
    }),
  );
  assertEquals(vote.status, 201);

  const results = await handler(
    new Request(`http://localhost/api/polls/${created.id}/results`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const result = await results.json();
  assertEquals(result.totalVotes, 1);
  assertEquals(result.comments[0].optionLabel, "Team A");
  assertEquals(result.comments[0].comment, "最高でした！");
  assertEquals(result.comments[0].userId.length, 8);
  assertEquals(result.comments[0].userId, result.logs[0].userId);
});

Deno.test("public results expose totals and comments without an admin token", async () => {
  const create = await handler(
    new Request("http://localhost/api/polls", {
      method: "POST",
      body: JSON.stringify({ title: "Public results", options: ["A", "B"] }),
    }),
  );
  const created = await create.json();
  assertEquals(created.resultUrl, `/result/${created.id}`);

  await handler(
    new Request(`http://localhost/api/polls/${created.id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        optionId: "2",
        browserId: "public-browser-id-123456",
        comment: "Good!",
      }),
    }),
  );
  const response = await handler(
    new Request(`http://localhost/api/polls/${created.id}/public-results`),
  );
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.totalVotes, 0);
  assertEquals(result.comments[0].optionLabel, "B");
  assertEquals("adminToken" in result, false);
  assertEquals("logs" in result, false);
});
