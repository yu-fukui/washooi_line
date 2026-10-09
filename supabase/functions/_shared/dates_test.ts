import { assertEquals } from "jsr:@std/assert@1.0.13";
import { addDays, formatDateTimeJst, formatDue, parseDateInput, todayJst } from "./dates.ts";

Deno.test("todayJst は UTC+9 で日付を切り替える", () => {
  assertEquals(todayJst(new Date("2026-10-09T14:59:00Z")), "2026-10-09");
  assertEquals(todayJst(new Date("2026-10-09T15:00:00Z")), "2026-10-10");
});

Deno.test("formatDue", () => {
  assertEquals(formatDue("2026-10-17"), "10/17(土)");
  assertEquals(formatDue(null), "未定");
});

Deno.test("formatDateTimeJst", () => {
  assertEquals(formatDateTimeJst("2026-10-09T05:02:00Z"), "10/09 14:02");
});

Deno.test("addDays は月をまたげる", () => {
  assertEquals(addDays("2026-10-31", 1), "2026-11-01");
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
});

Deno.test("parseDateInput", () => {
  const today = "2026-10-09";
  assertEquals(parseDateInput("今日", today), "2026-10-09");
  assertEquals(parseDateInput("明日", today), "2026-10-10");
  assertEquals(parseDateInput("10/20", today), "2026-10-20");
  assertEquals(parseDateInput("10月20日", today), "2026-10-20");
  assertEquals(parseDateInput("1/15", today), "2027-01-15"); // 過去すぎる日付は翌年
  assertEquals(parseDateInput("9/20", today), "2026-09-20"); // 少し前は今年のまま
  assertEquals(parseDateInput("2026/12/1", today), "2026-12-01");
  assertEquals(parseDateInput("なし", today), null);
  assertEquals(parseDateInput("2/30", today), undefined);
  assertEquals(parseDateInput("来週", today), undefined);
});
