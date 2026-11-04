// 通知先グループで、ボット宛ての発言（@メンション、または「ボット」「ワッショイ」で始まる文）を見分ける
import type { LineEvent } from "./line.ts";

const CALL_PREFIX = /^(?:ボット|bot|ワッショイ|わっしょい)[\s、,:：]+/i;

/** ボット宛てなら呼びかけ部分を除いた本文を返す。ボット宛てでなければ null */
export function botCall(message: LineEvent["message"]): string | null {
  const text = message?.text;
  if (!text) return null;
  const self = message.mention?.mentionees?.find((m) => m.isSelf);
  if (self) {
    const rest = (text.slice(0, self.index) + text.slice(self.index + self.length)).trim();
    return rest || null;
  }
  const normalized = text.normalize("NFKC").trim();
  const m = normalized.match(CALL_PREFIX);
  if (!m) return null;
  return normalized.slice(m[0].length).trim() || null;
}
