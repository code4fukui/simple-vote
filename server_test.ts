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
        body: JSON.stringify({ optionId: "1", browserId }),
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
});
