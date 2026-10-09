-- 案件(projects) ─< チャット(chats: 制作側/クライアント側) ─< メッセージ(messages)
-- 案件 ─< タスク(tasks)、変更履歴と通知キューを兼ねる events

create table settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table projects (
  id         bigint generated always as identity primary key,  -- 案件#
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table chats (
  id              bigint generated always as identity primary key,  -- チャット#
  line_group_id   text not null unique,
  name            text,
  project_id      bigint references projects(id) on delete set null,
  kind            text not null default 'internal' check (kind in ('internal', 'client')),
  active          boolean not null default true,
  last_message_at timestamptz,
  created_at      timestamptz not null default now()
);
create index on chats (project_id);

create table members (
  line_user_id text primary key,
  display_name text not null,
  updated_at   timestamptz not null default now()
);

create table chat_members (
  chat_id      bigint not null references chats(id) on delete cascade,
  line_user_id text not null references members(line_user_id) on delete cascade,
  primary key (chat_id, line_user_id)
);

-- 会話バッファ。解析後も1年間保持（cleanup ジョブで削除）
create table messages (
  id              bigint generated always as identity primary key,
  chat_id         bigint not null references chats(id) on delete cascade,
  line_message_id text not null unique,          -- Webhook再送時の重複防止
  sender_id       text references members(line_user_id) on delete set null,
  text            text not null,
  sent_at         timestamptz not null,
  processed_at    timestamptz
);
create index on messages (chat_id, processed_at, sent_at);
create index on messages (sent_at);

create table tasks (
  id             bigint generated always as identity primary key,  -- タスク#
  project_id     bigint not null references projects(id) on delete cascade,
  source_chat_id bigint references chats(id) on delete set null,
  title          text not null,
  assignee_id    text references members(line_user_id) on delete set null,
  assignee_name  text,
  due_date       date,
  status         text not null default 'open'
                 check (status in ('candidate', 'open', 'done', 'dismissed')),
  confidence     real,
  evidence       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index on tasks (project_id, status);
create index on tasks (status, due_date);

-- タスクの変更履歴 + メインチャットへの通知キュー（notified_at が null のものを毎時送信）
create table events (
  id          bigint generated always as identity primary key,
  project_id  bigint references projects(id) on delete cascade,
  chat_id     bigint references chats(id) on delete cascade,
  task_id     bigint references tasks(id) on delete cascade,
  kind        text not null,   -- created / candidate / updated / completed / chat_joined / chat_left / manual_*
  actor       text not null,   -- 'ai' / 'system' / LINEユーザーID
  detail      jsonb,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index on events (id) where notified_at is null;

-- Edge Functions は service_role で接続するため、それ以外からのアクセスはすべて拒否
alter table settings      enable row level security;
alter table projects      enable row level security;
alter table chats         enable row level security;
alter table members       enable row level security;
alter table chat_members  enable row level security;
alter table messages      enable row level security;
alter table tasks         enable row level security;
alter table events        enable row level security;

-- グループ参加時（または未登録グループからの初回メッセージ時）にチャットを登録。
-- 案件が未設定なら、グループ名で案件を自動作成する（同名があれば連番を付与）。
create function register_chat(p_group_id text, p_name text)
returns chats language plpgsql as $$
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
    update chats set project_id = v_project where id = v_chat.id returning * into v_chat;
  end if;
  return v_chat;
end $$;

-- チャットを別の案件に紐付ける（案件が無ければ作成）。
-- 元の案件にチャットが残らなければ、タスクを移して元の案件を削除する。
create function link_chat(p_chat_id bigint, p_project_name text)
returns bigint language plpgsql as $$
declare
  v_old bigint;
  v_new bigint;
begin
  select project_id into v_old from chats where id = p_chat_id for update;
  if not found then
    raise exception 'chat_not_found';
  end if;

  insert into projects (name) values (p_project_name)
  on conflict (name) do update set name = excluded.name
  returning id into v_new;

  update chats set project_id = v_new where id = p_chat_id;

  if v_old is not null and v_old <> v_new
     and not exists (select 1 from chats where project_id = v_old) then
    update tasks  set project_id = v_new where project_id = v_old;
    update events set project_id = v_new where project_id = v_old;
    delete from projects where id = v_old;
  end if;
  return v_new;
end $$;

-- メインチャットの登録。そのグループが案件チャットとして登録済みなら取り除く。
create function set_main_group(p_group_id text)
returns void language plpgsql as $$
declare
  v_project bigint;
begin
  delete from chats where line_group_id = p_group_id returning project_id into v_project;
  if v_project is not null
     and not exists (select 1 from chats where project_id = v_project)
     and not exists (select 1 from tasks where project_id = v_project) then
    delete from projects where id = v_project;
  end if;

  insert into settings (key, value) values ('main_group_id', p_group_id)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- 解析対象の案件: 未処理メッセージがあり、会話が一段落した or 件数がたまった案件
create function projects_due_for_extraction(p_idle_minutes int, p_min_count int)
returns table (project_id bigint, pending bigint) language sql stable as $$
  select c.project_id, count(*) as pending
  from messages m
  join chats c on c.id = m.chat_id
  where m.processed_at is null and c.project_id is not null
  group by c.project_id
  having max(m.sent_at) < now() - make_interval(mins => p_idle_minutes)
      or count(*) >= p_min_count
  order by min(m.sent_at)
$$;

-- AIの抽出結果を1トランザクションで反映し、対象メッセージを処理済みにする
create function apply_extraction(p_project_id bigint, p_message_ids bigint[], p_ops jsonb)
returns void language plpgsql as $$
declare
  op jsonb;
  v_task bigint;
begin
  for op in select * from jsonb_array_elements(p_ops) loop
    v_task := null;
    case op->>'op'
      when 'create' then
        insert into tasks (project_id, source_chat_id, title, assignee_id, assignee_name,
                           due_date, status, confidence, evidence)
        values (p_project_id, (op->>'source_chat_id')::bigint, op->>'title',
                op->>'assignee_id', op->>'assignee_name', (op->>'due_date')::date,
                op->>'status', (op->>'confidence')::real, op->>'evidence')
        returning id into v_task;
        insert into events (project_id, task_id, kind, actor, detail)
        values (p_project_id, v_task,
                case when op->>'status' = 'candidate' then 'candidate' else 'created' end,
                'ai', op);

      when 'update' then
        update tasks set
          title         = coalesce(op->>'title', title),
          assignee_id   = case when op ? 'assignee_name' then op->>'assignee_id' else assignee_id end,
          assignee_name = coalesce(op->>'assignee_name', assignee_name),
          due_date      = coalesce((op->>'due_date')::date, due_date),
          updated_at    = now()
        where id = (op->>'task_id')::bigint
          and project_id = p_project_id
          and status in ('open', 'candidate')
        returning id into v_task;
        if v_task is not null then
          insert into events (project_id, task_id, kind, actor, detail)
          values (p_project_id, v_task, 'updated', 'ai', op);
        end if;

      when 'complete' then
        update tasks set status = 'done', completed_at = now(), updated_at = now()
        where id = (op->>'task_id')::bigint
          and project_id = p_project_id
          and status in ('open', 'candidate')
        returning id into v_task;
        if v_task is not null then
          insert into events (project_id, task_id, kind, actor, detail)
          values (p_project_id, v_task, 'completed', 'ai', op);
        end if;

      else
        raise exception 'unknown op: %', op->>'op';
    end case;
  end loop;

  update messages set processed_at = now()
  where id = any (p_message_ids) and processed_at is null;
end $$;

-- 関数は service_role からのみ実行可能にする
revoke execute on function register_chat(text, text)              from public, anon, authenticated;
revoke execute on function link_chat(bigint, text)                 from public, anon, authenticated;
revoke execute on function set_main_group(text)                    from public, anon, authenticated;
revoke execute on function projects_due_for_extraction(int, int)   from public, anon, authenticated;
revoke execute on function apply_extraction(bigint, bigint[], jsonb) from public, anon, authenticated;
