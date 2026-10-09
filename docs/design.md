# LINE案件別タスク自動抽出ボット 設計書（v2）

## 1. コンセプト

- 各**案件グループにボットを入れておくだけ**。メンバーは普段通り会話するだけでよく、コマンドは不要。
- ボットは会話を読み取り、**AIが「誰が・何を・いつまでに」を抽出してタスクとして記録**する。
- 抽出したタスクは案件グループには一切投稿せず、**別の「メインチャット」（管理用）にまとめて送信**する。
- 「送りました」「対応済みです」などの発言から**完了も自動で検知**する。

```
 案件Aグループ ─┐                                   ┌─▶ メインチャット（管理用）
 案件Bグループ ─┼─(会話)─▶ ボット ─▶ AI抽出 ─▶ DB ─┤    ・新規タスク通知
 案件Cグループ ─┘   ※案件グループには発言しない     │    ・完了通知
                                                    └─  ・毎朝の全案件サマリー
```

## 2. 全体構成

```
 ┌──────────────┐ Webhook  ┌───────────────────────┐
 │ 案件グループ群 │────────▶│ webhook 関数            │── 受信メッセージを保存して即200応答
 └──────────────┘          └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ Supabase Postgres       │
                           │ messages / tasks / ...  │
                           └──────────▲────────────┘
                 15分ごと(pg_cron)     │
                           ┌──────────┴────────────┐     ┌─────────────┐
                           │ extract 関数            │────▶│ Claude API   │
                           │ 未処理メッセージ＋既存タスク│◀────│ (JSON出力)   │
                           └──────────┬────────────┘     └─────────────┘
                                      ▼ Push
                           ┌───────────────────────┐
                           │ メインチャット           │◀── ボタン操作(postback)は webhook 関数で処理
                           └───────────────────────┘
```

推奨スタック：**Supabase（DB / Edge Functions / pg_cron）＋ Claude API**。

## 3. メインチャットの作り方

2通りから選択：

| 方式 | 内容 | Push通数 |
|---|---|---|
| A. 管理用グループ | 「タスク管理」グループを作りボットと管理者を入れる。そこで一度だけ `#メイン登録` と送ると登録される | グループ人数分 × 送信回数 |
| B. 個人チャット | 管理者がボットを友だち追加し、1:1トークで `#メイン登録` | 1通 × 送信回数 |

※ `#メイン登録` は初期設定用の唯一のコマンド。メインチャット以外では通常のコマンドは使わない。

## 4. タスク抽出の仕組み

### 4.1 なぜ「1メッセージごと」ではなく「まとめて」解析するか
- 「これお願いできますか？」→「了解です、金曜までに」のように、**タスクは複数の発言にまたがって成立する**。
- 1発言ずつAIにかけるとコストが高く、文脈不足で誤検出も増える。

### 4.2 解析タイミング
15分ごとに、未処理メッセージがあるグループのうち以下に該当するものを解析：
- 最後の発言から**10分以上経過**（会話が一段落した）、または
- 未処理メッセージが**30件以上**たまった

### 4.3 AIに渡す情報
```
- 今日の日付（Asia/Tokyo）
- 案件名
- メンバー一覧（表示名 ↔ userId）
- この案件の未完了タスク一覧（id, 内容, 担当, 期限）
- 直前の処理済みメッセージ数件（文脈用）
- 新しいメッセージ（id, 時刻, 発言者, 本文, メンション先）
```

### 4.4 AIからの出力（JSONで受け取る）
```json
{
  "actions": [
    {"type": "create", "title": "見積書を作成して送付", "assignee": "田中",
     "due": "2026-10-17", "evidence_message_ids": ["m123","m125"], "confidence": 0.92},
    {"type": "update", "task_id": "t45", "due": "2026-10-20",
     "evidence_message_ids": ["m130"], "confidence": 0.85},
    {"type": "complete", "task_id": "t41",
     "evidence_message_ids": ["m131"], "confidence": 0.88}
  ]
}
```
- **create**：新規タスク（依頼＋引き受け、自分で宣言した作業、期限付きの約束など）
- **update**：既存タスクの期限・担当・内容の変更
- **complete**：「送付しました」「完了です」など完了の報告
- 既存タスク一覧を渡すので**同じタスクの二重登録を防げる**。

### 4.5 確度による扱い分け
| 確度 | 扱い |
|---|---|
| 高（0.8以上） | 自動で登録・更新し、メインチャットに通知 |
| 中（0.5〜0.8） | 「候補」としてメインチャットに送り、[登録][無視] ボタンで人が判断 |
| 低（0.5未満） | 捨てる |

閾値は運用しながら調整。

## 5. メインチャットへの通知

### 5.1 抽出時の通知（解析ごとに1通にまとめる）
```
🆕 案件A｜新規タスク 2件
・見積書を作成して送付
  👤田中 ⏰10/17(金)
  💬「金曜までに見積書お送りします」
・現地調査の日程調整
  👤鈴木 ⏰未定
  [完了] [修正] [削除]

✅ 案件B｜完了 1件
・デザイン初稿の提出（👤佐藤）

❓ 案件C｜タスク候補 1件
・ロゴデータの再送？  [登録] [無視]
```
- 根拠となった発言を短く引用し、誤検出をすぐ判断できるようにする。
- ボタン操作は「返信」扱いなので無料。

### 5.2 毎朝のサマリー（9:00）
```
📋 本日のタスク（全5案件・未完了12件）
⚠ 期限切れ 2件
  ・[案件A] 請求書送付 👤田中（10/8）
⏰ 今日期限 3件
  ...
📅 今週 4件
  ...
```

