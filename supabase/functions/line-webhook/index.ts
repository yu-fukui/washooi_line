// LINE Webhook: 案件チャットの会話を保存し、メインチャットのコマンド・ボタン操作に応答する
import { db, getSetting } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { type LineEvent, reply, verifySignature } from "../_shared/line.ts";
import { handleMainEvent } from "./main.ts";
import { handleProjectEvent } from "./project.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  const valid = await verifySignature(body, req.headers.get("x-line-signature"), env("LINE_CHANNEL_SECRET"));
  if (!valid) return new Response("invalid signature", { status: 401 });

  const events: LineEvent[] = JSON.parse(body).events ?? [];
  if (events.length === 0) return new Response("ok"); // 検証リクエスト

  const sb = db();
  const mainGroupId = await getSetting(sb, "main_group_id");

  for (const event of events) {
    try {
      const groupId = event.source.type === "group" ? event.source.groupId : undefined;
      if (!groupId) {
        if (event.type === "message" && event.replyToken) {
          await reply(event.replyToken, [{
            type: "text",
            text: "このボットは案件グループに招待して使います。タスクは管理用グループに通知されます。",
          }]);
        }
        continue;
      }
      if (groupId === mainGroupId) {
        await handleMainEvent(sb, event, groupId);
      } else {
        await handleProjectEvent(sb, event, groupId);
      }
    } catch (e) {
      console.error("event handling failed", event.type, e);
    }
  }
  return new Response("ok");
});
