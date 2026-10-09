import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { createHmac } from "node:crypto";
import { textMessages, verifySignature } from "./line.ts";

Deno.test("verifySignature", async () => {
  const secret = "test-secret";
  const body = JSON.stringify({ events: [{ type: "message", message: { text: "こんにちは" } }] });
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert(await verifySignature(body, signature, secret));
  assert(!(await verifySignature(body + " ", signature, secret)));
  assert(!(await verifySignature(body, null, secret)));
  assert(!(await verifySignature(body, signature, "other")));
});

Deno.test("textMessages は5000字ごとに行単位で分割する", () => {
  const line = "あ".repeat(3000);
  const messages = textMessages(`${line}\n${line}\n${line}`);
  assertEquals(messages.length, 3);
  assert(messages.every((m) => m.text.length <= 5000));
});

Deno.test("textMessages は最大件数で打ち切る", () => {
  const text = Array.from({ length: 10 }, () => "い".repeat(4000)).join("\n");
  const messages = textMessages(text, 2);
  assertEquals(messages.length, 2);
  assert(messages[1].text.endsWith("(以下省略)"));
  assert(messages[1].text.length <= 5000);
});
