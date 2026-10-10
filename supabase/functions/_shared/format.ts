// メインチャットに送るメッセージの組み立て（DBに依存しない純粋関数）
import { addDays, formatDue, todayJst } from "./dates.ts";
import { type ChatKind, KIND_LABEL } from "./extraction.ts";
import type { LineMessage } from "./line.ts";

export interface TaskView {
  id: number;
  title: string;
  status: "candidate" | "open" | "done" | "dismissed";
  assignee_name: string | null;
  due_date: string | null;
  evidence: string | null;
  projectName: string;
}

export interface ChatView {
  id: number;
  name: string | null;
  kind: ChatKind;
  projectName: string | null;
}

export interface EventView {
  kind: string;
  projectName: string | null;
  task: TaskView | null; // 現在のタスクの状態
  chat: ChatView | null;
  // deno-lint-ignore no-explicit-any
  detail: Record<string, any> | null;
}

const who = (t: { assignee_name: string | null }) => `👤${t.assignee_name ?? "未定"}`;

function taskLine(t: TaskView): string {
  return `#${t.id} ${t.title}\n　${who(t)} ⏰${formatDue(t.due_date)}`;
}

function chatName(c: ChatView): string {
  return c.name ?? `チャット#${c.id}`;
}

/** 毎時の通知テキスト。表示するものがなければ null */
export function formatNotification(events: EventView[], header: string): string | null {
  const byProject = new Map<string, string[]>();
  const chatLines: string[] = [];
  const announced = new Set<number>(); // created/candidate を表示したタスク

  const add = (project: string, line: string) => {
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push(line);
  };

  for (const e of events) {
    if (e.kind === "created" || e.kind === "candidate") {
      if (e.task) announced.add(e.task.id);
    }
  }

  for (const e of events) {
    const t = e.task;
    switch (e.kind) {
      case "created":
        if (!t || t.status === "dismissed" || t.status === "candidate") break;
        add(t.projectName, `🆕 ${taskLine(t)}${t.evidence ? `\n　💬${t.evidence}` : ""}`);
        break;
      case "candidate":
        if (!t || t.status !== "candidate") break;
        add(t.projectName, `❓ 候補 #${t.id} ${t.title}（下のカードで登録/無視）`);
        break;
      case "updated": {
        if (!t || t.status === "dismissed" || announced.has(t.id)) break;
        const changes: string[] = [];
        if (e.detail?.title) changes.push(`内容「${e.detail.title}」`);
        if (e.detail?.due_date) changes.push(`期限 ${formatDue(e.detail.due_date)}`);
        if (e.detail?.assignee_name) changes.push(`担当 ${e.detail.assignee_name}`);
        add(t.projectName, `✏️ #${t.id} ${t.title}\n　→ ${changes.join(" / ") || "更新"}`);
        break;
      }
      case "completed":
        if (!t) break;
        add(
          t.projectName,
          `✅ #${t.id} ${t.title}（${who(t)}）${e.detail?.evidence ? `\n　💬${e.detail.evidence}` : ""}`,
        );
        break;
      case "chat_joined":
        if (!e.chat) break;
        chatLines.push(
          `📥 チャット#${e.chat.id}「${chatName(e.chat)}」にボットが追加されました\n` +
            `　→ 案件「${e.chat.projectName ?? "未設定"}」として記録します\n` +
            `　別の案件にまとめる場合: 紐付け ${e.chat.id} 案件名\n` +
            `　クライアントとのチャットなら: 種別 ${e.chat.id} クライアント`,
        );
        break;
      case "chat_left":
        if (!e.chat) break;
        chatLines.push(`📤 チャット#${e.chat.id}「${chatName(e.chat)}」からボットが退出しました`);
        break;
    }
  }

  if (byProject.size === 0 && chatLines.length === 0) return null;
  const sections: string[] = [header];
  for (const [project, lines] of byProject) {
    sections.push(`【${project}】\n${lines.join("\n")}`);
  }
  if (chatLines.length) sections.push(chatLines.join("\n"));
  return sections.join("\n\n");
}

