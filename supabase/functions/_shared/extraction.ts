// 会話ログからのタスク抽出（Claude API）と、抽出結果を DB 操作に変換するロジック
import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { formatDateTimeJst, isValidDate, weekdayJa } from "./dates.ts";
import { env, optEnv } from "./env.ts";

export type ChatKind = "internal" | "client";

export const KIND_LABEL: Record<ChatKind, string> = { internal: "制作", client: "クライアント" };

export interface ChatInfo {
  id: number;
  name: string | null;
  kind: ChatKind;
}

export interface MemberInfo {
  id: string;
  name: string;
}

export interface OpenTask {
  id: number;
  title: string;
  assignee: string | null;
  due: string | null;
  status: "open" | "candidate";
}

export interface ChatMessage {
  ref: string; // AI に渡す短い参照ID（m1, m2, ...）
  dbId: number;
  chatId: number;
  sender: string;
  text: string;
  sentAt: string;
}

export interface ExtractionInput {
  today: string;
  projectName: string;
  chats: ChatInfo[];
  members: MemberInfo[];
  openTasks: OpenTask[];
  context: ChatMessage[]; // 処理済みの直前の会話（文脈用）
  messages: ChatMessage[]; // 今回解析する会話
}

export interface ExtractedAction {
  type: "create" | "update" | "complete";
  task_id: number | null;
  title: string | null;
  assignee: string | null;
  due: string | null;
  evidence_refs: string[];
  confidence: number;
  reason: string;
}

