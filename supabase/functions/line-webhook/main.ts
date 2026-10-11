// メインチャット（管理用グループ / 1対1）のコマンド・普通の文章での指示・ボタン操作。応答は返信（無料）。
import { type Command, HELP_TEXT, parseCommand } from "../_shared/commands.ts";
import { formatDue, parseDateInput, todayJst } from "../_shared/dates.ts";
import { type DB, must } from "../_shared/db.ts";
import { resolveAssignee } from "../_shared/extraction.ts";
import {
  formatChatList,
  formatProjectDetail,
  formatTaskList,
  nextDueByProject,
  projectOrder,
} from "../_shared/format.ts";
import { type InstructionOp, type InstructionTask, interpretWithClaude } from "../_shared/instruction.ts";
import { type LineEvent, type LineMessage, push, reply, textMessages } from "../_shared/line.ts";
import { loadChats, loadOpenTasks, loadTasksByIds } from "../_shared/queries.ts";
import { isSmallTalk } from "../_shared/smalltalk.ts";

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

/** 案件（クライアント）を選ぶクイックリプライ。期限が近いタスクがある案件から順に並べる */
async function projectPicker(sb: DB, page: number): Promise<LineMessage> {
  const projects = must(await sb.from("projects").select("id, name").order("name")) as { id: number; name: string }[];
  if (projects.length === 0) return { type: "text", text: "案件はまだありません。" };
  const open = await loadOpenTasks(sb);
  const count = new Map<string, number>();
  for (const t of open) count.set(t.projectName, (count.get(t.projectName) ?? 0) + 1);
  const nextDue = nextDueByProject(open);
  const order = projectOrder(open);
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  const sorted = projects.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ja"));
  const shortDue = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

  const start = page * PICKER_PAGE_SIZE;
  const items = sorted.slice(start, start + PICKER_PAGE_SIZE).map((p) => ({
    type: "action",
    action: {
      type: "postback",
      label: label(
        `${p.name}（${count.get(p.name) ?? 0}件${nextDue.has(p.name) ? `・${shortDue(nextDue.get(p.name)!)}` : ""}）`,
      ),
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
    text:
      "どの案件（クライアント）を表示しますか？\n期限が近い順に並んでいます。（ ）内は未完了タスク数・直近の期限です",
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

/** 期限 "none" → null、日付 → そのまま */
const dueValue = (due: string) => (due === "none" ? null : due);

/** AIが読み取った操作の内容・担当・期限を反映する。変更点の説明を返す */
async function applyEdits(sb: DB, task: InstructionTask & { projectId: number }, op: InstructionOp, actor: string) {
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  if (op.title && op.title !== task.title) {
    patch.title = op.title;
    changes.push(`内容→「${op.title}」`);
  }
  if (op.due && dueValue(op.due) !== task.due) {
    patch.due_date = dueValue(op.due);
    changes.push(`期限→${formatDue(dueValue(op.due))}`);
  }
  if (op.assignee) {
    const who = resolveAssignee(op.assignee, await projectMembers(sb, task.projectId));
    if (who.name && who.name !== task.assignee) {
      patch.assignee_id = who.id;
      patch.assignee_name = who.name;
      changes.push(`担当→${who.name}`);
    }
  }
  if (changes.length === 0) return [];
  must(await sb.from("tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", task.id));
  await logManual(sb, task.id, task.projectId, "edit", actor, patch);
  return changes;
}

async function loadInstructionTasks(sb: DB) {
  const since = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const columns = "id, project_id, title, status, assignee_name, due_date";
  type Row = {
    id: number;
    project_id: number;
    title: string;
    status: InstructionTask["status"];
    assignee_name: string | null;
    due_date: string | null;
  };
  const active = must(
    await sb.from("tasks").select(columns).in("status", ["open", "candidate"]).order("id").limit(500),
  ) as Row[];
  const recent = must(
    await sb.from("tasks").select(columns).in("status", ["done", "dismissed"]).gte("updated_at", since)
      .order("id").limit(100),
  ) as Row[];
  const projects = must(await sb.from("projects").select("id, name").order("name")) as { id: number; name: string }[];
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const tasks = [...active, ...recent].map((r) => ({
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    projectName: names.get(r.project_id) ?? `案件#${r.project_id}`,
    title: r.title,
    assignee: r.assignee_name,
    due: r.due_date,
  }));
  return { tasks, projects };
}

function findProject(projects: { id: number; name: string }[], name: string) {
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const target = norm(name);
  return projects.find((p) => norm(p.name) === target) ??
    projects.filter((p) => norm(p.name).includes(target) || target.includes(norm(p.name)))
      .sort((a, b) => b.name.length - a.name.length)[0];
}

/** 普通の文章の指示を AI で読み取って実行する。指示でなければ null */
async function handleInstruction(sb: DB, text: string, actor: string): Promise<LineMessage[] | null> {
  const { tasks, projects } = await loadInstructionTasks(sb);
  const result = await interpretWithClaude({
    today: todayJst(),
    projects: projects.map((p) => p.name),
    tasks,
    text,
  });
  if (!result.is_instruction) return null;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const lines: string[] = [];
  const toDelete: number[] = [];
  const statusAction: Partial<Record<InstructionOp["action"], string>> = {
    complete: "done",
    approve: "approve",
    reopen: "reopen",
  };

  for (const op of result.ops) {
    if (op.action === "create") {
      const project = op.project ? findProject(projects, op.project) : undefined;
      if (!project || !op.title) {
        lines.push(`「${op.title ?? ""}」を追加する案件が分かりませんでした（案件名を添えてください）`);
        continue;
      }
      const who = resolveAssignee(op.assignee, await projectMembers(sb, project.id));
      const created = must(
        await sb.from("tasks").insert({
          project_id: project.id,
          title: op.title,
          assignee_id: who.id,
          assignee_name: who.name,
          due_date: op.due ? dueValue(op.due) : null,
          status: "open",
          confidence: 1,
          evidence: "メインチャットで追加",
        }).select("id").single(),
      ) as { id: number };
      await logManual(sb, created.id, project.id, "create", actor, null);
      const due = op.due && dueValue(op.due) ? `（期限 ${formatDue(dueValue(op.due))}）` : "";
      lines.push(`#${created.id} ${project.name}「${op.title}」を追加しました${due}`);
      continue;
    }

    const task = op.task_id !== null ? byId.get(op.task_id) : undefined;
    if (!task) {
      lines.push(`#${op.task_id ?? "?"} が見つかりませんでした`);
      continue;
    }
    if (op.action === "delete") {
      toDelete.push(task.id);
      continue;
    }
    if (op.action === "approve" || op.action === "update") {
      if (task.status !== "open" && task.status !== "candidate") {
        lines.push(`#${task.id} はすでに完了・削除済みです（「戻す ${task.id}」で戻せます）`);
        continue;
      }
      const changes = await applyEdits(sb, task, op, actor);
      if (op.action === "update" || task.status === "open") {
        lines.push(changes.length ? `#${task.id} ${changes.join("、")}` : `#${task.id} は変更ありません`);
        continue;
      }
      const approved = await changeStatus(sb, "approve", [task.id], actor);
      lines.push(changes.length ? `${approved}（${changes.join("、")}）` : approved);
      continue;
    }
    lines.push(await changeStatus(sb, statusAction[op.action]!, [task.id], actor));
  }

  if (toDelete.length > 0) {
    const list = toDelete.map((id) => `#${id} ${byId.get(id)!.title}`).join("\n");
    lines.push(`次のタスクを削除しますか？\n${list}`);
  }
  if (result.note) lines.push(result.note);
  if (lines.length === 0) lines.push("変更はありませんでした");
  if (toDelete.length === 0 && result.ops.length > 0) {
    lines.push("\n※ 違っていたら「戻す 番号」「期限 番号 日付」などで直せます");
  }

  const messages = textMessages(lines.join("\n"), 4);
  if (toDelete.length > 0) {
    const ids = toDelete.join(",");
    messages[messages.length - 1].quickReply = {
      items: [
        {
          type: "action",
          action: { type: "postback", label: "削除する", data: `action=delete&tasks=${ids}`, displayText: "削除する" },
        },
        { type: "action", action: { type: "postback", label: "やめる", data: "action=cancel", displayText: "やめる" } },
      ],
    };
  }
  return messages;
}

/** 返信する。AI の処理に時間がかかり返信トークンが切れていたらプッシュで送る（通数を消費） */
async function replyOrPush(replyToken: string, to: string, messages: LineMessage[]) {
  try {
    await reply(replyToken, messages);
  } catch (e) {
    if (!String(e).includes("Invalid reply token")) throw e;
    console.warn("reply token expired; falling back to push");
    await push(to, messages, crypto.randomUUID());
  }
}

export async function handleMainEvent(
  sb: DB,
  event: LineEvent,
  mainChatId: string,
  opts: { instructions: boolean } = { instructions: true },
) {
  if (!event.replyToken) return;
  const actor = event.source.userId ?? "unknown";

  if (event.type === "message" && event.message?.type === "text" && event.message.text) {
    const cmd = parseCommand(event.message.text);
    if (!cmd) {
      // 指示を受け付けない場所、またはお礼・あいづちだけの発言には AI を呼ばない
      if (!opts.instructions || isSmallTalk(event.message.text)) return;
      // 決まった形のコマンドでなければ、AI で指示として読み取る（指示でなければ反応しない）
      let messages: LineMessage[] | null;
      try {
        messages = await handleInstruction(sb, event.message.text, actor);
      } catch (e) {
        console.error("instruction failed", e);
        messages = [{
          type: "text",
          text: "うまく読み取れませんでした。もう一度送るか「ヘルプ」のコマンドをお使いください。",
        }];
      }
      if (messages) await replyOrPush(event.replyToken, mainChatId, messages);
      return;
    }
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
    if (action === "delete") {
      const ids = (params.get("tasks") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const text = ids.length ? await changeStatus(sb, "delete", ids, actor) : "削除するタスクがありません";
      await reply(event.replyToken, [{ type: "text", text }]);
      return;
    }
    if (action === "cancel") {
      await reply(event.replyToken, [{ type: "text", text: "削除をやめました" }]);
      return;
    }
    if ((action === "approve" || action === "dismiss") && Number.isInteger(taskId)) {
      const text = await changeStatus(sb, action, [taskId], actor);
      await reply(event.replyToken, [{ type: "text", text }]);
    }
  }
}