/** 候補タスクの確認カード（登録/無視ボタン付き）。最大10件 */
export function buildCandidateFlex(tasks: TaskView[]): LineMessage | null {
  const list = tasks.filter((t) => t.status === "candidate").slice(0, 10);
  if (list.length === 0) return null;
  const bubbles = list.map((t) => ({
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: `❓ タスク候補 #${t.id}`, size: "xs", color: "#888888" },
        { type: "text", text: t.projectName || "-", size: "xs", color: "#888888", wrap: true },
        { type: "text", text: t.title || "-", weight: "bold", wrap: true },
        { type: "text", text: `${who(t)} ⏰${formatDue(t.due_date)}`, size: "sm", wrap: true },
        ...(t.evidence ? [{ type: "text", text: `💬${t.evidence}`, size: "xs", color: "#666666", wrap: true }] : []),
      ],
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: {
            type: "postback",
            label: "登録",
            data: `action=approve&task=${t.id}`,
            displayText: `#${t.id} を登録`,
          },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "postback",
            label: "無視",
            data: `action=dismiss&task=${t.id}`,
            displayText: `#${t.id} を無視`,
          },
        },
      ],
    },
  }));
  return {
    type: "flex",
    altText: `タスク候補 ${list.length}件を確認してください`,
    contents: { type: "carousel", contents: bubbles },
  };
}

function sortByDue(a: TaskView, b: TaskView): number {
  if (a.due_date === b.due_date) return a.id - b.id;
  if (!a.due_date) return 1;
  if (!b.due_date) return -1;
  return a.due_date < b.due_date ? -1 : 1;
}

function dueMark(due: string | null, today: string): string {
  if (!due) return "";
  if (due < today) return " ⚠期限切れ";
  if (due === today) return " ⚠今日";
  if (due === addDays(today, 1)) return " ⚠明日";
  return "";
}

/**
 * 案件（クライアント）を、未完了タスクの期限が近い順に並べた案件名の配列を返す。
 * 期限のあるタスクがない案件は後ろ（未完了タスクが多い順、同数なら名前順）。
 */
export function projectOrder(tasks: TaskView[]): string[] {
  const stats = new Map<string, { nextDue: string | null; count: number }>();
  for (const t of tasks) {
    if (t.status !== "open" && t.status !== "candidate") continue;
    const s = stats.get(t.projectName) ?? { nextDue: null, count: 0 };
    s.count++;
    if (t.due_date && (!s.nextDue || t.due_date < s.nextDue)) s.nextDue = t.due_date;
    stats.set(t.projectName, s);
  }
  return [...stats].sort(([an, a], [bn, b]) => {
    if (a.nextDue !== b.nextDue) {
      if (!a.nextDue) return 1;
      if (!b.nextDue) return -1;
      return a.nextDue < b.nextDue ? -1 : 1;
    }
    return b.count - a.count || an.localeCompare(bn, "ja");
  }).map(([name]) => name);
}

/** 案件ごとの直近の期限（未完了タスクのうち最も早いもの） */
export function nextDueByProject(tasks: TaskView[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tasks) {
    if ((t.status !== "open" && t.status !== "candidate") || !t.due_date) continue;
    const cur = map.get(t.projectName);
    if (!cur || t.due_date < cur) map.set(t.projectName, t.due_date);
  }
  return map;
}

