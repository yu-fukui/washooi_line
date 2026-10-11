import { assert } from "jsr:@std/assert@1.0.13";
import { isSmallTalk } from "./smalltalk.ts";

Deno.test("isSmallTalk: お礼・あいづち・あいさつ・絵文字だけ", () => {
  for (
    const t of [
      "ありがとうございます",
      "ありがとうございます🙏",
      "ありがとう😊",
      "了解です！",
      "承知しました",
      "OK",
      "よろしくお願いします(よろしく)",
      "お疲れ様です",
      "おはようございます",
      "すごっ！",
      "🙇‍♂️",
      "ありがとうございます！よろしくお願いします",
      "(emoji)(emoji)",
    ]
  ) assert(isSmallTalk(t), t);
});

Deno.test("isSmallTalk: 依頼・報告・予定は対象外", () => {
  for (
    const t of [
      "承知しました、金曜までに送ります",
      "了解です。明日修正版を出します",
      "12は確認待ち",
      "2済",
      "ありがとうございます。来週の撮影は10/20でお願いします",
      "動画データこちらに送ってください",
      "7日の13時はいかがでしょうか？",
    ]
  ) assert(!isSmallTalk(t), t);
});
