import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { buildInstructionPrompt, parseInstruction } from "./instruction.ts";

Deno.test("parseInstruction: 正しい操作を読み取り、崩れた要素は捨てる", () => {
  const result = parseInstruction({
    is_instruction: true,
    ops: [
      {
        action: "approve",
        task_id: 1,
        project: null,
        title: "撮影（10/16・時間未定）",
        assignee: null,
        due: "2026-10-16",
      },
      { action: "complete", task_id: 2, project: null, title: null, assignee: null, due: null },
      { action: "update", task_id: 3, project: null, title: " ", assignee: null, due: "none" },
      { action: "update", task_id: 4, project: null, title: null, assignee: null, due: "16日" },
      { action: "explode", task_id: 5 },
      null,
    ],
    note: "",
  });
  assertEquals(result.ops.length, 4);
  assertEquals(result.ops[0].due, "2026-10-16");
  assertEquals(result.ops[2].title, null);
  assertEquals(result.ops[2].due, "none");
  assertEquals(result.ops[3].due, null);
  assertEquals(result.note, null);
});

Deno.test("parseInstruction: 雑談は指示ではない", () => {
  const result = parseInstruction({ is_instruction: false, ops: [], note: null });
  assert(!result.is_instruction);
  assertEquals(result.ops, []);
});

Deno.test("buildInstructionPrompt: 状態・案件・メッセージを含める", () => {
  const prompt = buildInstructionPrompt({
    today: "2026-10-10",
    projects: ["ミーシェ様", "エース"],
    tasks: [
      {
        id: 1,
        status: "candidate",
        projectName: "ミーシェ様",
        title: "次回撮影の日程調整",
        assignee: "小西",
        due: null,
      },
      { id: 2, status: "done", projectName: "ミーシェ様", title: "データ共有", assignee: null, due: null },
    ],
    text: "1，16日で時間未定",
  });
  assert(prompt.includes("今日: 2026-10-10(土)"));
  assert(prompt.includes("task_id=1 [候補] [ミーシェ様] 次回撮影の日程調整"));
  assert(prompt.includes("task_id=2 [完了] "));
  assert(prompt.endsWith("1，16日で時間未定"));
});
