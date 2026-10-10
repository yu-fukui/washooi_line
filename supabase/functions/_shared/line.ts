// LINE Messaging API の薄いラッパー
import { env } from "./env.ts";

const API = "https://api.line.me/v2/bot";
const encoder = new TextEncoder();

// deno-lint-ignore no-explicit-any
export type LineMessage = Record<string, any>;

export interface LineEvent {
  type: string;
  timestamp: number;
  replyToken?: string;
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: { type: string; id: string; text?: string };
  postback?: { data: string };
  unsend?: { messageId: string };
}

/** x-line-signature を検証する（HMAC-SHA256 / Base64） */
export async function verifySignature(
  body: string,
  signature: string | null,
  channelSecret: string,
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("LINE_CHANNEL_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`LINE API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/** 返信（無料）。1回に最大5メッセージ */
export async function reply(replyToken: string, messages: LineMessage[]): Promise<void> {
  await call("/message/reply", {
    method: "POST",
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
}

/** プッシュ（通数を消費）。retryKey を渡すと再送時の二重送信を防げる */
export async function push(to: string, messages: LineMessage[], retryKey?: string): Promise<void> {
  await call("/message/push", {
    method: "POST",
    headers: retryKey ? { "X-Line-Retry-Key": retryKey } : {},
    body: JSON.stringify({ to, messages: messages.slice(0, 5) }),
  });
}

export async function getGroupMemberName(groupId: string, userId: string): Promise<string | null> {
  try {
    const res = await call(`/group/${groupId}/member/${userId}`);
    return (await res.json()).displayName ?? null;
  } catch (e) {
    console.warn(e);
    return null;
  }
}

export async function getGroupName(groupId: string): Promise<string | null> {
  try {
    const res = await call(`/group/${groupId}/summary`);
    return (await res.json()).groupName ?? null;
  } catch (e) {
    console.warn(e);
    return null;
  }
}

/** ユーザー（1対1トーク）にリッチメニューを表示する */
export async function linkRichMenu(userId: string, richMenuId: string): Promise<void> {
  await call(`/user/${userId}/richmenu/${richMenuId}`, { method: "POST" });
}

/** リッチメニューを作成して画像をアップロードし、ID を返す */
export async function createRichMenu(menu: LineMessage, image: Uint8Array<ArrayBuffer>): Promise<string> {
  const res = await call("/richmenu", { method: "POST", body: JSON.stringify(menu) });
  const { richMenuId } = await res.json();
  const upload = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("LINE_CHANNEL_ACCESS_TOKEN")}`, "Content-Type": "image/png" },
    body: image,
  });
  if (!upload.ok) throw new Error(`rich menu image upload failed: ${upload.status} ${await upload.text()}`);
  return richMenuId;
}

const TEXT_LIMIT = 5000;

/** 長文を LINE のテキスト上限（5000字）で行単位に分割し、テキストメッセージにする */
export function textMessages(text: string, maxMessages = 5): LineMessage[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > TEXT_LIMIT ? line.slice(0, TEXT_LIMIT - 1) + "…" : line;
    if (current.length + piece.length + 1 > TEXT_LIMIT) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > maxMessages) {
    chunks.length = maxMessages;
    chunks[maxMessages - 1] = chunks[maxMessages - 1].slice(0, TEXT_LIMIT - 20) + "\n…(以下省略)";
  }
  return chunks.map((t) => ({ type: "text", text: t }));
}
