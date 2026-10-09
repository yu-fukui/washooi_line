// メインチャット（管理用グループ）のコマンドとボタン操作。応答はすべて返信（無料）。
import { type Command, HELP_TEXT, parseCommand } from "../_shared/commands.ts";
import { formatDue, parseDateInput, todayJst } from "../_shared/dates.ts";
import { type DB, must } from "../_shared/db.ts";
import { resolveAssignee } from "../_shared/extraction.ts";
import { formatChatList, formatTaskList } from "../_shared/format.ts";
import { type LineEvent, reply, textMessages } from "../_shared/line.ts";
import { loadChats, loadOpenTasks } from "../_shared/queries.ts";

type Status = "candidate" | "open" | "done" | "dismissed";

const STATUS_CHANGE: Record<string, { to: Status; from: Status[]; label: string }> = {
  done: { to: "done", from: ["open", "candidate"], label: "完了にしました" },
  delete: { to: "dismissed", from: ["open", "candidate", "done"], label: "削除しました" },
  reopen: { to: "open", from: ["done", "dismissed"], label: "未完了に戻しました" },
  approve: { to: "open", from: ["candidate"], label: "登録しました" },
  dismiss: { to: "dismissed", from: ["candidate"], label: "無視しました" },
};

async function logManual(sb: DB, taskId: number, projectId: number, kind: string, actor: string, detail: unknown) {
  // 人による操作は記録のみ（通知済み扱い）
  must(
    await sb.from("events").insert({
      project_id: projectId,
      task_id: taskId,
      kind: `manual_${kind}`,
      actor,
      detail,
      notified_at: new Date().toISOString(),
    }),
  );
}

async function changeStatus(sb: DB, action: string, taskIds: number[], actor: string): Promise<string> {
  const rule = STATUS_CHANGE[action];
  const lines: string[] = [];
  for (const id of taskIds) {
    const updated = must(
      await sb.from("tasks")
        .update({
          status: rule.to,
          updated_at: new Date().toISOString(),
          completed_at: rule.to === "done" ? new Date().toISOString() : null,
        })
        .eq("id", id)
        .in("status", rule.from)
        .select("id, project_id, title")
        .maybeSingle(),
    ) as { id: number; project_id: number; title: string } | null;
    if (updated) {
      await logManual(sb, id, updated.project_id, action, actor, null);
      lines.push(`#${id} ${updated.title} を${rule.label}`);
    } else {
      lines.push(`#${id} は見つからないか、すでに処理済みです`);
    }
  }
  return lines.join("\n");
}

async function projectMembers(sb: DB, projectId: number) {
  const chats = must(await sb.from("chats").select("id").eq("project_id", projectId)) as { id: number }[];
  if (chats.length === 0) return [];
  const links = must(
    await sb.from("chat_members").select("line_user_id").in("chat_id", chats.map((c) => c.id)),
  ) as { line_user_id: string }[];
  if (links.length === 0) return [];
  const members = must(
    await sb.from("members").select("line_user_id, display_name").in(
      "line_user_id",
      [...new Set(links.map((l) => l.line_user_id))],
    ),
  ) as { line_user_id: string; display_name: string }[];
  return members.map((m) => ({ id: m.line_user_id, name: m.display_name }));
}

async function findActiveTask(sb: DB, id: number) {
  return must(
    await sb.from("tasks").select("id, project_id, title").eq("id", id).in("status", ["open", "candidate"])
      .maybeSingle(),
  ) as { id: number; project_id: number; title: string } | null;
}

