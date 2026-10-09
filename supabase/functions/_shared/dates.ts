// 日付はすべて日本時間（Asia/Tokyo, UTC+9 固定）の YYYY-MM-DD 文字列で扱う
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayJa(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** "2026-10-17" → "10/17(土)"、null → "未定" */
export function formatDue(date: string | null): string {
  if (!date) return "未定";
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}(${weekdayJa(date)})`;
}

/** 時刻を JST の "10/09 14:02" 形式に */
export function formatDateTimeJst(iso: string): string {
  const s = new Date(new Date(iso).getTime() + JST_OFFSET_MS).toISOString();
  return `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}`;
}

/**
 * メインチャットでの期限入力を解釈する。
 * 対応: 今日 / 明日 / 明後日 / 10/20 / 2026/10/20 / 2026-10-20 / なし
 * 年を省略して30日以上前の日付になる場合は翌年とみなす。
 */
export function parseDateInput(input: string, today: string): string | null | undefined {
  const s = input.trim();
  if (["なし", "未定", "-"].includes(s)) return null;
  if (s === "今日") return today;
  if (s === "明日") return addDays(today, 1);
  if (s === "明後日") return addDays(today, 2);
  let m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) {
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isValidDate(date) ? date : undefined;
  }
  m = s.match(/^(\d{1,2})[\/月](\d{1,2})日?$/);
  if (m) {
    let year = Number(today.slice(0, 4));
    let date = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (!isValidDate(date)) return undefined;
    if (date < addDays(today, -30)) {
      year += 1;
      date = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    return isValidDate(date) ? date : undefined;
  }
  return undefined; // 解釈できない
}
