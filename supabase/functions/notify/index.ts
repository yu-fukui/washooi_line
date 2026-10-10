// 毎朝6:00: 未通知のタスク変化と全案件の未完了サマリーを、通知先グループ（未登録ならメインチャット）へ送る。
// 朝の回（body: {"summary": true}）は全案件の未完了タスクのサマリーも同じプッシュで送り、グループ名も更新する。
import { formatDateTimeJst, todayJst } from "../_shared/dates.ts";
import { type DB, db, getSetting, must } from "../_shared/db.ts";
import { isCronRequest, json } from "../_shared/env.ts";
import {
  buildCandidateFlex,
  buildSummaryCarousel,
  type EventView,
  formatNotification,
  formatSummaryHeader,
} from "../_shared/format.ts";
import { getGroupName, type LineMessage, push, textMessages } from "../_shared/line.ts";
import { loadChats, loadOpenTasks, loadTasksByIds } from "../_shared/queries.ts";

const MENU_QUICK_REPLY = {
  items: [
    { type: "action", action: { type: "message", label: "タスク一覧", text: "一覧" } },
    {
      type: "action",
      action: { type: "postback", label: "案件を選ぶ", data: "action=projects&page=0", displayText: "案件を選ぶ" },
    },
    { type: "action", action: { type: "postback", label: "ヘルプ", data: "action=help", displayText: "ヘルプ" } },
  ],
};

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
  const body = await req.json().catch(() => ({}));
  const withSummary = body?.summary === true;
  // {"test": true} は試し送信。通知済みの記録はしない。送り先は既定でメインチャット（1対1）、
  // {"to": "notify"} なら通知先グループ。{"intro": "..."} は冒頭に添える文
  const isTest = body?.test === true;
  const toNotifyGroup = body?.to === "notify";
  const intro = typeof body?.intro === "string" && body.intro.trim() ? body.intro.trim() : null;
  const sb = db();

  if (withSummary) await refreshChatNames(sb);

  // 通知先グループが登録されていればそこへ、なければメインチャットへ送る
  const target = isTest && !toNotifyGroup
    ? await getSetting(sb, "main_group_id")
    : (await getSetting(sb, "notify_group_id")) ?? (await getSetting(sb, "main_group_id"));
  if (!target) return json({ skipped: "メインチャット未登録" });

  const rows = must(
    await sb.from("events").select("id, kind, task_id, chat_id, detail")
      .is("notified_at", null).order("id").limit(500),
  ) as EventRow[];
  const events = await loadEvents(sb, rows);

  const updates = formatNotification(events, `🔔 タスク更新（${formatDateTimeJst(new Date().toISOString())}）`);
  const openTasks = withSummary ? await loadOpenTasks(sb, false) : [];
  const summary = withSummary ? formatSummaryHeader(openTasks, todayJst()) : null;
  const carousel = withSummary ? buildSummaryCarousel(openTasks, todayJst()) : null;
  const flex = buildCandidateFlex(events.filter((e) => e.kind === "candidate" && e.task).map((e) => e.task!));

  // テキスト（更新 → 朝のあいさつ）・案件別カルーセル・候補カードを1回のプッシュ（最大5メッセージ）にまとめる
  const text = [intro, updates, summary].filter((t): t is string => !!t).join("\n\n━━━━━━━━━━\n\n");
  const cards = [carousel, flex].filter((m): m is LineMessage => !!m);
  const messages: LineMessage[] = [];
  if (text) messages.push(...textMessages(text, 5 - cards.length));
  messages.push(...cards);
  // 通知先がグループだとリッチメニューが出ないため、一覧・案件選択をクイックリプライで出す
  if (messages.length > 0) messages[messages.length - 1].quickReply = MENU_QUICK_REPLY;

  if (messages.length > 0) {
    await push(target, messages, crypto.randomUUID());
  }
  if (rows.length > 0 && !isTest) {
    must(
      await sb.from("events").update({ notified_at: new Date().toISOString() }).in("id", rows.map((r) => r.id)),
    );
  }
  return json({ sent: messages.length > 0, events: rows.length, summary: !!summary, test: isTest });
});
