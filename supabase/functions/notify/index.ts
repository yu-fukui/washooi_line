// 毎時: 未通知のタスク変化を1通にまとめてメインチャットへ送る
import { db, getSetting, must } from "../_shared/db.ts";
import { isCronRequest, json } from "../_shared/env.ts";
import { formatDateTimeJst } from "../_shared/dates.ts";
import { buildCandidateFlex, type EventView, formatNotification } from "../_shared/format.ts";
import { type LineMessage, push, textMessages } from "../_shared/line.ts";
import { loadChats, loadTasksByIds } from "../_shared/queries.ts";

interface EventRow {
  id: number;
  kind: string;
  task_id: number | null;
  chat_id: number | null;
  // deno-lint-ignore no-explicit-any
  detail: Record<string, any> | null;
}

Deno.serve(async (req) => {
  if (!isCronRequest(req)) return json({ error: "unauthorized" }, 401);
  const sb = db();
  const mainGroupId = await getSetting(sb, "main_group_id");
  if (!mainGroupId) return json({ skipped: "メインチャット未登録" });

  const rows = must(
    await sb.from("events").select("id, kind, task_id, chat_id, detail")
      .is("notified_at", null).order("id").limit(500),
  ) as EventRow[];
  if (rows.length === 0) return json({ sent: false });

  const tasks = new Map(
    (await loadTasksByIds(sb, rows.flatMap((r) => (r.task_id ? [r.task_id] : [])))).map((t) => [t.id, t]),
  );
  const chats = new Map(
    (await loadChats(sb, { ids: rows.flatMap((r) => (r.chat_id ? [r.chat_id] : [])) })).map((c) => [c.id, c]),
  );
  const events: EventView[] = rows.map((r) => {
    const task = r.task_id ? tasks.get(r.task_id) ?? null : null;
    const chat = r.chat_id ? chats.get(r.chat_id) ?? null : null;
    return { kind: r.kind, task, chat, detail: r.detail, projectName: task?.projectName ?? chat?.projectName ?? null };
  });

  const text = formatNotification(events, `🔔 タスク更新（${formatDateTimeJst(new Date().toISOString())}）`);
  const candidates = events
    .filter((e) => e.kind === "candidate" && e.task)
    .map((e) => e.task!);
  const flex = buildCandidateFlex(candidates);

  const messages: LineMessage[] = [];
  if (text) messages.push(...textMessages(text, flex ? 4 : 5));
  if (flex) messages.push(flex);

  if (messages.length > 0) {
    await push(mainGroupId, messages, crypto.randomUUID());
  }
  must(
    await sb.from("events").update({ notified_at: new Date().toISOString() }).in("id", rows.map((r) => r.id)),
  );
  return json({ sent: messages.length > 0, events: rows.length });
});
