import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  buildUserPrompt,
  type ExtractedAction,
  type ExtractionInput,
  parseExtraction,
  planOps,
  resolveAssignee,
  resolveProject,
} from "./extraction.ts";

const input: ExtractionInput = {
  today: "2026-10-09",
  projectName: "ABC社 サイト制作",
  chats: [
    { id: 1, name: "ABC社 制作チーム", kind: "internal" },
    { id: 2, name: "ABC社様 連絡用", kind: "client" },
  ],
  members: [
    { id: "U1", name: "田中 太郎" },
    { id: "U2", name: "佐藤" },
    { id: "U3", name: "ABC 山田" },
  ],
  openTasks: [
    { id: 10, title: "トップページ修正案の送付", assignee: "田中 太郎", due: "2026-10-10", status: "open" },
    { id: 11, title: "ロゴ再送", assignee: null, due: null, status: "candidate" },
  ],
  context: [
    { ref: "m1", dbId: 100, chatId: 1, sender: "佐藤", text: "前回の続きです", sentAt: "2026-10-09T01:00:00Z" },
  ],
  messages: [
    {
      ref: "m2",
      dbId: 101,
      chatId: 2,
      sender: "ABC 山田",
      text: "見積書を\n金曜までにいただけますか",
      sentAt: "2026-10-09T02:00:00Z",
    },
    {
      ref: "m3",
      dbId: 102,
      chatId: 2,
      sender: "佐藤",
      text: "承知しました、金曜までにお送りします",
      sentAt: "2026-10-09T02:05:00Z",
    },
    {
      ref: "m4",
      dbId: 103,
      chatId: 1,
      sender: "田中 太郎",
      text: "トップの修正案、先方に送りました",
      sentAt: "2026-10-09T03:00:00Z",
    },
  ],
};

const action = (a: Partial<ExtractedAction>): ExtractedAction => ({
  type: "create",
  task_id: null,
  project: null,
  title: null,
  assignee: null,
  due: null,
  evidence_refs: [],
  confidence: 0.9,
  reason: "",
  ...a,
});

Deno.test("buildUserPrompt に必要な情報が含まれる", () => {
  const prompt = buildUserPrompt(input);
  assertStringIncludes(prompt, "今日: 2026-10-09(金)");
  assertStringIncludes(prompt, "[クライアント:ABC社様 連絡用]");
  assertStringIncludes(prompt, "task_id=10 トップページ修正案の送付");
  assertStringIncludes(prompt, "task_id=11 [候補] ロゴ再送");
  assertStringIncludes(prompt, "[m2] 10/09 11:00 [クライアント:ABC社様 連絡用] ABC 山田: 見積書を\n    金曜までに");
  assert(prompt.indexOf("直前の会話") < prompt.indexOf("新しい会話"));
});

Deno.test("parseExtraction は不正な要素を捨て、値を正規化する", () => {
  const actions = parseExtraction({
    actions: [
      {
        type: "create",
        task_id: null,
        title: " 見積書送付 ",
        assignee: "佐藤",
        due: "2026-10-16",
        evidence_refs: ["m3"],
        confidence: 1.4,
        reason: "",
      },
      { type: "unknown" },
      {
        type: "update",
        task_id: 10,
        title: null,
        assignee: null,
        due: "2026-13-01",
        evidence_refs: "x",
        confidence: "high",
      },
    ],
  });
  assertEquals(actions.length, 2);
  assertEquals(actions[0].title, "見積書送付");
  assertEquals(actions[0].confidence, 1);
  assertEquals(actions[1].due, null);
  assertEquals(actions[1].evidence_refs, []);
  assertEquals(actions[1].confidence, 0);
  assertThrows(() => parseExtraction({}));
});

Deno.test("resolveAssignee", () => {
  assertEquals(resolveAssignee("佐藤さん", input.members), { id: "U2", name: "佐藤" });
  assertEquals(resolveAssignee("田中", input.members), { id: "U1", name: "田中 太郎" });
  assertEquals(resolveAssignee("山田様", input.members), { id: "U3", name: "ABC 山田" });
  assertEquals(resolveAssignee("鈴木さん", input.members), { id: null, name: "鈴木" });
  assertEquals(resolveAssignee(null, input.members), { id: null, name: null });
});

