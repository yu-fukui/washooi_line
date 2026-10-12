-- 中止した案件を一覧・案件選択・解析の対象から外す
alter table projects add column archived boolean not null default false;
