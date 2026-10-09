// 毎朝9時: 全案件の未完了タスクのサマリーをメインチャットへ送る。あわせてグループ名を更新する
import { todayJst } from "../_shared/dates.ts";
import { db, getSetting, must } from "../_shared/db.ts";
import { isCronRequest, json } from "../_shared/env.ts";
import { formatSummary } from "../_shared/format.ts";
import { getGroupName, push, textMessages } from "../_shared/line.ts";
import { loadChats, loadOpenTasks } from "../_shared/queries.ts";

Deno.serve(async (req) => {
  if (!isCronRequest(req)) return json({ error: "unauthorized" }, 401);
  const sb = db();

  for (const chat of await loadChats(sb, { activeOnly: true })) {
    const name = await getGroupName(chat.lineGroupId);
    if (name && name !== chat.name) must(await sb.from("chats").update({ name }).eq("id", chat.id));
  }

  const mainGroupId = await getSetting(sb, "main_group_id");
  if (!mainGroupId) return json({ skipped: "メインチャット未登録" });

  const text = formatSummary(await loadOpenTasks(sb, false), todayJst());
  if (!text) return json({ sent: false });
  await push(mainGroupId, textMessages(text), crypto.randomUUID());
  return json({ sent: true });
});
