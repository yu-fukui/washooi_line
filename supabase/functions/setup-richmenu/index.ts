// リッチメニューを作成し、メインチャット（1対1トーク）のユーザーに表示する。
// 初回や画像変更時に1回だけ実行する（本文に PNG 画像 1200x405 を送る）:
//   curl -X POST -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: image/png" \
//     --data-binary @assets/richmenu.png https://<project-ref>.supabase.co/functions/v1/setup-richmenu
import { db, getSetting, must } from "../_shared/db.ts";
import { isCronRequest, json } from "../_shared/env.ts";
import { createRichMenu, linkRichMenu } from "../_shared/line.ts";

const W = 1200;
const H = 405;
const cell = W / 3;

const MENU = {
  size: { width: W, height: H },
  selected: true,
  name: "main-menu",
  chatBarText: "メニュー",
  areas: [
    {
      bounds: { x: 0, y: 0, width: cell, height: H },
      action: { type: "postback", data: "action=projects&page=0", displayText: "案件を選ぶ" },
    },
    {
      bounds: { x: cell, y: 0, width: cell, height: H },
      action: { type: "message", text: "一覧" },
    },
    {
      bounds: { x: cell * 2, y: 0, width: cell, height: H },
      action: { type: "postback", data: "action=help", displayText: "ヘルプ" },
    },
  ],
};

Deno.serve(async (req) => {
  if (!isCronRequest(req)) return json({ error: "unauthorized" }, 401);
  const sb = db();
  const image = new Uint8Array(await req.arrayBuffer());
  if (image.length === 0) return json({ error: "本文にリッチメニュー画像（PNG）を送ってください" }, 400);
  const richMenuId = await createRichMenu(MENU, image);
  must(
    await sb.from("settings").upsert({ key: "richmenu_id", value: richMenuId, updated_at: new Date().toISOString() }),
  );

  const mainId = await getSetting(sb, "main_group_id");
  const linked = !!mainId && mainId.startsWith("U");
  if (linked) await linkRichMenu(mainId!, richMenuId);
  return json({ richMenuId, linkedToMainUser: linked });
});
