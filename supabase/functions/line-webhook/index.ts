// LINE Webhook: 案件チャットの会話を保存し、メインチャットのコマンド・ボタン操作に応答する
import { parseCommand } from "../_shared/commands.ts";
import { type DB, db, getSetting } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { type LineEvent, reply, verifySignature } from "../_shared/line.ts";
import { handleMainEvent } from "./main.ts";
import { handleProjectEvent, handleRegisterMain, matchMainRegister } from "./project.ts";

// Supabase Edge Runtime: レスポンスを返した後もバックグラウンド処理を続けさせる
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** 通知先グループで、メインチャットの操作として扱うイベント（候補カードのボタン・決まった形のコマンド） */
function isMainOperation(event: LineEvent): boolean {
  if (event.type === "postback") return true;
  return event.type === "message" && !!event.message?.text && parseCommand(event.message.text) !== null;
}

async function handleEvents(sb: DB, events: LineEvent[]) {
  const mainGroupId = await getSetting(sb, "main_group_id");
  const notifyGroupId = await getSetting(sb, "notify_group_id");

  for (const event of events) {
    try {
      const groupId = event.source.type === "group" ? event.source.groupId : undefined;
      // メインチャットは管理用グループでも、ボットとの1対1トークでもよい
      const chatId = groupId ?? (event.source.type === "user" ? event.source.userId : undefined);
      if (!chatId) continue;

      if (chatId === mainGroupId) {
        await handleMainEvent(sb, event, chatId);
      } else if (chatId === notifyGroupId && isMainOperation(event)) {
        // 通知先グループ: ボタンと決まった形のコマンドはメインチャットと同じく処理する
        await handleMainEvent(sb, event, chatId, { instructions: false });
      } else if (groupId) {
        // 通知先グループのそれ以外の会話は、案件チャットとして記録・解析する
        await handleProjectEvent(sb, event, groupId);
      } else if (event.type === "message" && event.replyToken) {
        const code = event.message?.text ? matchMainRegister(event.message.text) : null;
        if (code) {
          await handleRegisterMain(sb, event, chatId, code);
        } else {
          await reply(event.replyToken, [{
            type: "text",
            text: "このボットは案件グループに招待して使います。タスクは管理用のメインチャットに通知されます。",
          }]);
        }
      }
    } catch (e) {
      console.error("event handling failed", event.type, e);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  const valid = await verifySignature(body, req.headers.get("x-line-signature"), env("LINE_CHANNEL_SECRET"));
  if (!valid) return new Response("invalid signature", { status: 401 });

  const events: LineEvent[] = JSON.parse(body).events ?? [];
  if (events.length === 0) return new Response("ok"); // 検証リクエスト

  // AI での指示の読み取りは数秒かかるため、LINE にはすぐ 200 を返して処理は後で続ける
  const work = handleEvents(db(), events);
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }
  return new Response("ok");
});
