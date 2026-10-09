// 案件チャット（制作側・クライアント側）のイベント処理。案件チャットには原則発言しない。
import { type DB, must } from "../_shared/db.ts";
import { HELP_TEXT } from "../_shared/commands.ts";
import { optEnv } from "../_shared/env.ts";
import { getGroupMemberName, getGroupName, type LineEvent, reply } from "../_shared/line.ts";

const MEMBER_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

interface ChatRow {
  id: number;
  project_id: number | null;
}

async function registerChat(sb: DB, groupId: string): Promise<ChatRow> {
  const name = await getGroupName(groupId);
  return must(await sb.rpc("register_chat", { p_group_id: groupId, p_name: name }).single()) as ChatRow;
}

async function findOrRegisterChat(sb: DB, groupId: string): Promise<ChatRow> {
  const chat = must(
    await sb.from("chats").select("id, project_id, active").eq("line_group_id", groupId).maybeSingle(),
  ) as (ChatRow & { active: boolean }) | null;
  // ボット導入前から参加していた等で join イベントを受けていないグループは、ここで登録する
  if (!chat || !chat.active) {
    const registered = await registerChat(sb, groupId);
    if (!chat) await recordChatEvent(sb, registered, "chat_joined");
    return registered;
  }
  return chat;
}

async function recordChatEvent(sb: DB, chat: ChatRow, kind: string) {
  must(await sb.from("events").insert({ project_id: chat.project_id, chat_id: chat.id, kind, actor: "system" }));
}

async function ensureMember(sb: DB, groupId: string, chatId: number, userId: string) {
  const member = must(
    await sb.from("members").select("updated_at").eq("line_user_id", userId).maybeSingle(),
  ) as { updated_at: string } | null;
  if (!member || Date.now() - new Date(member.updated_at).getTime() > MEMBER_REFRESH_MS) {
    const name = await getGroupMemberName(groupId, userId);
    if (name || !member) {
      must(
        await sb.from("members").upsert({
          line_user_id: userId,
          display_name: name ?? "不明なユーザー",
          updated_at: new Date().toISOString(),
        }),
      );
    }
  }
  must(
    await sb.from("chat_members").upsert(
      { chat_id: chatId, line_user_id: userId },
      { ignoreDuplicates: true },
    ),
  );
}

async function handleRegisterMain(sb: DB, event: LineEvent, groupId: string, code: string) {
  const expected = Deno.env.get("MAIN_REGISTER_CODE");
  if (!expected || code !== expected) {
    console.warn("main registration rejected", groupId);
    return;
  }
  must(await sb.rpc("set_main_group", { p_group_id: groupId }));
  if (event.replyToken) {
    await reply(event.replyToken, [
      {
        type: "text",
        text: "✅ このグループをメインチャットに登録しました。\n案件チャットのタスクを1時間ごとにここへ通知します。",
      },
      { type: "text", text: HELP_TEXT },
    ]);
  }
}

export async function handleProjectEvent(sb: DB, event: LineEvent, groupId: string) {
  switch (event.type) {
    case "join": {
      const chat = await registerChat(sb, groupId);
      await recordChatEvent(sb, chat, "chat_joined");
      // 参加時の告知（任意）。JOIN_MESSAGE を設定した場合のみ返信する（返信は無料）
      const joinMessage = optEnv("JOIN_MESSAGE", "");
      if (joinMessage && event.replyToken) {
        await reply(event.replyToken, [{ type: "text", text: joinMessage }]);
      }
      return;
    }

    case "leave": {
      const chat = must(
        await sb.from("chats").update({ active: false }).eq("line_group_id", groupId).select("id, project_id")
          .maybeSingle(),
      ) as ChatRow | null;
      if (chat) await recordChatEvent(sb, chat, "chat_left");
      return;
    }

    case "unsend": {
      // 送信取り消しされたメッセージは、未解析なら解析対象から外す
      if (event.unsend) {
        must(
          await sb.from("messages").delete().eq("line_message_id", event.unsend.messageId).is("processed_at", null),
        );
      }
      return;
    }

    case "message": {
      const message = event.message;
      if (!message || message.type !== "text" || !message.text) return;

      const register = message.text.normalize("NFKC").trim().match(/^#メイン登録\s+(\S+)$/);
      if (register) {
        await handleRegisterMain(sb, event, groupId, register[1]);
        return;
      }

      const chat = await findOrRegisterChat(sb, groupId);
      const userId = event.source.userId;
      if (userId) await ensureMember(sb, groupId, chat.id, userId);

      const sentAt = new Date(event.timestamp).toISOString();
      must(
        await sb.from("messages").upsert(
          {
            chat_id: chat.id,
            line_message_id: message.id,
            sender_id: userId ?? null,
            text: message.text,
            sent_at: sentAt,
          },
          { onConflict: "line_message_id", ignoreDuplicates: true },
        ),
      );
      must(await sb.from("chats").update({ last_message_at: sentAt }).eq("id", chat.id));
      return;
    }
  }
}
