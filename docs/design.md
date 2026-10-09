# LINE案件別タスク管理ボット 設計書（たたき台）

## 1. コンセプト

- **1グループ（案件チャット）＝ 1プロジェクト**。ボットをグループに招待するだけで、そのチャット専用のタスクリストが自動で作られる。
- タスクの追加・完了・一覧はすべて**チャット内の短いコマンド**で行う（覚えることを最小限に）。
- 締切が近いタスクは**ボットが毎朝リマインド**する。
- 個人チャット（ボットとの1:1）では「**自分の担当タスクを全案件横断で**」確認できる。

## 2. 全体構成

```
 ┌───────────────┐   Webhook(POST)   ┌──────────────────────────┐
 │ LINEグループ   │ ───────────────▶ │ Webhookサーバー            │
 │ (案件A/B/C...) │ ◀─────────────── │ (Supabase Edge Function) │
 └───────────────┘  Reply/Push API   │  - 署名検証               │
        ▲                             │  - コマンド解析           │
        │ LIFF(一覧・編集画面 任意)    │  - タスクCRUD             │
        │                             └────────────┬─────────────┘
        │                                          │
 ┌──────┴────────┐                    ┌────────────▼─────────────┐
 │ LIFFアプリ     │ ─────────────────▶│ Supabase Postgres         │
 │ (Vercel 任意)  │                    │ projects/members/tasks   │
 └───────────────┘                    └────────────▲─────────────┘
                                                   │ 毎朝9:00
                                       ┌───────────┴──────────────┐
                                       │ pg_cron → リマインド関数   │
                                       └──────────────────────────┘
```

推奨スタック：**Supabase（DB + Edge Functions + pg_cron）** で一式完結。サーバー管理不要・小規模なら無料枠で運用可能。
（ノーコード寄りにしたい場合は Google Apps Script + スプレッドシートでも同じ設計で組める）

## 3. LINE側の仕組み（押さえるべき仕様）

| 項目 | 内容 |
|---|---|
| グループ参加 | LINE Developersコンソールで「グループトーク・複数人トークへの参加を許可する」をON |
| プロジェクト判定 | Webhookイベントの `source.groupId` をキーにする。`join` イベントでプロジェクトを自動作成 |
| メンバー把握 | グループメンバー一覧APIは認証済/プレミアムアカウント限定のため、**発言した人を都度登録**（`/group/{groupId}/member/{userId}` でプロフィール取得） |
| 担当者指定 | 受信メッセージの `mention.mentionees[].userId` で @メンションされた人を担当者にする |
| 担当者への通知 | 送信は `textV2` メッセージの `{user}` 置換でメンション付き送信 |
| ボタン操作 | Flexメッセージの「完了」ボタン → `postback` イベント（返信扱いなので無料） |
| 料金 | **Reply（返信）は無料・無制限**。**Push（ボットからの自発送信）は月の無料通数を消費**し、グループへのPushは**メンバー人数分**カウントされる → リマインドの設計に影響（§7） |

## 4. 機能とコマンド

グループ内で使うコマンド（先頭の `#` は誤反応防止用。通常会話には反応しない）：

| コマンド例 | 動作 |
|---|---|
| `#追加 見積書作成 @田中 10/15` | タスク追加（担当・期限は省略可） |
| `#一覧` | 未完了タスクをFlexメッセージで表示（各行に「完了」ボタン） |
| `#完了 3` | タスク#3を完了 |
| `#担当 3 @鈴木` | 担当者変更 |
| `#期限 3 10/20` | 期限変更 |
| `#削除 3` | 削除 |
| `#自分` | このグループで自分が担当のタスク |
| `#ヘルプ` | 使い方を表示 |

ボットとの1:1チャット：

| コマンド | 動作 |
|---|---|
| `一覧` | 全案件横断で自分の担当タスク（案件名付き・期限順） |

表示イメージ（`#一覧`）：

```
📋 案件A（未完了 3件）
#3 見積書作成  👤田中  ⏰10/15(水) ⚠明日   [完了]
#5 デザイン確認 👤鈴木  ⏰10/20(月)        [完了]
#6 議事録共有   👤未定  ⏰ -               [完了]
```

タスク番号はグループごとの連番（`#3` のように短く打てる）。

### 拡張案（フェーズ2以降）
- **自然文入力**：「田中さん、金曜までに見積書お願いします」→ AI（Claude API）でタスク候補を抽出し「タスクに登録しますか？[はい][いいえ]」と確認。
- **LIFF画面**：チャット内から開けるタスク一覧・編集画面（並び替え、詳細メモ、完了済み履歴）。
- **外部連携**：Googleカレンダーへの期限登録、スプレッドシート/Notionへのエクスポート。

