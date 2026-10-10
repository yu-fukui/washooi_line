// 案件チャット（制作側・クライアント側）のイベント処理。案件チャットには原則発言しない。
import { type DB, must } from "../_shared/db.ts";
import { HELP_TEXT } from "../_shared/commands.ts";
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

/** 「#メイン登録 合言葉」なら合言葉を返す */
export function matchMainRegister(text: string): string | null {
  return text.normalize("NFKC").trim().match(/^#メイン登録\s+(\S+)$/)?.[1] ?? null;
}

/** メインチャットの登録。groupId にはグループIDか、1対1トークならユーザーIDが入る */
export async function handleRegisterMain(sb: DB, event: LineEvent, groupId: string, code: string) {
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
        text:
          "✅ このトークをメインチャットに登録しました。\n案件チャットのタスクを1日2回（9時・18時）ここへ通知します。",
      },
      { type: "text", text: HELP_TEXT },
    ]);
  }
}

export async function handleProjectEvent(sb: DB, event: LineEvent, groupId: string) {
  switch (event.type) {
    case "join": {
      const chat = await registerChat(sb, groupId);
      // 案件チャットには告知しない（参加の連絡はメインチャットへの通知で行う）
      await recordChatEvent(sb, chat, "chat_joined");
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

      const code = matchMainRegister(message.text);
      if (code) {
        await handleRegisterMain(sb, event, groupId, code);
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