/** 「一覧」コマンドの返信 */
export function formatTaskList(tasks: TaskView[], today: string, title = "📋 未完了タスク"): string {
  const open = tasks.filter((t) => t.status === "open" || t.status === "candidate");
  if (open.length === 0) return `${title}\n未完了のタスクはありません 🎉`;
  const byProject = new Map<string, TaskView[]>();
  for (const t of open) {
    if (!byProject.has(t.projectName)) byProject.set(t.projectName, []);
    byProject.get(t.projectName)!.push(t);
  }
  const sections = [`${title}（${open.length}件）`];
  const order = projectOrder(open);
  for (const [project, list] of [...byProject].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))) {
    const lines = list.sort(sortByDue).map((t) => {
      const prefix = t.status === "candidate" ? "❓候補 " : "";
      return `${prefix}${taskLine(t)}${dueMark(t.due_date, today)}`;
    });
    sections.push(`【${project}】\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/** 朝のサマリー。未完了タスクがなければ null */
export function formatSummary(tasks: TaskView[], today: string): string | null {
  const open = tasks.filter((t) => t.status === "open").sort(sortByDue);
  if (open.length === 0) return null;
  const weekEnd = addDays(today, 7);
  const overdue = open.filter((t) => t.due_date && t.due_date < today);
  const dueToday = open.filter((t) => t.due_date === today);
  const thisWeek = open.filter((t) => t.due_date && t.due_date > today && t.due_date <= weekEnd);
  const later = open.filter((t) => t.due_date && t.due_date > weekEnd);
  const noDue = open.filter((t) => !t.due_date);
  const projects = new Set(open.map((t) => t.projectName)).size;

  const line = (t: TaskView) => `・[${t.projectName}] #${t.id} ${t.title} ${who(t)} ⏰${formatDue(t.due_date)}`;
  const sections = [
    `☀️ おはようございます。本日 ${formatDue(today)} のタスクです（${projects}案件・未完了${open.length}件）`,
  ];
  if (overdue.length) sections.push(`⚠ 期限切れ ${overdue.length}件\n${overdue.map(line).join("\n")}`);
  if (dueToday.length) sections.push(`⏰ 今日まで ${dueToday.length}件\n${dueToday.map(line).join("\n")}`);
  if (thisWeek.length) sections.push(`📅 7日以内 ${thisWeek.length}件\n${thisWeek.map(line).join("\n")}`);
  const rest: string[] = [];
  if (later.length) rest.push(`それ以降 ${later.length}件`);
  if (noDue.length) rest.push(`期限未定 ${noDue.length}件`);
  if (rest.length) {
    sections.push(`ほか ${rest.join(" / ")}（下の「タスク一覧」ボタンか、「一覧」と送ると確認できます）`);
  }
  return sections.join("\n\n");
}

export function formatChatList(chats: ChatView[]): string {
  if (chats.length === 0) return "ボットが入っている案件チャットはまだありません。";
  const lines = chats.map(
    (c) => `チャット#${c.id} ${chatName(c)}\n　案件: ${c.projectName ?? "未設定"} / 種別: ${KIND_LABEL[c.kind]}`,
  );
  return `💬 チャット一覧\n${lines.join("\n")}`;
}

export interface DoneTaskView {
  id: number;
  title: string;
  completed_at: string | null;
}

/** 案件の詳細（チャット・未完了タスク・最近完了したタスク） */
export function formatProjectDetail(
  projectName: string,
  chats: ChatView[],
  openTasks: TaskView[],
  recentDone: DoneTaskView[],
  today: string,
): string {
  const sections: string[] = [`🗂 ${projectName}`];
  sections.push(
    chats.length
      ? `💬 チャット\n${chats.map((c) => `・#${c.id} ${chatName(c)}（${KIND_LABEL[c.kind]}）`).join("\n")}`
      : "💬 チャット：なし（会話履歴の取り込みのみ）",
  );
  const open = openTasks.filter((t) => t.status === "open" || t.status === "candidate").sort(sortByDue);
  if (open.length === 0) {
    sections.push("📋 未完了のタスクはありません 🎉");
  } else {
    const lines = open.map((t) => {
      const prefix = t.status === "candidate" ? "❓候補 " : "";
      return `${prefix}${taskLine(t)}${dueMark(t.due_date, today)}`;
    });
    sections.push(`📋 未完了 ${open.length}件\n${lines.join("\n")}`);
  }
  if (recentDone.length) {
    const lines = recentDone.map((t) => {
      const date = t.completed_at ? formatDue(todayJst(new Date(t.completed_at))) : "";
      return `✅ #${t.id} ${t.title}${date ? `（${date}）` : ""}`;
    });
    sections.push(`最近の完了\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}