### 5.3 メインチャットでの操作
- ボタン：[完了][削除][登録][無視]
- 必要に応じて簡単な文字入力も受け付ける：`一覧`、`案件A`（その案件の未完了一覧）、`田中`（担当者別）

## 6. データモデル

```sql
create table settings (
  key   text primary key,      -- 'main_chat_id', 'main_chat_type'
  value text not null
);

create table projects (
  id             uuid primary key default gen_random_uuid(),
  line_group_id  text unique not null,
  name           text,                    -- グループ概要APIで取得
  active         boolean not null default true,
  last_message_at timestamptz,
  created_at     timestamptz not null default now()
);

create table members (
  line_user_id text primary key,
  display_name text,
  updated_at   timestamptz not null default now()
);

create table project_members (
  project_id   uuid references projects(id) on delete cascade,
  line_user_id text references members(line_user_id),
  primary key (project_id, line_user_id)
);

-- 会話バッファ（解析後、一定期間で削除）
create table messages (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  line_message_id text unique not null,   -- 再送による重複防止
  sender_id     text references members(line_user_id),
  text          text not null,
  mentions      jsonb,                    -- [{userId, index, length}]
  sent_at       timestamptz not null,
  processed_at  timestamptz
);
create index on messages (project_id, processed_at);

create table tasks (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  title         text not null,
  assignee_id   text references members(line_user_id),
  assignee_name text,                     -- メンバー未登録の人（AIが名前だけ拾った場合）
  due_date      date,
  status        text not null default 'open',  -- candidate / open / done / dismissed
  confidence    real,
  evidence      text,                     -- 根拠発言の引用
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index on tasks (status, due_date);

-- 変更履歴（AIによる変更・人の操作を追跡）
create table task_events (
  id         bigserial primary key,
  task_id    uuid references tasks(id) on delete cascade,
  kind       text not null,               -- created / updated / completed / dismissed
  actor      text not null,               -- 'ai' or line_user_id
  detail     jsonb,
  created_at timestamptz not null default now()
);
```

## 7. 処理フロー

### 7.1 webhook 関数
1. `x-line-signature` を検証。
2. イベント別処理：
   - `join`（案件グループ）→ `projects` 作成。**案件グループには何も発言しない**（任意で初回のみ「タスク記録のため会話を解析します」と告知するかは§9参照）。メインチャットに「案件◯◯にボットが追加されました」と通知。
   - `leave` → `active=false`
   - `message`（text）
     - メインチャットからなら操作コマンドとして処理（Reply）
     - 案件グループからなら発言者をupsertし、`messages` に保存するだけ
   - `postback`（メインチャットのボタン）→ タスク更新 → Reply
3. すぐに200を返す（AI処理はここではしない）。

### 7.2 extract 関数（pg_cron 15分ごと）
1. §4.2の条件に合うグループを抽出。
2. グループごとにAIを呼び出し、結果のactionsをトランザクションで反映。
3. 対象メッセージに `processed_at` をセット。
4. 全グループ分の結果を**1通にまとめて**メインチャットへPush（変化がなければ送らない）。

### 7.3 summary 関数（pg_cron 毎朝9:00 JST）
未完了タスクを集計してメインチャットへPush。

### 7.4 cleanup（毎日）
処理済みの `messages` を**30日経過で削除**（期間は要相談）。

## 8. 料金の目安

| 項目 | 内容 |
|---|---|
| LINE | 案件グループには発言しないので**送信コストはメインチャットへのPushのみ**。1:1方式（§3-B）なら1回1通。例：解析通知 1日10回＋朝サマリー1回 × 平日22日 ≒ **月240通** → 無料枠(月200通)を少し超える程度。通知を「1時間ごとにまとめる」等で無料枠内にも収められる |
| Claude API | 15分単位でまとめて解析するため呼び出し回数は控えめ。抽出は軽量モデル（Haiku）で開始し、精度不足なら上位モデル（Sonnet）に切替 |
| Supabase | 小規模なら無料枠内 |

※LINE・Claude API とも料金は改定されるため、導入時に最新情報を確認。

## 9. 注意点

- **過去ログは読めない**：ボットはグループ参加以降の発言しか受け取れない。
- **画像・ファイル・スタンプ**は初期版では対象外（テキストのみ）。音声やPDFの内容解析はフェーズ3で検討。
- **プライバシー**：会話内容を外部AIに送信することになる。特に**取引先など社外の人がいるグループ**では、参加者への告知や同意をどうするか事前に決めておく。ボットのアカウント自体は参加者から見える。
- 誤検出・見逃しはゼロにはならない → 「候補」ボタンと根拠引用で人が最終確認できる設計にしている。
- 1グループで1日に大量の発言がある場合は、解析コストを見て間隔や件数閾値を調整。

## 10. 開発ステップ

| フェーズ | 内容 |
|---|---|
| 1. MVP | Webhook・署名検証、メッセージ保存、メインチャット登録、AI抽出（create のみ）、メインチャット通知 |
| 2. 実用化 | update/complete 検知、確度による候補化＋ボタン操作、毎朝サマリー、メッセージ自動削除 |
| 3. 拡張 | LIFFでのタスク一覧画面、画像・PDF解析、Googleカレンダー/スプレッドシート連携 |

## 11. 決めておきたいこと

1. メインチャットは「管理用グループ」か「個人の1:1」か（見る人は1人か複数か）
2. 通知の頻度（解析ごと／1時間ごと／1日数回）
3. 自動登録してよいか、すべて「候補」として人が承認する方が良いか
4. 社外メンバーがいるグループでの告知・同意の扱い
5. 会話データの保存期間