export const SYSTEM_PROMPT = `あなたは制作会社の案件チャットを読み、タスク（やるべき作業）を管理するアシスタントです。
1つの案件には複数のLINEグループがあります。「制作」は社内・制作チームのチャット、「クライアント」は取引先とのやり取り用のチャットです。
新しい会話を読み、タスク一覧に対して必要な操作を actions として出力してください。

## 操作の種類
- create: 新しいタスク。次のような発言から作る
  - 依頼とその引き受け（「〜お願いできますか」「承知しました、金曜までに送ります」）
  - 自分でやると宣言した作業（「明日までに修正版を出します」）
  - クライアントからの依頼・修正指示（担当が決まっていなくても作る）
  - 期限や納品物を伴う約束
- update: 既存タスクの期限・担当・内容が変わった（task_id 必須）
- complete: 既存タスクが完了した報告（「送付しました」「対応済みです」「アップしました」など。task_id 必須）
  - クライアントチャットの依頼が制作チャットで完了報告されることもある。チャットをまたいで判断する

## 作らないもの
- 挨拶、お礼、雑談、単なる情報共有、確認だけで作業が発生しないもの
- 既存タスクと同じ内容（重複させず、変更があれば update にする）
- 文脈のための「直前の会話」だけに出てくる話（新しい会話で触れられたものだけを対象にする）

## 各項目
- title: 何をするかが一目で分かる短い日本語（例:「トップページ修正案の送付」）。update で変更しない場合は null
- assignee: 担当者の表示名。メンバー一覧の名前をそのまま使う。不明なら null。クライアント側の人が担当の場合もその名前を入れる
- due: 期限を YYYY-MM-DD で。「金曜」「来週月曜」「月末」などは今日の日付から計算する。期限の言及がなければ null
- evidence_refs: 根拠となったメッセージの参照ID（例: ["m3","m5"]）。最も重要なものを先頭に
- confidence: 0〜1。依頼と引き受けが明確なら 0.8 以上、タスクかどうか曖昧なら 0.5〜0.8
- reason: 判断理由を一文で

該当する操作がなければ actions は空配列にしてください。`;

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "task_id", "title", "assignee", "due", "evidence_refs", "confidence", "reason"],
        properties: {
          type: { type: "string", enum: ["create", "update", "complete"] },
          task_id: { type: ["integer", "null"] },
          title: { type: ["string", "null"] },
          assignee: { type: ["string", "null"] },
          due: { type: ["string", "null"], description: "YYYY-MM-DD" },
          evidence_refs: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

function chatLabel(chats: Map<number, ChatInfo>, chatId: number): string {
  const chat = chats.get(chatId);
  if (!chat) return "不明";
  return `${KIND_LABEL[chat.kind]}:${chat.name ?? `チャット#${chat.id}`}`;
}

function formatMessage(m: ChatMessage, chats: Map<number, ChatInfo>): string {
  const text = m.text.replace(/\n/g, "\n    ");
  return `[${m.ref}] ${formatDateTimeJst(m.sentAt)} [${chatLabel(chats, m.chatId)}] ${m.sender}: ${text}`;
}

export function buildUserPrompt(input: ExtractionInput): string {
  const chats = new Map(input.chats.map((c) => [c.id, c]));
  const lines: string[] = [];
  lines.push(`今日: ${input.today}(${weekdayJa(input.today)})`);
  lines.push(`案件: ${input.projectName}`);
  lines.push("");
  lines.push("## チャット");
  for (const c of input.chats) lines.push(`- ${chatLabel(chats, c.id)}`);
  lines.push("");
  lines.push("## メンバー");
  lines.push(input.members.length ? input.members.map((m) => m.name).join(" / ") : "(不明)");
  lines.push("");
  lines.push("## 未完了タスク");
  if (input.openTasks.length === 0) lines.push("(なし)");
  for (const t of input.openTasks) {
    const status = t.status === "candidate" ? "[候補] " : "";
    lines.push(`- task_id=${t.id} ${status}${t.title} / 担当: ${t.assignee ?? "未定"} / 期限: ${t.due ?? "未定"}`);
  }
  if (input.context.length) {
    lines.push("");
    lines.push("## 直前の会話（文脈用・解析済み）");
    for (const m of input.context) lines.push(formatMessage(m, chats));
  }
  lines.push("");
  lines.push("## 新しい会話（これを解析する）");
  for (const m of input.messages) lines.push(formatMessage(m, chats));
  return lines.join("\n");
}

/** AIの出力を検証して型付きの actions にする。形式が崩れた要素は捨てる */
export function parseExtraction(raw: unknown): ExtractedAction[] {
  // deno-lint-ignore no-explicit-any
  const actions = (raw as any)?.actions;
  if (!Array.isArray(actions)) throw new Error("actions がありません");
  const out: ExtractedAction[] = [];
  for (const a of actions) {
    if (!a || !["create", "update", "complete"].includes(a.type)) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    out.push({
      type: a.type,
      task_id: Number.isInteger(a.task_id) ? a.task_id : null,
      title: str(a.title),
      assignee: str(a.assignee),
      due: typeof a.due === "string" && isValidDate(a.due) ? a.due : null,
      evidence_refs: Array.isArray(a.evidence_refs)
        ? a.evidence_refs.filter((r: unknown) => typeof r === "string")
        : [],
      confidence: typeof a.confidence === "number" ? Math.min(1, Math.max(0, a.confidence)) : 0,
      reason: typeof a.reason === "string" ? a.reason : "",
    });
  }
  return out;
}

const HONORIFICS = /(さん|様|さま|氏|くん|君|ちゃん|殿)$/;

function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").replace(HONORIFICS, "").toLowerCase();
}

/** AIが返した担当者名をメンバーに対応付ける。一意に決まらなければ id は null */
export function resolveAssignee(
  name: string | null,
  members: MemberInfo[],
): { id: string | null; name: string | null } {
  if (!name) return { id: null, name: null };
  const target = normalizeName(name);
  if (!target) return { id: null, name };
  const exact = members.filter((m) => normalizeName(m.name) === target);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name };
  const partial = members.filter((m) => {
    const n = normalizeName(m.name);
    return n.length > 0 && (n.includes(target) || target.includes(n));
  });
  if (partial.length === 1) return { id: partial[0].id, name: partial[0].name };
  return { id: null, name: name.replace(HONORIFICS, "") };
}

export const THRESHOLDS = {
  autoCreate: 0.8, // これ以上は自動登録
  candidate: 0.5, // これ以上は候補としてメインチャットで確認
  change: 0.7, // update / complete を反映する下限
};

