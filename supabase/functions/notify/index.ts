// 1日2回（9:00 / 18:00）: 未通知のタスク変化をまとめてメインチャットへ送る。
// 朝の回（body: {"summary": true}）は全案件の未完了タスクのサマリーも同じプッシュで送り、グループ名も更新する。
import { formatDateTimeJst, todayJst } from "../_shared/dates.ts";
import { type DB, db, getSetting, must } from "../_shared/db.ts";
import { isCronRequest, json } from "../_shared/env.ts";
import { buildCandidateFlex, type EventView, formatNotification, formatSummary } from "../_shared/format.ts";
import { getGroupName, type LineMessage, push, textMessages } from "../_shared/line.ts";
import { loadChats, loadOpenTasks, loadTasksByIds } from "../_shared/queries.ts";

interface EventRow {
  id: number;
  kind: string;
  task_id: number | null;
  chat_id: number | null;
  // deno-lint-ignore no-explicit-any
  detail: Record<string, any> | null;
}

async function refreshChatNames(sb: DB) {
  for (const chat of await loadChats(sb, { activeOnly: true })) {
    const name = await getGroupName(chat.lineGroupId);
    if (name && name !== chat.name) must(await sb.from("chats").update({ name }).eq("id", chat.id));
  }
}

async function loadEvents(sb: DB, rows: EventRow[]): Promise<EventView[]> {
  const tasks = new Map(
    (await loadTasksByIds(sb, rows.flatMap((r) => (r.task_id ? [r.task_id] : [])))).map((t) => [t.id, t]),
  );
  const chats = new Map(
    (await loadChats(sb, { ids: rows.flatMap((r) => (r.chat_id ? [r.chat_id] : [])) })).map((c) => [c.id, c]),
  );
  return rows.map((r) => {
    const task = r.task_id ? tasks.get(r.task_id) ?? null : null;
    const chat = r.chat_id ? chats.get(r.chat_id) ?? null : null;
    return { kind: r.kind, task, chat, detail: r.detail, projectName: task?.projectName ?? chat?.projectName ?? null };
  });
}

Deno.serve(async (req) => {
  if (!isCronRequest(req)) return json({ error: "unauthorized" }, 401);
  const withSummary = (await req.json().catch(() => ({})))?.summary === true;
  const sb = db();

  if (withSummary) await refreshChatNames(sb);

  const mainGroupId = await getSetting(sb, "main_group_id");
  if (!mainGroupId) return json({ skipped: "メインチャット未登録" });

  const rows = must(
    await sb.from("events").select("id, kind, task_id, chat_id, detail")
      .is("notified_at", null).order("id").limit(500),
  ) as EventRow[];
  const events = await loadEvents(sb, rows);

  const updates = formatNotification(events, `🔔 タスク更新（${formatDateTimeJst(new Date().toISOString())}）`);
  const summary = withSummary ? formatSummary(await loadOpenTasks(sb, false), todayJst()) : null;
  const flex = buildCandidateFlex(events.filter((e) => e.kind === "candidate" && e.task).map((e) => e.task!));

  // テキスト（更新 → サマリー）と候補カードを1回のプッシュ（最大5メッセージ）にまとめる
  const text = [updates, summary].filter((t): t is string => !!t).join("\n\n━━━━━━━━━━\n\n");
  const messages: LineMessage[] = [];
  if (text) messages.push(...textMessages(text, flex ? 4 : 5));
  if (flex) messages.push(flex);

  if (messages.length > 0) {
    await push(mainGroupId, messages, crypto.randomUUID());
  }
  if (rows.length > 0) {
    must(
      await sb.from("events").update({ notified_at: new Date().toISOString() }).in("id", rows.map((r) => r.id)),
    );
  }
  return json({ sent: messages.length > 0, events: rows.length, summary: !!summary });
});
