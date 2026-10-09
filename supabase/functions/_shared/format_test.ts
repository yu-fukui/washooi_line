import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import {
  buildCandidateFlex,
  type EventView,
  formatNotification,
  formatSummary,
  formatTaskList,
  type TaskView,
} from "./format.ts";

const task = (t: Partial<TaskView>): TaskView => ({
  id: 1,
  title: "タスク",
  status: "open",
  assignee_name: null,
  due_date: null,
  evidence: null,
  projectName: "案件A",
  ...t,
});

const ev = (kind: string, t: TaskView | null, detail: EventView["detail"] = null): EventView => ({
  kind,
  task: t,
  chat: null,
  detail,
  projectName: t?.projectName ?? null,
});

Deno.test("formatNotification: 案件ごとにまとめる", () => {
  const created = task({
    id: 12,
    title: "見積書を作成して送付",
    assignee_name: "田中",
    due_date: "2026-10-17",
    evidence: "[クライアント] 田中「金曜までに」",
  });
  const text = formatNotification([
    ev("created", created),
    ev("updated", created, { due_date: "2026-10-20" }), // 同じ回で作成済みなので更新は表示しない
    ev("candidate", task({ id: 15, title: "ロゴ再送", status: "candidate", projectName: "案件C" })),
    ev("completed", task({ id: 5, title: "初稿提出", status: "done", assignee_name: "佐藤", projectName: "案件B" })),
    ev("created", task({ id: 20, status: "dismissed" })), // 通知前に削除済み
    {
      kind: "chat_joined",
      task: null,
      detail: null,
      projectName: "案件D",
      chat: { id: 3, name: "D社様連絡", kind: "client", projectName: "案件D" },
    },
  ], "🔔 タスク更新")!;
  assertStringIncludes(
    text,
    "【案件A】\n🆕 #12 見積書を作成して送付\n　👤田中 ⏰10/17(土)\n　💬[クライアント] 田中「金曜までに」",
  );
  assertStringIncludes(text, "【案件C】\n❓ 候補 #15 ロゴ再送");
  assertStringIncludes(text, "【案件B】\n✅ #5 初稿提出（👤佐藤）");
  assertStringIncludes(text, "紐付け 3 案件名");
  assert(!text.includes("✏️"));
  assert(!text.includes("#20"));
});

Deno.test("formatNotification: 表示するものがなければ null", () => {
  assertEquals(formatNotification([ev("created", task({ status: "dismissed" }))], "h"), null);
  assertEquals(formatNotification([], "h"), null);
});

Deno.test("buildCandidateFlex", () => {
  const flex = buildCandidateFlex([task({ id: 15, status: "candidate" }), task({ id: 16, status: "open" })])!;
  assertEquals(flex.contents.contents.length, 1);
  const buttons = flex.contents.contents[0].footer.contents;
  assertEquals(buttons[0].action.data, "action=approve&task=15");
  assertEquals(buttons[1].action.data, "action=dismiss&task=15");
  assertEquals(buildCandidateFlex([task({ status: "open" })]), null);
});

Deno.test("formatTaskList: 期限順・期限切れの表示", () => {
  const text = formatTaskList([
    task({ id: 2, title: "B", due_date: "2026-10-20" }),
    task({ id: 1, title: "A", due_date: "2026-10-08" }),
    task({ id: 3, title: "C" }),
    task({ id: 4, title: "D", status: "done" }),
  ], "2026-10-09");
  assertStringIncludes(text, "（3件）");
  assert(text.indexOf("#1 A") < text.indexOf("#2 B") && text.indexOf("#2 B") < text.indexOf("#3 C"));
  assertStringIncludes(text, "⚠期限切れ");
  assert(!text.includes("#4"));
});

Deno.test("formatSummary", () => {
  const text = formatSummary([
    task({ id: 1, title: "期限切れ", due_date: "2026-10-01" }),
    task({ id: 2, title: "今日", due_date: "2026-10-09", projectName: "案件B" }),
    task({ id: 3, title: "今週", due_date: "2026-10-14" }),
    task({ id: 4, title: "来月", due_date: "2026-11-30" }),
    task({ id: 5, title: "未定" }),
    task({ id: 6, title: "候補", status: "candidate", due_date: "2026-10-09" }),
  ], "2026-10-09")!;
  assertStringIncludes(text, "2案件・未完了5件");
  assertStringIncludes(text, "⚠ 期限切れ 1件");
  assertStringIncludes(text, "⏰ 今日まで 1件\n・[案件B] #2 今日");
  assertStringIncludes(text, "📅 7日以内 1件");
  assertStringIncludes(text, "それ以降 1件 / 期限未定 1件");
  assertEquals(formatSummary([], "2026-10-09"), null);
});
