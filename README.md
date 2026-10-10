# washooi_line — LINE案件チャットのタスク自動記録ボット

案件ごとのLINEグループ（制作側・クライアント側）にボットを入れておくと、会話から AI（Claude）が
「誰が・何を・いつまでに」を読み取ってタスクとして記録し、管理用のメインチャットに1日2回（9時・18時）まとめて通知します。

- 案件チャットではコマンド不要。ボットは発言しません
- 1つの案件に複数のチャット（制作チーム用・クライアント連絡用など）をまとめられます
- 「送付しました」などの報告から完了を自動検知します
- 確度が中程度のものは「候補」としてメインチャットに送り、[登録][無視] ボタンで判断します
- 朝9時の通知には、全案件の期限切れ・今日まで・7日以内のタスクのサマリーも付けます
- 会話データは1年間保存します

設計の詳細は [docs/design.md](docs/design.md) を参照してください。

## 構成

```
supabase/
  migrations/
    20261009000000_init.sql   テーブル・DB関数
    20261009000100_cron.sql   定期実行（解析15分ごと / 通知9時・18時 / 1年経過データの削除）
  functions/
    line-webhook/   LINE Webhook（会話の保存、メインチャットのコマンド・ボタン）
    extract/        会話の解析（Claude API）→ タスク記録
    notify/         メインチャットへの通知（9時はサマリー付き、18時）
    _shared/        共通処理とテスト
```

## セットアップ

### 1. LINE

1. [LINE Developers](https://developers.line.biz/) でプロバイダーと **Messaging API チャネル**を作成
2. チャネル設定で以下を控える
   - チャネルシークレット（「チャネル基本設定」）
   - チャネルアクセストークン（長期）（「Messaging API設定」で発行）
3. 「Messaging API設定」で **グループトーク・複数人トークへの参加を許可する** を有効にする
4. LINE Official Account Manager の応答設定で **応答メッセージ・あいさつメッセージをオフ**、**Webhook をオン** にする

### 2. Supabase

```bash
# Supabase CLI をインストールしてログイン後
supabase link --project-ref <project-ref>
supabase db push                       # テーブル・関数・定期実行を作成
cp .env.example .env                   # 値を記入
supabase secrets set --env-file .env
supabase functions deploy              # 4つの関数をデプロイ
```

SQL Editor で、定期実行が関数を呼び出すための値を Vault に登録します（`cron_secret` は `.env` の `CRON_SECRET` と同じ値）。

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET と同じ値>', 'cron_secret');
```

### 3. Webhook の設定

LINE Developers の「Messaging API設定」で Webhook URL を設定し、「検証」→「Webhookの利用」をオンにします。

```
https://<project-ref>.supabase.co/functions/v1/line-webhook
```

### 4. 使い始める

1. ボットを友だち追加して1対1のトークで（または管理用のLINEグループにボットを招待して）`#メイン登録 <MAIN_REGISTER_CODE の値>` と送信
   - 1対1にすると、通知1回あたりの通数が1通で済みます
2. 案件のグループ（制作側・クライアント側）にボットを招待
   - 招待したチャットはグループ名で案件として自動登録され、次の通知でメインチャットに知らされます
3. メインチャットで、同じ案件のチャットをまとめ、クライアント用チャットに種別を設定する

```
チャット一覧
紐付け 3 ABC社 サイト制作      ← チャット#3 を案件「ABC社 サイト制作」へ
紐付け 4 ABC社 サイト制作
種別 4 クライアント
```

## メインチャットのコマンド

| コマンド | 内容 |
|---|---|
| `一覧` / `一覧 案件名` | 未完了タスク |
| `完了 12` / `削除 12` / `戻す 12` | タスクの完了・削除・取り消し（複数指定可） |
| `登録 15` | 候補を登録（カードのボタンでも可） |
| `期限 12 10/20` | 期限変更（`今日` `明日` `なし` も可） |
| `担当 12 田中` | 担当変更 |
| `チャット一覧` / `案件一覧` | ボットが入っているチャット・案件 |
| `紐付け 3 案件名` | チャットを案件にまとめる |
| `種別 3 クライアント` | チャット種別（クライアント / 制作） |
| `案件名 2 新しい名前` | 案件名の変更 |
| `ヘルプ` | 使い方 |

## 設定値（任意）

| 環境変数 | 既定値 | 内容 |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | 解析に使うモデル。費用を抑える場合は `claude-sonnet-5-5` や `claude-haiku-5-5` も指定可（精度とのトレードオフ） |
| `CLAUDE_EFFORT` | `medium` | 解析の深さ（`low` / `medium` / `high`） |
| `EXTRACT_IDLE_MINUTES` | `10` | 最後の発言からこの分数が経ったら解析 |
| `EXTRACT_MIN_PENDING` | `30` | 未解析がこの件数たまったら会話途中でも解析 |
| `EXTRACT_MAX_PROJECTS` | `5` | 1回の実行で解析する案件数の上限（残りは15分後） |

通知の時刻（既定 9:00 と 18:00）は `supabase/migrations/20261009000100_cron.sql` で変更できます。

## 開発

[Deno](https://deno.com/) 2 系を使います。

```bash
deno task check   # 型チェック
deno task test    # テスト
deno lint
```

## 注意事項

- ボットが受け取れるのは参加後の発言のみです（過去ログは読めません）
- 初期版の対象はテキストメッセージのみです（画像・ファイル・スタンプは対象外）
- 会話内容は解析のため Claude API に送信されます。ボットは案件チャットで告知・発言をしません
- メインチャットへの通知はプッシュメッセージのため、LINE公式アカウントの月間無料メッセージ数を消費します（グループへの送信はメンバー数分カウント。1日2回 × 30日 = 60回なので、メインチャットが3人以下なら月180通で無料枠200通に収まる計算です）
