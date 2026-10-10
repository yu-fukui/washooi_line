// メインチャットで受け付けるテキストコマンドの解析
export type Command =
  | { type: "help" }
  | { type: "list"; keyword: string | null }
  | { type: "chats" }
  | { type: "projects" }
  | { type: "pickProject" }
  | { type: "status"; action: "done" | "delete" | "reopen" | "approve"; taskIds: number[] }
  | { type: "due"; taskId: number; value: string }
  | { type: "assign"; taskId: number; name: string }
  | { type: "link"; chatId: number; projectName: string }
  | { type: "kind"; chatId: number; kind: "internal" | "client" }
  | { type: "rename"; projectId: number; name: string };

const STATUS_VERBS: Record<string, "done" | "delete" | "reopen" | "approve"> = {
  完了: "done",
  削除: "delete",
  戻す: "reopen",
  登録: "approve",
};

function ids(text: string): number[] {
  return [...text.matchAll(/#?(\d+)/g)].map((m) => Number(m[1]));
}

/** コマンドでなければ null（メインチャットでの普通の会話には反応しない） */
export function parseCommand(input: string): Command | null {
  const text = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (/^(ヘルプ|help|使い方)$/i.test(text)) return { type: "help" };
  if (/^(チャット一覧|チャット)$/.test(text)) return { type: "chats" };
  if (/^案件一覧$/.test(text)) return { type: "projects" };
  if (/^(案件|クライアント|案件を選ぶ)$/.test(text)) return { type: "pickProject" };

  let m = text.match(/^一覧(?: (.+))?$/);
  if (m) return { type: "list", keyword: m[1] ?? null };

  m = text.match(/^(完了|削除|戻す|登録) ((?:#?\d+[ ,、]*)+)$/);
  if (m) return { type: "status", action: STATUS_VERBS[m[1]], taskIds: ids(m[2]) };

  m = text.match(/^期限 #?(\d+) (.+)$/);
  if (m) return { type: "due", taskId: Number(m[1]), value: m[2] };

  m = text.match(/^担当 #?(\d+) (.+)$/);
  if (m) return { type: "assign", taskId: Number(m[1]), name: m[2].replace(/^@/, "") };

  m = text.match(/^紐付け #?(\d+) (.+)$/);
  if (m) return { type: "link", chatId: Number(m[1]), projectName: m[2] };

  m = text.match(/^種別 #?(\d+) (クライアント|制作|社内)$/);
  if (m) return { type: "kind", chatId: Number(m[1]), kind: m[2] === "クライアント" ? "client" : "internal" };

  m = text.match(/^案件名 #?(\d+) (.+)$/);
  if (m) return { type: "rename", projectId: Number(m[1]), name: m[2] };

  return null;
}

export const HELP_TEXT = `📖 使い方（メインチャット）

■ タスク
一覧 … 全案件の未完了タスク
一覧 案件名 … 案件で絞り込み
完了 12 … タスク#12を完了（複数可: 完了 12 13）
削除 12 … タスクを削除
戻す 12 … 完了・削除を取り消し
登録 15 … 候補のタスクを登録
期限 12 10/20 … 期限変更（今日/明日/なし も可）
担当 12 田中 … 担当変更

■ 普通の文章でもOK
「1は16日で時間未定、2は済」「波多野さんの動画確認終わった」
「エースに『11月撮影日の確定』を追加」のように送ると、AIが読み取って修正し、結果を返信します

■ チャットと案件
案件 … 案件（クライアント）を選んで詳細を表示（リッチメニューの「案件を選ぶ」でも可）
チャット一覧 … ボットが入っているチャット
案件一覧 … 案件の一覧
紐付け 3 案件名 … チャット#3を案件に紐付け（制作・クライアントのチャットを1案件にまとめる）
種別 3 クライアント … チャットの種別（クライアント/制作）
案件名 2 新しい名前 … 案件名の変更

※ 案件チャットの会話は15分ごとに解析し、結果を1日2回（6時・18時）ここへ通知します。`;
