import { assertEquals } from "jsr:@std/assert@1.0.13";
import { parseCommand } from "./commands.ts";

Deno.test("parseCommand: タスク操作", () => {
  assertEquals(parseCommand("完了 12"), { type: "status", action: "done", taskIds: [12] });
  assertEquals(parseCommand("完了 #12 13"), { type: "status", action: "done", taskIds: [12, 13] });
  assertEquals(parseCommand("削除　１２"), { type: "status", action: "delete", taskIds: [12] }); // 全角
  assertEquals(parseCommand("登録 15"), { type: "status", action: "approve", taskIds: [15] });
  assertEquals(parseCommand("期限 12 10/20"), { type: "due", taskId: 12, value: "10/20" });
  assertEquals(parseCommand("担当 12 @田中"), { type: "assign", taskId: 12, name: "田中" });
});

Deno.test("parseCommand: 一覧・チャット・案件", () => {
  assertEquals(parseCommand("一覧"), { type: "list", keyword: null });
  assertEquals(parseCommand("一覧 案件A"), { type: "list", keyword: "案件A" });
  assertEquals(parseCommand("チャット一覧"), { type: "chats" });
  assertEquals(parseCommand("案件一覧"), { type: "projects" });
  assertEquals(parseCommand("紐付け 3 ABC社 サイト制作"), { type: "link", chatId: 3, projectName: "ABC社 サイト制作" });
  assertEquals(parseCommand("種別 3 クライアント"), { type: "kind", chatId: 3, kind: "client" });
  assertEquals(parseCommand("種別 3 制作"), { type: "kind", chatId: 3, kind: "internal" });
  assertEquals(parseCommand("案件名 2 新しい名前"), { type: "rename", projectId: 2, name: "新しい名前" });
  assertEquals(parseCommand("ヘルプ"), { type: "help" });
});

Deno.test("parseCommand: 普通の会話には反応しない", () => {
  assertEquals(parseCommand("お疲れさまです"), null);
  assertEquals(parseCommand("完了しました！"), null);
  assertEquals(parseCommand("一覧表を作りました"), null);
  assertEquals(parseCommand("種別 3 その他"), null);
});

Deno.test("parseCommand: 案件の選択", () => {
  assertEquals(parseCommand("案件"), { type: "pickProject" });
  assertEquals(parseCommand("クライアント"), { type: "pickProject" });
  assertEquals(parseCommand("案件を選ぶ"), { type: "pickProject" });
});
