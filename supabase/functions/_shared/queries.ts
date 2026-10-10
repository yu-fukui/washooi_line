// 複数の Edge Function で使う読み込み処理
import { type DB, must } from "./db.ts";
import type { ChatKind } from "./extraction.ts";
import type { ChatView, TaskView } from "./format.ts";

interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  status: TaskView["status"];
  assignee_name: string | null;
  due_date: string | null;
  evidence: string | null;
}

const TASK_COLUMNS = "id, project_id, title, status, assignee_name, due_date, evidence";

export async function projectNames(sb: DB, ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = must(await sb.from("projects").select("id, name").in("id", unique)) as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function toViews(sb: DB, rows: TaskRow[]): Promise<TaskView[]> {
  const names = await projectNames(sb, rows.map((r) => r.project_id));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    assignee_name: r.assignee_name,
    due_date: r.due_date,
    evidence: r.evidence,
    projectName: names.get(r.project_id) ?? `案件#${r.project_id}`,
    projectId: r.project_id,
  }));
}

export async function loadTasksByIds(sb: DB, ids: number[]): Promise<TaskView[]> {
  if (ids.length === 0) return [];
  const rows = must(await sb.from("tasks").select(TASK_COLUMNS).in("id", [...new Set(ids)])) as TaskRow[];
  return toViews(sb, rows);
}

export async function loadOpenTasks(sb: DB, includeCandidates = true): Promise<TaskView[]> {
  const statuses = includeCandidates ? ["open", "candidate"] : ["open"];
  const rows = must(
    await sb.from("tasks").select(TASK_COLUMNS).in("status", statuses).order("id").limit(1000),
  ) as TaskRow[];
  return toViews(sb, rows);
}

interface ChatRow {
  id: number;
  name: string | null;
  kind: ChatKind;
  project_id: number | null;
  line_group_id: string;
}

export async function loadChats(sb: DB, opts: { ids?: number[]; activeOnly?: boolean } = {}): Promise<
  (ChatView & { lineGroupId: string; projectId: number | null })[]
> {
  let q = sb.from("chats").select("id, name, kind, project_id, line_group_id").order("id");
  if (opts.ids) q = q.in("id", [...new Set(opts.ids)]);
  if (opts.activeOnly) q = q.eq("active", true);
  const rows = must(await q) as ChatRow[];
  const names = await projectNames(sb, rows.flatMap((r) => (r.project_id ? [r.project_id] : [])));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    projectName: r.project_id ? names.get(r.project_id) ?? null : null,
    projectId: r.project_id,
    lineGroupId: r.line_group_id,
  }));
}