## 5. データモデル

```sql
-- 案件（= LINEグループ）
create table projects (
  id           uuid primary key default gen_random_uuid(),
  line_group_id text unique not null,
  name         text,                 -- グループ名（グループ概要APIで取得、変更可）
  next_task_no int  not null default 1,
  active       boolean not null default true,  -- leaveイベントでfalse
  created_at   timestamptz not null default now()
);

-- LINEユーザー
create table members (
  line_user_id text primary key,
  display_name text,
  updated_at   timestamptz not null default now()
);

-- 案件とメンバーの所属
create table project_members (
  project_id   uuid references projects(id) on delete cascade,
  line_user_id text references members(line_user_id),
  primary key (project_id, line_user_id)
);

-- タスク
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  task_no      int  not null,        -- グループ内連番（#3など）
  title        text not null,
  assignee_id  text references members(line_user_id),
  due_date     date,
  status       text not null default 'open',   -- open / done
  created_by   text references members(line_user_id),
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, task_no)
);
create index on tasks (assignee_id, status);
create index on tasks (due_date) where status = 'open';
```

## 6. 処理フロー

### 6.1 Webhook受信
1. `x-line-signature` をチャネルシークレットで検証（不一致は403）。
2. イベント種別で分岐：
   - `join` → `projects` 作成、挨拶＋使い方を返信
   - `leave` → `projects.active = false`
   - `message`（text）→ 発言者を `members` / `project_members` にupsert → 先頭が `#` ならコマンド処理 → 結果を **Reply** で返す
   - `postback`（完了ボタン等）→ `action=done&task=<uuid>` を処理 → Reply
3. LINEは即時200応答を求めるため、処理は軽く保つ（AI解析を入れる場合は非同期化を検討）。

### 6.2 コマンド解析
- 正規表現で `#コマンド 本文` を分解。
- 担当者：メッセージ内のメンション情報から取得（テキストの「@田中」文字列ではなく `mentionees` を使う＝同名でも誤らない）。
- 期限：`10/15`、`明日`、`金曜` などを日付に変換（タイムゾーンは Asia/Tokyo 固定）。

### 6.3 リマインド（毎朝9:00 JST）
- `pg_cron` で関数を起動。
- 案件ごとに「今日期限」「期限切れ」「明日期限」のタスクを集計し、**該当があるグループにだけ** 1通にまとめてPush（担当者をメンション）。

## 7. 料金・通数の考え方

- 返信（コマンドへの応答・ボタン操作）は無料なので、**日常操作はコストゼロ**。
- 費用が発生するのはリマインドのPushのみ。グループへのPushは「メンバー数」分カウントされる。
  - 例：10案件 × 平均5人 × 週5日 × 4週 = 月1,000通 → 無料枠（コミュニケーションプランで月200通）を超えるため有料プランが必要。
- 抑制策：
  1. 該当タスクがある案件にだけ送る（上記設計）
  2. リマインドは**グループではなく担当者本人への1:1 Push**にする（1人1通で済む。ただし本人がボットを友だち追加している必要あり）
  3. 頻度を「期限前日＋当日」に限定
- ※料金プランは改定されることがあるので、導入時にLINE公式の最新情報を確認。

## 8. セキュリティ・運用

- チャネルシークレット／アクセストークンは環境変数（Supabase Secrets）で管理。
- グループをまたいだ情報漏えい防止：グループ内コマンドは必ず `line_group_id` でスコープを絞る。1:1の横断一覧は**本人の担当分のみ**。
- LIFFを使う場合、URLに生のgroupIdを載せず、LIFFのIDトークンをサーバーで検証し、そのユーザーが所属する案件のみ返す。
- 既読・会話内容は保存しない（コマンドのみ処理し、通常会話はDBに残さない）。

## 9. 開発ステップ

| フェーズ | 内容 | 目安 |
|---|---|---|
| 1. MVP | Webhook・署名検証、join/leave、`#追加/#一覧/#完了/#ヘルプ`、DB | 2〜3日 |
| 2. 実用化 | 担当者・期限、Flex一覧＋完了ボタン、毎朝リマインド、1:1横断一覧 | 2〜3日 |
| 3. 拡張 | 自然文→AIタスク抽出、LIFF画面、カレンダー連携 | 必要に応じて |

## 10. 決めておきたいこと

1. 案件グループ数・1グループあたりの人数（→ 料金プラン判断）
2. コマンド方式で良いか、自然文（AI）入力が欲しいか
3. リマインドはグループ向けか個人向けか、時刻・頻度
4. 既存ツール（スプレッドシート、Notion、Backlog等）との連携要否
5. 社外メンバー（取引先）がグループにいるか（→ 表示内容の配慮）
