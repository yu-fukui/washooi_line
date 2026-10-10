-- グループ参加時、既存の案件名がグループ名に含まれていれば、その案件に自動で紐付ける
create or replace function register_chat(p_group_id text, p_name text)
returns chats language plpgsql set search_path = public as $$
declare
  v_chat chats;
  v_base text;
  v_name text;
  v_project bigint;
  i int := 1;
begin
  insert into chats (line_group_id, name)
  values (p_group_id, p_name)
  on conflict (line_group_id) do update
    set active = true, name = coalesce(excluded.name, chats.name)
  returning * into v_chat;

  if v_chat.project_id is null then
    -- 既存の案件名がグループ名に含まれていれば、その案件に紐付ける（最も長く一致した案件）
    select id into v_project from projects
    where p_name is not null and char_length(name) >= 2
      and position(lower(normalize(name, NFKC)) in lower(normalize(p_name, NFKC))) > 0
    order by char_length(name) desc
    limit 1;

    if v_project is null then
      v_base := coalesce(nullif(p_name, ''), 'チャット#' || v_chat.id);
      v_name := v_base;
      loop
        insert into projects (name) values (v_name)
        on conflict (name) do nothing
        returning id into v_project;
        exit when v_project is not null;
        i := i + 1;
        v_name := v_base || ' (' || i || ')';
      end loop;
    end if;
    update chats set project_id = v_project where id = v_chat.id returning * into v_chat;
  end if;
  return v_chat;
end $$;
revoke execute on function register_chat(text, text) from public, anon, authenticated;
grant execute on function register_chat(text, text) to service_role;
