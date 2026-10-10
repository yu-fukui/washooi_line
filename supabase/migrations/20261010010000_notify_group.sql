-- 毎朝6時の通知先グループ（メインチャットとは別に設定できる）。
-- そのグループが案件チャットとして登録済みなら取り除く。
create function set_notify_group(p_group_id text)
returns void language plpgsql set search_path = public as $$
declare
  v_project bigint;
begin
  delete from chats where line_group_id = p_group_id returning project_id into v_project;
  if v_project is not null
     and not exists (select 1 from chats where project_id = v_project)
     and not exists (select 1 from tasks where project_id = v_project) then
    delete from projects where id = v_project;
  end if;

  insert into settings (key, value) values ('notify_group_id', p_group_id)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

revoke execute on function set_notify_group(text) from public, anon, authenticated;
grant execute on function set_notify_group(text) to service_role;