export type DbOp =
  | {
    op: "create";
    status: "open" | "candidate";
    title: string;
    assignee_id: string | null;
    assignee_name: string | null;
    due_date: string | null;
    confidence: number;
    evidence: string | null;
    source_chat_id: number | null;
  }
  | {
    op: "update";
    task_id: number;
    title?: string;
    assignee_id?: string | null;
    assignee_name?: string;
    due_date?: string;
    confidence: number;
    evidence: string | null;
  }
  | { op: "complete"; task_id: number; confidence: number; evidence: string | null };

const EVIDENCE_MAX = 80;

function evidenceOf(action: ExtractedAction, messages: Map<string, ChatMessage>, chats: Map<number, ChatInfo>) {
  const first = action.evidence_refs.map((r) => messages.get(r)).find((m) => m);
  if (!first) return { evidence: null, chatId: null };
  const text = first.text.replace(/\s+/g, " ").trim();
  const clipped = text.length > EVIDENCE_MAX ? text.slice(0, EVIDENCE_MAX) + "…" : text;
  const kind = chats.get(first.chatId)?.kind ?? "internal";
  return { evidence: `[${KIND_LABEL[kind]}] ${first.sender}「${clipped}」`, chatId: first.chatId };
}

/** 抽出結果を確度で振り分け、DB に適用する操作列に変換する */
export function planOps(actions: ExtractedAction[], input: ExtractionInput): DbOp[] {
  const messages = new Map([...input.context, ...input.messages].map((m) => [m.ref, m]));
  const chats = new Map(input.chats.map((c) => [c.id, c]));
  const openIds = new Set(input.openTasks.map((t) => t.id));
  const touched = new Set<number>();
  const ops: DbOp[] = [];

  for (const a of actions) {
    const { evidence, chatId } = evidenceOf(a, messages, chats);
    if (a.type === "create") {
      if (!a.title || a.confidence < THRESHOLDS.candidate) continue;
      const who = resolveAssignee(a.assignee, input.members);
      ops.push({
        op: "create",
        status: a.confidence >= THRESHOLDS.autoCreate ? "open" : "candidate",
        title: a.title,
        assignee_id: who.id,
        assignee_name: who.name,
        due_date: a.due,
        confidence: a.confidence,
        evidence,
        source_chat_id: chatId,
      });
      continue;
    }

    if (a.task_id === null || !openIds.has(a.task_id) || a.confidence < THRESHOLDS.change) continue;
    if (touched.has(a.task_id) && a.type === "update") continue;

    if (a.type === "complete") {
      ops.push({ op: "complete", task_id: a.task_id, confidence: a.confidence, evidence });
      touched.add(a.task_id);
      continue;
    }

    const op: Extract<DbOp, { op: "update" }> = {
      op: "update",
      task_id: a.task_id,
      confidence: a.confidence,
      evidence,
    };
    const current = input.openTasks.find((t) => t.id === a.task_id)!;
    let changed = false;
    if (a.title && a.title !== current.title) {
      op.title = a.title;
      changed = true;
    }
    if (a.due && a.due !== current.due) {
      op.due_date = a.due;
      changed = true;
    }
    if (a.assignee) {
      const who = resolveAssignee(a.assignee, input.members);
      if (who.name && who.name !== current.assignee) {
        op.assignee_id = who.id;
        op.assignee_name = who.name;
        changed = true;
      }
    }
    if (changed) {
      ops.push(op);
      touched.add(a.task_id);
    }
  }
  return ops;
}

// Claude Opus 5.5 などは、安全分類器による拒否時に別モデルで自動再実行する fallbacks に対応
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export class ExtractionRefusedError extends Error {}

let client: Anthropic | null = null;

export async function extractWithClaude(input: ExtractionInput): Promise<ExtractedAction[]> {
  client ??= new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  const model = optEnv("CLAUDE_MODEL", "claude-opus-5-5");
  const effort = optEnv("CLAUDE_EFFORT", "medium") as "low" | "medium" | "high";
  const useFallback = FALLBACK_MODELS.has(model);

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    system: SYSTEM_PROMPT,
    output_config: {
      effort,
      format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  if (response.stop_reason === "refusal") {
    throw new ExtractionRefusedError(`refused: ${JSON.stringify(response.stop_details)}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("max_tokens に達しました");
  }
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return parseExtraction(JSON.parse(text));
}