async function runCommand(sb: DB, cmd: Command, actor: string): Promise<string> {
  switch (cmd.type) {
    case "help":
      return HELP_TEXT;

    case "list": {
      let tasks = await loadOpenTasks(sb);
      if (cmd.keyword) tasks = tasks.filter((t) => t.projectName.includes(cmd.keyword!));
      return formatTaskList(tasks, todayJst(), cmd.keyword ? `📋 「${cmd.keyword}」の未完了タスク` : undefined);
    }

    case "chats":
      return formatChatList(await loadChats(sb, { activeOnly: true }));

    case "projects": {
      const projects = must(await sb.from("projects").select("id, name").order("id")) as { id: number; name: string }[];
      const chats = await loadChats(sb, { activeOnly: true });
      if (projects.length === 0) return "案件はまだありません。";
      const lines = projects.map((p) => {
        const list = chats.filter((c) => c.projectId === p.id)
          .map((c) => `#${c.id}${c.kind === "client" ? "(クライアント)" : "(制作)"}`);
        return `案件#${p.id} ${p.name}\n　チャット: ${list.join(" ") || "なし"}`;
      });
      return `🗂 案件一覧\n${lines.join("\n")}`;
    }

    case "status":
      return changeStatus(sb, cmd.action, cmd.taskIds, actor);

    case "due": {
      const due = parseDateInput(cmd.value, todayJst());
      if (due === undefined) return `期限「${cmd.value}」を解釈できませんでした。例: 期限 12 10/20`;
      const task = await findActiveTask(sb, cmd.taskId);
      if (!task) return `#${cmd.taskId} は見つからないか、完了済みです`;
      must(await sb.from("tasks").update({ due_date: due, updated_at: new Date().toISOString() }).eq("id", task.id));
      await logManual(sb, task.id, task.project_id, "due", actor, { due_date: due });
      return `#${task.id} ${task.title} の期限を ${formatDue(due)} にしました`;
    }

    case "assign": {
      const task = await findActiveTask(sb, cmd.taskId);
      if (!task) return `#${cmd.taskId} は見つからないか、完了済みです`;
      const who = resolveAssignee(cmd.name, await projectMembers(sb, task.project_id));
      must(
        await sb.from("tasks")
          .update({ assignee_id: who.id, assignee_name: who.name, updated_at: new Date().toISOString() })
          .eq("id", task.id),
      );
      await logManual(sb, task.id, task.project_id, "assign", actor, { assignee_name: who.name });
      return `#${task.id} ${task.title} の担当を ${who.name} にしました`;
    }

    case "link": {
      const [chat] = await loadChats(sb, { ids: [cmd.chatId] });
      if (!chat) return `チャット#${cmd.chatId} が見つかりません（「チャット一覧」で確認できます）`;
      must(await sb.rpc("link_chat", { p_chat_id: cmd.chatId, p_project_name: cmd.projectName }));
      return `チャット#${chat.id}「${chat.name ?? ""}」を案件「${cmd.projectName}」に紐付けました`;
    }

    case "kind": {
      const updated = must(
        await sb.from("chats").update({ kind: cmd.kind }).eq("id", cmd.chatId).select("id, name").maybeSingle(),
      ) as { id: number; name: string | null } | null;
      if (!updated) return `チャット#${cmd.chatId} が見つかりません`;
      return `チャット#${updated.id}「${updated.name ?? ""}」を${
        cmd.kind === "client" ? "クライアント" : "制作"
      }用チャットにしました`;
    }

    case "rename": {
      const { data, error } = await sb.from("projects").update({ name: cmd.name }).eq("id", cmd.projectId)
        .select("id").maybeSingle();
      if (error) {
        return error.code === "23505"
          ? `「${cmd.name}」という案件はすでにあります`
          : `変更できませんでした: ${error.message}`;
      }
      if (!data) return `案件#${cmd.projectId} が見つかりません（「案件一覧」で確認できます）`;
      return `案件#${cmd.projectId} の名前を「${cmd.name}」にしました`;
    }
  }
}

export async function handleMainEvent(sb: DB, event: LineEvent, _groupId: string) {
  if (!event.replyToken) return;
  const actor = event.source.userId ?? "unknown";

  if (event.type === "message" && event.message?.type === "text" && event.message.text) {
    const cmd = parseCommand(event.message.text);
    if (!cmd) return; // 普通の会話には反応しない
    await reply(event.replyToken, textMessages(await runCommand(sb, cmd, actor)));
    return;
  }

  if (event.type === "postback" && event.postback) {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get("action");
    const taskId = Number(params.get("task"));
    if ((action === "approve" || action === "dismiss") && Number.isInteger(taskId)) {
      const text = await changeStatus(sb, action, [taskId], actor);
      await reply(event.replyToken, [{ type: "text", text }]);
    }
  }
}
