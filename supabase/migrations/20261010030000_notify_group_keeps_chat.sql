-- 通知先グループは案件チャットとしても使う（チャットを削除せず、通知先の設定だけ行う）
create or replace function set_notify_group(p_group_id text)
returns void language plpgsql set search_path = public as $$
begin
  insert into settings (key, value) values ('notify_group_id', p_group_id)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

revoke execute on function set_notify_group(text) from public, anon, authenticated;
grant execute on function set_notify_group(text) to service_role;
