-- 定期実行ジョブ（pg_cron は UTC。JST = UTC+9）
-- 事前に Vault に以下を登録しておくこと（README 参照）:
--   project_url : https://<project-ref>.supabase.co
--   cron_secret : Edge Function の CRON_SECRET と同じ値

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function invoke_function(p_name text)
returns bigint language sql security definer set search_path = public as $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/' || p_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000
  )
$$;
revoke execute on function invoke_function(text) from public, anon, authenticated;

-- 会話の解析: 15分ごと
select cron.schedule('extract-tasks', '*/15 * * * *', $$select invoke_function('extract')$$);

-- メインチャットへの通知: 毎時0分、8:00〜21:00 JST（夜間分は朝8時にまとめて送信）
select cron.schedule('notify-main', '0 23,0-12 * * *', $$select invoke_function('notify')$$);

-- 朝のサマリー: 9:00 JST
select cron.schedule('daily-summary', '0 0 * * *', $$select invoke_function('summary')$$);

-- 会話データの保存期間: 1年（毎日 3:00 JST に削除）
select cron.schedule('cleanup-messages', '0 18 * * *', $$
  delete from messages where sent_at < now() - interval '1 year';
  delete from events where notified_at is not null and created_at < now() - interval '1 year';
$$);
