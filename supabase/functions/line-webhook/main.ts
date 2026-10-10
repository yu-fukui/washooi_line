// メインチャット（管理用グループ）のコマンドとボタン操作。応答はすべて返信（無料）。
import { type Command, HELP_TEXT, parseCommand } from "../_shared/commands.ts";
import { formatDue, parseDateInput, todayJst } from "../_shared/dates.ts";
import { type DB, must } from "../_shared/db.ts";
import { resolveAssignee } from "../_shared/extraction.ts";
import { formatChatList, formatProjectDetail, formatTaskList } from "../_shared/format.ts";
import { type LineEvent, type LineMessage, reply, textMessages } from "../_shared/line.ts";
import { loadChats, loadOpenTasks, loadTasksByIds } from "../_shared/queries.ts";

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

const PICKER_PAGE_SIZE = 12; // クイックリプライは最大13個（12件＋「次へ」）
const RECENT_DONE_DAYS = 14;

const label = (text: string) => (text.length > 20 ? text.slice(0, 19) + "…" : text);

/** 案件（クライアント）を選ぶクイックリプライ。未完了タスクが多い順 */
async function projectPicker(sb: DB, page: number): Promise<LineMessage> {
  const projects = must(await sb.from("projects").select("id, name").order("name")) as { id: number; name: string }[];
  if (projects.length === 0) return { type: "text", text: "案件はまだありません。" };
  const open = await loadOpenTasks(sb);
  const count = new Map<string, number>();
  for (const t of open) count.set(t.projectName, (count.get(t.projectName) ?? 0) + 1);
  const sorted = projects.sort((a, b) => (count.get(b.name) ?? 0) - (count.get(a.name) ?? 0));

  const start = page * PICKER_PAGE_SIZE;
  const items = sorted.slice(start, start + PICKER_PAGE_SIZE).map((p) => ({
    type: "action",
    action: {
      type: "postback",
      label: label(`${p.name}（${count.get(p.name) ?? 0}）`),
      data: `action=project&id=${p.id}`,
      displayText: p.name,
    },
  }));
  if (start + PICKER_PAGE_SIZE < sorted.length) {
    items.push({
      type: "action",
      action: { type: "postback", label: "次へ ▶", data: `action=projects&page=${page + 1}`, displayText: "次へ" },
    });
  }
  return {
    type: "text",
    text: "どの案件（クライアント）を表示しますか？\n下のボタンから選んでください。（ ）内は未完了タスク数です",
    quickReply: { items },
  };
}

async function projectDetail(sb: DB, projectId: number): Promise<LineMessage[]> {
  const project = must(await sb.from("projects").select("id, name").eq("id", projectId).maybeSingle()) as
    | { id: number; name: string }
    | null;
  if (!project) return [{ type: "text", text: "案件が見つかりませんでした。" }];

  const chats = (await loadChats(sb, { activeOnly: true })).filter((c) => c.projectId === projectId);
  const openIds = must(
    await sb.from("tasks").select("id").eq("project_id", projectId).in("status", ["open", "candidate"]),
  ) as { id: number }[];
  const openTasks = await loadTasksByIds(sb, openIds.map((t) => t.id));
  const since = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recentDone = must(
    await sb.from("tasks").select("id, title, completed_at").eq("project_id", projectId).eq("status", "done")
      .gte("completed_at", since).order("completed_at", { ascending: false }).limit(5),
  ) as { id: number; title: string; completed_at: string | null }[];

  const messages = textMessages(formatProjectDetail(project.name, chats, openTasks, recentDone, todayJst()), 4);
  messages[messages.length - 1].quickReply = {
    items: [
      {
        type: "action",
        action: { type: "postback", label: "他の案件", data: "action=projects&page=0", displayText: "案件を選ぶ" },
      },
      { type: "action", action: { type: "message", label: "全タスク一覧", text: "一覧" } },
    ],
  };
  return messages;
}

async function runCommand(sb: DB, cmd: Command, actor: string): Promise<string> {
  switch (cmd.type) {
    case "help":
      return HELP_TEXT;

    case "pickProject": // handleMainEvent でクイックリプライとして返すため、ここには来ない
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
    if (cmd.type === "pickProject") {
      await reply(event.replyToken, [await projectPicker(sb, 0)]);
      return;
    }
    await reply(event.replyToken, textMessages(await runCommand(sb, cmd, actor)));
    return;
  }

  if (event.type === "postback" && event.postback) {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get("action");
    const taskId = Number(params.get("task"));
    if (action === "projects") {
      await reply(event.replyToken, [await projectPicker(sb, Number(params.get("page")) || 0)]);
      return;
    }
    if (action === "project") {
      await reply(event.replyToken, await projectDetail(sb, Number(params.get("id"))));
      return;
    }
    if (action === "help") {
      await reply(event.replyToken, [{ type: "text", text: HELP_TEXT }]);
      return;
    }
    if ((action === "approve" || action === "dismiss") && Number.isInteger(taskId)) {
      const text = await changeStatus(sb, action, [taskId], actor);
      await reply(event.replyToken, [{ type: "text", text }]);
    }
  }
}
