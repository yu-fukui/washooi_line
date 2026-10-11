// 15分ごと: 会話が一段落した案件の未処理メッセージを Claude で解析し、タスクを記録する
import { todayJst } from "../_shared/dates.ts";
import { type DB, db, must } from "../_shared/db.ts";
import { isCronRequest, json, optEnv } from "../_shared/env.ts";
import {
  type ChatInfo,
  type ChatMessage,
  ExtractionRefusedError,
  extractWithClaude,
  type MemberInfo,
  type OpenTask,
  planOps,
} from "../_shared/extraction.ts";
import { isSmallTalk } from "../_shared/smalltalk.ts";

const IDLE_MINUTES = Number(optEnv("EXTRACT_IDLE_MINUTES", "10"));
const MIN_PENDING = Number(optEnv("EXTRACT_MIN_PENDING", "30"));
const MAX_PROJECTS = Number(optEnv("EXTRACT_MAX_PROJECTS", "5"));
const MAX_MESSAGES = 200;
const CONTEXT_MESSAGES = 10;

interface MessageRow {
  id: number;
  chat_id: number;
  sender_id: string | null;
  text: string;
  sent_at: string;
}

async function processProject(sb: DB, projectId: number) {
  const project = must(await sb.from("projects").select("id, name").eq("id", projectId).single()) as {
    id: number;
    name: string;
  };
  const chats = must(
    await sb.from("chats").select("id, name, kind").eq("project_id", projectId),
  ) as ChatInfo[];
  const chatIds = chats.map((c) => c.id);

  const pending = must(
    await sb.from("messages").select("id, chat_id, sender_id, text, sent_at")
      .in("chat_id", chatIds).is("processed_at", null)
      .order("sent_at").limit(MAX_MESSAGES),
  ) as MessageRow[];
  if (pending.length === 0) return { projectId, ops: 0 };

  const context = (must(
    await sb.from("messages").select("id, chat_id, sender_id, text, sent_at")
      .in("chat_id", chatIds).not("processed_at", "is", null)
      .lt("sent_at", pending[0].sent_at)
      .order("sent_at", { ascending: false }).limit(CONTEXT_MESSAGES),
  ) as MessageRow[]).reverse();

  const links = must(
    await sb.from("chat_members").select("line_user_id").in("chat_id", chatIds),
  ) as { line_user_id: string }[];
  const userIds = [
    ...new Set([...links.map((l) => l.line_user_id), ...pending.flatMap((m) => (m.sender_id ? [m.sender_id] : []))]),
  ];
  const memberRows = userIds.length
    ? must(await sb.from("members").select("line_user_id, display_name").in("line_user_id", userIds)) as {
      line_user_id: string;
      display_name: string;
    }[]
    : [];
  const members: MemberInfo[] = memberRows.map((m) => ({ id: m.line_user_id, name: m.display_name }));
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  const openTasks = must(
    await sb.from("tasks").select("id, title, assignee_name, due_date, status")
      .eq("project_id", projectId).in("status", ["open", "candidate"]).order("id"),
  ) as {
    id: number;
    title: string;
    assignee_name: string | null;
    due_date: string | null;
    status: OpenTask["status"];
  }[];

  let n = 0;
  const toMessage = (m: MessageRow): ChatMessage => ({
    ref: `m${++n}`,
    dbId: m.id,
    chatId: m.chat_id,
    sender: (m.sender_id && nameOf.get(m.sender_id)) || "不明",
    text: m.text,
    sentAt: m.sent_at,
  });

  const input = {
    today: todayJst(),
    projectName: project.name,
    chats,
    members,
    openTasks: openTasks.map((t) => ({
      id: t.id,
      title: t.title,
      assignee: t.assignee_name,
      due: t.due_date,
      status: t.status,
    })),
    context: context.map(toMessage),
    messages: pending.map(toMessage),
  };

  let ops: ReturnType<typeof planOps> = [];
  // お礼・あいづちだけのやり取りならタスクは生まれないので、AI を呼ばずに処理済みにする
  const onlySmallTalk = pending.every((m) => isSmallTalk(m.text));
  try {
    if (!onlySmallTalk) ops = planOps(await extractWithClaude(input), input);
  } catch (e) {
    if (!(e instanceof ExtractionRefusedError)) throw e; // 一時的なエラーは次回再試行
    // 拒否された会話は再試行しても同じ結果になるため、処理済みにして先へ進む
    console.warn(`project ${projectId}: extraction refused`, e.message);
  }

  must(
    await sb.rpc("apply_extraction", {
      p_project_id: projectId,
      p_message_ids: pending.map((m) => m.id),
      p_ops: ops,
    }),
  );
  return { projectId, messages: pending.length, ops: ops.length, skipped: onlySmallTalk };
}

Deno.serve(async (req) => {
  if (!isCronRequest(req)) return json({ error: "unauthorized" }, 401);
  const sb = db();
  const due = must(
    await sb.rpc("projects_due_for_extraction", { p_idle_minutes: IDLE_MINUTES, p_min_count: MIN_PENDING }),
  ) as { project_id: number; pending: number }[];

  const targets = due.slice(0, MAX_PROJECTS);
  const results = await Promise.allSettled(targets.map((p) => processProject(sb, p.project_id)));
  const summary = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { projectId: targets[i].project_id, error: String(r.reason) }
  );
  for (const r of summary) if ("error" in r) console.error("extract failed", r);
  return json({ processed: summary, remaining: Math.max(0, due.length - targets.length) });
});