Deno.test("planOps: 確度で自動登録・候補・破棄に振り分ける", () => {
  const ops = planOps([
    action({
      title: "見積書の送付",
      assignee: "佐藤",
      due: "2026-10-16",
      evidence_refs: ["m3", "m2"],
      confidence: 0.9,
    }),
    action({ title: "サイトマップ確認", confidence: 0.6, evidence_refs: ["m2"] }),
    action({ title: "雑談", confidence: 0.3 }),
  ], input);
  assertEquals(ops.length, 2);
  assertEquals(ops[0], {
    op: "create",
    status: "open",
    title: "見積書の送付",
    assignee_id: "U2",
    assignee_name: "佐藤",
    due_date: "2026-10-16",
    confidence: 0.9,
    evidence: "[クライアント] 佐藤「承知しました、金曜までにお送りします」",
    source_chat_id: 2,
  });
  assertEquals(ops[1].op === "create" && ops[1].status, "candidate");
});

Deno.test("planOps: 完了・更新は既存の未完了タスクだけに反映する", () => {
  const ops = planOps([
    action({ type: "complete", task_id: 10, evidence_refs: ["m4"], confidence: 0.85 }),
    action({ type: "complete", task_id: 999, confidence: 0.95 }), // 存在しない
    action({ type: "update", task_id: 11, due: "2026-10-20", assignee: "田中", confidence: 0.8 }),
    action({ type: "update", task_id: 11, title: "ロゴ再送", confidence: 0.9 }), // 同じタスクへの2回目は無視
    action({ type: "complete", task_id: 11, confidence: 0.5 }), // 確度不足
  ], input);
  assertEquals(ops, [
    { op: "complete", task_id: 10, confidence: 0.85, evidence: "[制作] 田中 太郎「トップの修正案、先方に送りました」" },
    {
      op: "update",
      task_id: 11,
      confidence: 0.8,
      evidence: null,
      due_date: "2026-10-20",
      assignee_id: "U1",
      assignee_name: "田中 太郎",
    },
  ]);
});

Deno.test("planOps: 変化のない update は出さない", () => {
  const ops = planOps([
    action({
      type: "update",
      task_id: 10,
      title: "トップページ修正案の送付",
      due: "2026-10-10",
      assignee: "田中",
      confidence: 0.9,
    }),
  ], input);
  assertEquals(ops, []);
});

const hub: ExtractionInput = {
  ...input,
  projectName: "社内",
  projects: [
    { id: 1, name: "社内" },
    { id: 5, name: "エース" },
    { id: 11, name: "止水板LP" },
    { id: 18, name: "小西", description: "小西さん自身のタスク" },
  ],
  openTasks: [
    { id: 5, title: "Instagramアカウント作成", assignee: null, due: null, status: "open", projectId: 5 },
    { id: 16, title: "LP制作", assignee: null, due: "2026-10-13", status: "open", projectId: 11 },
  ],
};

Deno.test("buildUserPrompt: 横断チャットでは案件ごとにタスクを並べる", () => {
  const prompt = buildUserPrompt(hub);
  assertStringIncludes(prompt, "## 案件一覧");
  assertStringIncludes(prompt, "- 小西：小西さん自身のタスク");
  assertStringIncludes(prompt, "### 止水板LP\n- task_id=16 LP制作");
  assertStringIncludes(prompt, "### エース\n- task_id=5 Instagramアカウント作成");
  assert(!buildUserPrompt(input).includes("案件一覧"));
});

Deno.test("resolveProject", () => {
  assertEquals(resolveProject("止水板LP", hub.projects), 11);
  assertEquals(resolveProject("エース", hub.projects), 5);
  assertEquals(resolveProject("止水板", hub.projects), 11);
  assertEquals(resolveProject("不明な案件", hub.projects), undefined);
  assertEquals(resolveProject("エース", undefined), undefined);
});

Deno.test("planOps: 横断チャットでは別案件のタスクにも反映し、作成先も選べる", () => {
  const ops = planOps([
    action({ type: "update", task_id: 16, title: "LP制作（保留）", evidence_refs: ["m2"] }),
    action({ type: "complete", task_id: 5, evidence_refs: ["m3"] }),
    action({ type: "create", project: "エース", title: "TikTok確認", evidence_refs: ["m4"] }),
    action({ type: "create", project: null, title: "社内の作業", evidence_refs: ["m4"] }),
  ], hub);
  assertEquals(ops.map((o) => [o.op, o.project_id]), [
    ["update", 11],
    ["complete", 5],
    ["create", 5],
    ["create", undefined],
  ]);
  // 通常の案件チャットでは project_id を付けない
  const normal = planOps([action({ type: "complete", task_id: 10, evidence_refs: ["m4"] })], input);
  assertEquals("project_id" in normal[0], false);
});
