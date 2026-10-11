// お礼・あいづち・あいさつだけの発言を見分ける（AI を呼ばずに済ませて費用を抑える）

// 正規表現の選択は左から順に試すため、長い言い回しを先に書く
const PHRASES = [
  "ありがとう(ございました|ございます)?|ありがと",
  "あざっす|あざす",
  "感謝(します|です)?",
  "助かり(ました|ます)",
  "了解(いたしました|しました|です)?",
  "りょうかい|りょ",
  "承知(いたしました|致しました|しました|です)?",
  "かしこまりました",
  "わかりました|分かりました",
  "okです|ok|オッケー|おけ|おk",
  "はーい|はい|うん",
  "よろしく(お願い(いたします|致します|します))?",
  "お疲れ様(でした|です)?|おつかれさま(でした|です)?|おつかれ(です)?|お疲れ(です)?",
  "おはよう(ございます)?|こんにちは|こんばんは",
  "いいですね|いいね|すごい|すごっ|さすが|最高",
  "笑|w+|草",
].join("|");

// 先頭からお決まりの言い回しを1つずつ取り除いていき、全部なくなればあいづちだけ
const PREFIX = new RegExp(`^(?:${PHRASES})`, "i");

/** 記号・絵文字・LINEの絵文字表記「(よろしく)」などを取り除いた本文 */
function core(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\([^()]{1,10}\)/g, "") // LINE の絵文字・スタンプの代替表記 例: (よろしく)(emoji)
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, "")
    .replace(/[\s!！?？。、,.・〜~ー…♪☆★]+/g, "")
    .toLowerCase();
}

/** お礼・あいづち・あいさつ・絵文字だけの短い発言なら true */
export function isSmallTalk(text: string): boolean {
  if (text.length > 40) return false;
  const c = core(text);
  if (c === "") return true; // 絵文字・記号だけ
  // 「ありがとうございます！よろしくお願いします」のような組み合わせも許す
  let rest = c;
  while (rest) {
    const m = rest.match(PREFIX);
    if (!m || m[0] === "") return false;
    rest = rest.slice(m[0].length);
  }
  return true;
}
