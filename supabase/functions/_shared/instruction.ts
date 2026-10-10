// メインチャットに普通の文章で送られた指示（「1は16日で時間未定、2は済」など）を AI で操作に変換する
import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { isValidDate, weekdayJa } from "./dates.ts";
import { env, optEnv } from "./env.ts";

export interface InstructionTask {
  id: number;
  status: "candidate" | "open" | "done" | "dismissed";
  projectName: string;
  title: string;
  assignee: string | null;
  due: string | null;
}

export interface InstructionInput {
  today: string;
  projects: string[];
  tasks: InstructionTask[]; // 未完了・候補・最近完了したタスク
  text: string;
}

export type InstructionAction = "complete" | "approve" | "update" | "reopen" | "delete" | "create";

export interface InstructionOp {
  action: InstructionAction;
  task_id: number | null;
  project: string | null;
  title: string | null;
  assignee: string | null;
  due: string | null; // YYYY-MM-DD / "none"（期限なしにする）/ null（変更しない）
}

export interface Instruction {
  is_instruction: boolean;
  ops: InstructionOp[];
  note: string | null;
}

const ACTIONS: InstructionAction[] = ["complete", "approve", "update", "reopen", "delete", "create"];

export const INSTRUCTION_SYSTEM_PROMPT =
  `あなたは制作会社のタスク管理ボットです。管理者がメインチャットに送った文章を読み、タスク一覧への操作に変換します。
管理者は「1は16日で時間未定」「2済」「波多野さんの動画確認終わった」のように、短く書くことが多いです。

## 操作（action）
- complete: 完了にする（「済」「終わった」「送った」「返信済み」など）
- approve: 候補（[候補]）を正式なタスクとして登録する（「○」「登録」「OK」など）。内容・担当・期限の変更を同時に指定してよい
- update: 内容（title）・担当（assignee）・期限（due）を変える
- reopen: 完了・削除済みのタスクを未完了に戻す
- delete: 削除する（「×」「いらない」「なし」「消して」など）
- create: 新しいタスクを追加する（project に案件名を必ず入れる）

## ルール
- 番号（「1」「#1」）はタスクの task_id。番号がなければ案件名や内容からタスクを特定する。特定できないときは操作を作らず note で聞き返す
- 「保留」「未定」「そのまま」は操作しない（note で「そのままにします」と伝える）
- 未完了タスクが「確認待ち」「連絡待ち」「返事待ち」になったと伝えられたら、update で title の末尾に「（確認待ち）」のように付ける（すでに「待ち」を含むなら変えない）。待ちが終わったら update で外す。候補（[候補]）が「連絡待ち」なら操作しない
- 候補に日付や時間などの補足が付いたら、approve にして title・due に反映する。時間などの補足は title の末尾に「（10/16・時間未定）」のように入れる
- due は YYYY-MM-DD。「16日」「金曜」「来週」は今日から計算する。期限をなくすときは "none"。変えないときは null
- title・assignee は変えないときは null
- 挨拶やお礼などタスク操作と関係ない文章は is_instruction を false、ops を空にする
- note は聞き返しや補足があるときだけ、短い日本語で。なければ null`;

export const INSTRUCTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_instruction", "ops", "note"],
  properties: {
    is_instruction: { type: "boolean" },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "task_id", "project", "title", "assignee", "due"],
        properties: {
          action: { type: "string", enum: ACTIONS },
          task_id: { type: ["integer", "null"] },
          project: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          assignee: { type: ["string", "null"] },
          due: { type: ["string", "null"], description: 'YYYY-MM-DD / "none" / null' },
        },
      },
    },
    note: { type: ["string", "null"] },
  },
} as const;

const STATUS_LABEL: Record<InstructionTask["status"], string> = {
  candidate: "[候補] ",
  open: "",
  done: "[完了] ",
  dismissed: "[削除] ",
};

export function buildInstructionPrompt(input: InstructionInput): string {
  const lines = [`今日: ${input.today}(${weekdayJa(input.today)})`, "", "## 案件"];
  lines.push(input.projects.length ? input.projects.join(" / ") : "(なし)");
  lines.push("", "## タスク");
  if (input.tasks.length === 0) lines.push("(なし)");
  for (const t of input.tasks) {
    lines.push(
      `- task_id=${t.id} ${STATUS_LABEL[t.status]}[${t.projectName}] ${t.title} / 担当: ${
        t.assignee ?? "未定"
      } / 期限: ${t.due ?? "未定"}`,
    );
  }
  lines.push("", "## 管理者からのメッセージ", input.text);
  return lines.join("\n");
}

/** AIの出力を検証する。形式が崩れた操作は捨てる */
export function parseInstruction(raw: unknown): Instruction {
  // deno-lint-ignore no-explicit-any
  const r = raw as any;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const ops: InstructionOp[] = [];
  for (const o of Array.isArray(r?.ops) ? r.ops : []) {
    if (!o || !ACTIONS.includes(o.action)) continue;
    const due = str(o.due);
    ops.push({
      action: o.action,
      task_id: Number.isInteger(o.task_id) ? o.task_id : null,
      project: str(o.project),
      title: str(o.title),
      assignee: str(o.assignee),
      due: due === "none" || (due && isValidDate(due)) ? due : null,
    });
  }
  return { is_instruction: r?.is_instruction === true || ops.length > 0, ops, note: str(r?.note) };
}

let client: Anthropic | null = null;

export async function interpretWithClaude(input: InstructionInput): Promise<Instruction> {
  client ??= new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  // 返信は受信から短時間で返す必要があるため、速いモデル・低い effort を既定にする
  const response = await client.beta.messages.create({
    model: optEnv("CLAUDE_INSTRUCTION_MODEL", "claude-haiku-5-5"),
    max_tokens: 4000,
    system: INSTRUCTION_SYSTEM_PROMPT,
    output_config: {
      effort: optEnv("CLAUDE_INSTRUCTION_EFFORT", "low") as "low" | "medium" | "high",
      format: { type: "json_schema", schema: INSTRUCTION_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: buildInstructionPrompt(input) }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`instruction stop_reason: ${response.stop_reason}`);
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseInstruction(JSON.parse(text));
}
