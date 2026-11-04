import { assertEquals } from "jsr:@std/assert@1.0.13";
import { botCall } from "./botcall.ts";

const msg = (text: string, mentionees?: { index: number; length: number; isSelf?: boolean }[]) => ({
  type: "text",
  id: "1",
  text,
  ...(mentionees ? { mention: { mentionees } } : {}),
});

Deno.test("botCall: ボットへのメンションを取り除いた本文を返す", () => {
  assertEquals(botCall(msg("@AI ワッショイ 12は済", [{ index: 0, length: 9, isSelf: true }])), "12は済");
  assertEquals(botCall(msg("12は済 @AI ワッショイ", [{ index: 5, length: 9, isSelf: true }])), "12は済");
});

Deno.test("botCall: 呼びかけの言葉で始まる文も受け付ける", () => {
  assertEquals(botCall(msg("ボット、エースの撮影日は11/5")), "エースの撮影日は11/5");
  assertEquals(botCall(msg("ワッショイ 12は済")), "12は済");
  assertEquals(botCall(msg("bot: 一覧")), "一覧");
});

Deno.test("botCall: ボット宛てでない発言は null", () => {
  assertEquals(botCall(msg("12は済")), null);
  assertEquals(botCall(msg("@小西 確認お願いします", [{ index: 0, length: 3 }])), null);
  assertEquals(botCall(msg("ボットの通知見ました")), null);
  assertEquals(botCall(msg("@AI ワッショイ", [{ index: 0, length: 9, isSelf: true }])), null);
  assertEquals(botCall(undefined), null);
});
