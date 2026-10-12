-- 通知先グループ（横断チャット）の会話から、別案件のタスクも更新・作成できるようにする
-- 各操作に project_id があればその案件に、なければ p_project_id に反映する
create or replace function apply_extraction(p_project_id bigint, p_message_ids bigint[], p_ops jsonb)
returns void language plpgsql set search_path = public as $$
declare
  op jsonb;
  v_task bigint;
  v_project bigint;
begin
  for op in select * from jsonb_array_elements(p_ops) loop
    v_task := null;
    v_project := coalesce((op->>'project_id')::bigint, p_project_id);
    case op->>'op'
      when 'create' then
        insert into tasks (project_id, source_chat_id, title, assignee_id, assignee_name,
                           due_date, status, confidence, evidence)
        values (v_project, (op->>'source_chat_id')::bigint, op->>'title',
                op->>'assignee_id', op->>'assignee_name', (op->>'due_date')::date,
                op->>'status', (op->>'confidence')::real, op->>'evidence')
        returning id into v_task;
        insert into events (project_id, task_id, kind, actor, detail)
        values (v_project, v_task,
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
          and project_id = v_project
          and status in ('open', 'candidate')
        returning id into v_task;
        if v_task is not null then
          insert into events (project_id, task_id, kind, actor, detail)
          values (v_project, v_task, 'updated', 'ai', op);
        end if;

      when 'complete' then
        update tasks set status = 'done', completed_at = now(), updated_at = now()
        where id = (op->>'task_id')::bigint
          and project_id = v_project
          and status in ('open', 'candidate')
        returning id into v_task;
        if v_task is not null then
          insert into events (project_id, task_id, kind, actor, detail)
          values (v_project, v_task, 'completed', 'ai', op);
        end if;

      else
        raise exception 'unknown op: %', op->>'op';
    end case;
  end loop;

  update messages set processed_at = now()
  where id = any (p_message_ids) and processed_at is null;
end $$;

revoke execute on function apply_extraction(bigint, bigint[], jsonb) from public, anon, authenticated;
