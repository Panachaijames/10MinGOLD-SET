-- Aurum Signal v2: alerts, push fan-out, SET scanner state, heartbeats, cron.
-- Single-user project. Writers (laptop watcher, Edge Functions, cron) use the secret key
-- (service_role, bypasses RLS); the PWA reads with the publishable key + a user JWT.
--
-- Prerequisites once per project (dashboard or SQL editor, not part of this migration):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('sb_secret_...', 'fn_secret_key');
-- and enable the Cron integration (pg_cron) in Dashboard > Integrations if the extension
-- statement below is not permitted for your role.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists supabase_vault;

-- ---------------------------------------------------------------- types

do $$ begin
  if not exists (select 1 from pg_type where typname = 'alert_source') then
    create type public.alert_source as enum ('gold_mt5', 'set_tv', 'gold_oanda', 'system');
  end if;
  if not exists (select 1 from pg_type where typname = 'alert_direction') then
    create type public.alert_direction as enum ('bullish', 'bearish', 'info');
  end if;
end $$;

-- ---------------------------------------------------------------- tables

create table if not exists public.alerts (
  id                 text primary key,                 -- e.g. XAUUSDm:10m:20260908T031000Z:bullish
  source             public.alert_source not null,
  symbol             text not null,                    -- XAUUSDm, SET:PTT, watchdog
  timeframe          smallint not null,                -- 10, 15; 0 for system alerts
  direction          public.alert_direction not null,
  bar_time           timestamptz not null,             -- candle OPEN (UTC)
  bar_close          timestamptz,
  price              numeric,
  macd               double precision,
  signal             double precision,
  histogram          double precision,
  prev_macd          double precision,
  prev_signal        double precision,
  title              text not null,                    -- rendered once by the producer
  body               text not null,
  detected_at        timestamptz not null default now(),
  detection_delay_ms integer,
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (source, symbol, timeframe, bar_time, direction)
);
create index if not exists alerts_created_idx on public.alerts (created_at desc);

create table if not exists public.push_subscriptions (
  endpoint      text primary key,
  p256dh        text not null check (char_length(p256dh) between 80 and 128),
  auth          text not null check (char_length(auth) between 16 and 64),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  user_agent    text,
  platform      text,                                  -- apple | fcm | wns | mozilla | other (set by the PWA)
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  last_ok_at    timestamptz,
  last_error    text,
  fail_count    integer not null default 0,
  check (endpoint ~ '^https://([a-z0-9-]+[.])*(fcm[.]googleapis[.]com|web[.]push[.]apple[.]com|notify[.]windows[.]com|push[.]services[.]mozilla[.]com)/')
);

create table if not exists public.push_deliveries (
  id                 uuid primary key default gen_random_uuid(),
  alert_id           text references public.alerts (id) on delete cascade,   -- null for test pushes
  endpoint           text not null references public.push_subscriptions (endpoint) on delete cascade,
  kind               text not null default 'alert',    -- alert | test | watchdog
  status             text not null default 'pending',  -- pending | accepted | received | failed | dead
  attempts           integer not null default 0,
  receipt_token_hash text not null,
  accepted_at        timestamptz,
  received_at        timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  unique (alert_id, endpoint)                          -- idempotent fan-out per device
);
create index if not exists push_deliveries_pending_idx on public.push_deliveries (status, created_at) where status = 'pending';
create index if not exists push_deliveries_alert_idx on public.push_deliveries (alert_id);

create table if not exists public.heartbeats (
  source      text primary key,                        -- gold_mt5 | set_tv | push_fanout
  last_seen   timestamptz not null,
  connected   boolean,
  details     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.set_state (
  symbol         text primary key,                     -- SET:PTT
  timeframe      smallint not null default 15,
  last_bar_time  bigint,                               -- epoch seconds of the last processed CLOSED bar open
  last_hist      double precision,
  last_macd      double precision,
  last_signal    double precision,
  update_mode    text,
  last_polled_at timestamptz,
  last_error     text
);

create table if not exists public.set_holidays (
  day  date primary key,
  name text
);

create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

-- Read model for the PWA history list (security_invoker so RLS of the caller applies).
create or replace view public.alerts_with_delivery
with (security_invoker = true) as
select a.*,
       count(d.id) filter (where d.status in ('accepted', 'received')) as push_accepted,
       count(d.id) filter (where d.received_at is not null)             as device_received,
       min(d.received_at)                                               as first_device_received_at
from public.alerts a
left join public.push_deliveries d on d.alert_id = a.id
group by a.id;

-- ---------------------------------------------------------------- seed data

insert into public.set_holidays (day, name) values
  ('2026-10-13', 'King Bhumibol Memorial Day'),
  ('2026-10-23', 'Chulalongkorn Day'),
  ('2026-12-07', 'King Bhumibol Birthday (substitution)'),
  ('2026-12-10', 'Constitution Day'),
  ('2026-12-31', 'New Year''s Eve')
on conflict (day) do nothing;

insert into public.settings (key, value) values
  ('set_tickers',         '["SET:PTT","SET:KBANK","SET:CPALL","SET:AOT","SET:ADVANC"]'::jsonb),
  ('set_scan_enabled',    'false'::jsonb),   -- flip to true after the dry run
  ('set_scan_dry_run',    'true'::jsonb),    -- log crosses without inserting alerts
  ('alert_directions',    '["bullish","bearish"]'::jsonb),
  ('gold_break_start_utc','"20:55"'::jsonb),  -- Exness XAUUSD daily break window (verify in Symbol Specification)
  ('gold_break_end_utc',  '"22:05"'::jsonb),
  ('gold_week_open_utc',  '"Mon 00:05"'::jsonb),
  ('gold_week_close_utc', '"Fri 20:55"'::jsonb),
  ('watchdog_state',      '{}'::jsonb),
  ('push_ttl_seconds',    '600'::jsonb),
  ('ntfy_topic',          '""'::jsonb)       -- optional secondary channel; empty = off
on conflict (key) do nothing;

-- ---------------------------------------------------------------- RLS + grants
-- New projects no longer expose tables to the Data API automatically: grants are explicit.
-- No grants to anon anywhere.

alter table public.alerts             enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_deliveries    enable row level security;
alter table public.heartbeats         enable row level security;
alter table public.set_state          enable row level security;
alter table public.set_holidays       enable row level security;
alter table public.settings           enable row level security;

grant usage on schema public to authenticated, service_role;
grant select on public.alerts, public.alerts_with_delivery, public.push_deliveries, public.heartbeats,
                public.set_state, public.set_holidays, public.settings to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant insert, delete on public.set_holidays to authenticated;
grant update on public.settings to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Sign-ups are disabled, so every authenticated JWT belongs to the owner.
drop policy if exists owner_read on public.alerts;
create policy owner_read on public.alerts for select to authenticated using (true);
drop policy if exists owner_read on public.push_deliveries;
create policy owner_read on public.push_deliveries for select to authenticated using (true);
drop policy if exists owner_read on public.heartbeats;
create policy owner_read on public.heartbeats for select to authenticated using (true);
drop policy if exists owner_read on public.set_state;
create policy owner_read on public.set_state for select to authenticated using (true);
drop policy if exists owner_read on public.set_holidays;
create policy owner_read on public.set_holidays for select to authenticated using (true);
drop policy if exists owner_write on public.set_holidays;
create policy owner_write on public.set_holidays for insert to authenticated with check (true);
drop policy if exists owner_delete on public.set_holidays;
create policy owner_delete on public.set_holidays for delete to authenticated using (true);
drop policy if exists owner_read on public.settings;
create policy owner_read on public.settings for select to authenticated using (true);
drop policy if exists owner_update on public.settings;
create policy owner_update on public.settings for update to authenticated using (true) with check (true);
drop policy if exists own_subscriptions on public.push_subscriptions;
create policy own_subscriptions on public.push_subscriptions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Realtime for the dashboard (idempotent).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alerts') then
    alter publication supabase_realtime add table public.alerts;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'heartbeats') then
    alter publication supabase_realtime add table public.heartbeats;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'set_state') then
    alter publication supabase_realtime add table public.set_state;
  end if;
end $$;

-- ---------------------------------------------------------------- ops schema (not exposed)
-- Plain security-invoker functions executed by postgres from pg_cron / triggers. Kept out of
-- `public` so they never become Data API endpoints.

create schema if not exists ops;

create or replace function ops.vault_secret(secret_name text) returns text
language sql stable as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name limit 1
$$;

create or replace function ops.setting_bool(setting_key text, fallback boolean) returns boolean
language sql stable as $$
  select coalesce((select value = 'true'::jsonb from public.settings where key = setting_key), fallback)
$$;

create or replace function ops.invoke_function(function_name text, body jsonb, timeout_ms integer default 8000) returns bigint
language plpgsql as $$
declare
  url text := ops.vault_secret('project_url');
  key text := ops.vault_secret('fn_secret_key');
  request_id bigint;
begin
  if url is null or key is null then
    raise warning 'ops.invoke_function(%): vault secrets project_url / fn_secret_key are missing', function_name;
    return null;
  end if;
  select net.http_post(
    url := url || '/functions/v1/' || function_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', key,
      'Authorization', 'Bearer ' || key,
      'x-region', 'ap-southeast-1'
    ),
    body := body,
    timeout_milliseconds := timeout_ms
  ) into request_id;
  return request_id;
end $$;

-- SET scanner gate: weekday, not a holiday, inside a session window (+15-min feed delay +
-- closing auction), and the kill switch. Bangkok is UTC+7 with no DST.
create or replace function ops.set_scan_gate() returns text
language plpgsql as $$
declare
  bkk       timestamp := now() at time zone 'Asia/Bangkok';
  bkk_date  date := (now() at time zone 'Asia/Bangkok')::date;
  bkk_time  time := (now() at time zone 'Asia/Bangkok')::time;
  request_id bigint;
begin
  if not ops.setting_bool('set_scan_enabled', false) then return 'skip:disabled'; end if;
  if extract(isodow from bkk_date) > 5 then return 'skip:weekend'; end if;
  if exists (select 1 from public.set_holidays h where h.day = bkk_date) then return 'skip:holiday'; end if;
  if not (bkk_time between time '10:29' and time '12:47' or bkk_time between time '14:29' and time '16:57') then
    return 'skip:outside-session';
  end if;
  request_id := ops.invoke_function('set-scan', jsonb_build_object('reason', 'cron', 'at', now()), 20000);
  return 'posted:' || coalesce(request_id::text, 'null');
end $$;

-- Database Webhooks have no retries: re-fire the fan-out for deliveries still pending, and
-- retire anything older than the push TTL window.
create or replace function ops.push_sweep() returns text
language plpgsql as $$
declare
  request_id bigint;
begin
  update public.push_deliveries
     set status = 'dead', last_error = coalesce(last_error, 'expired before delivery')
   where status = 'pending' and created_at < now() - interval '15 minutes';
  if exists (select 1 from public.push_deliveries where status = 'pending' and attempts < 6) then
    request_id := ops.invoke_function('push-fanout', jsonb_build_object('mode', 'sweep'), 20000);
    return 'posted:' || coalesce(request_id::text, 'null');
  end if;
  return 'idle';
end $$;

create or replace function ops.gold_market_open(at_time timestamptz) returns boolean
language plpgsql stable as $$
declare
  dow int := extract(isodow from at_time at time zone 'UTC');
  t   time := (at_time at time zone 'UTC')::time;
  brk_start time := coalesce((select (value #>> '{}')::time from public.settings where key = 'gold_break_start_utc'), time '20:55');
  brk_end   time := coalesce((select (value #>> '{}')::time from public.settings where key = 'gold_break_end_utc'),   time '22:05');
begin
  if dow > 5 then return false; end if;                       -- Saturday, Sunday
  if dow = 1 and t < time '00:05' then return false; end if;  -- before Monday open
  if dow = 5 and t > time '20:55' then return false; end if;  -- after Friday close
  if t >= brk_start and t < brk_end then return false; end if; -- daily break
  return true;
end $$;

-- Dead-man's switch. Pure SQL: inserts a system alert that rides the normal fan-out.
create or replace function ops.watchdog_check() returns text
language plpgsql as $$
declare
  state       jsonb := coalesce((select value from public.settings where key = 'watchdog_state'), '{}'::jsonb);
  new_state   jsonb := state;
  gold_seen   timestamptz := (select last_seen from public.heartbeats where source = 'gold_mt5');
  set_seen    timestamptz := (select last_seen from public.heartbeats where source = 'set_tv');
  bkk_time    time := (now() at time zone 'Asia/Bangkok')::time;
  bkk_date    date := (now() at time zone 'Asia/Bangkok')::date;
  in_set_session boolean := extract(isodow from bkk_date) <= 5
                            and not exists (select 1 from public.set_holidays h where h.day = bkk_date)
                            and (bkk_time between time '10:31' and time '12:47' or bkk_time between time '14:31' and time '16:57');
  gold_silent boolean := ops.gold_market_open(now()) and (gold_seen is null or gold_seen < now() - interval '3 minutes');
  set_silent  boolean := ops.setting_bool('set_scan_enabled', false) and in_set_session
                         and (set_seen is null or set_seen < now() - interval '20 minutes');
  push_stuck  boolean := exists (select 1 from public.push_deliveries where status = 'pending' and created_at < now() - interval '10 minutes');
  fired       text[] := '{}';
  recovered   text[] := '{}';
  problem     record;
begin
  for problem in
    select * from (values
      ('gold_silent', gold_silent, 'Gold watcher silent', 'No heartbeat from the laptop MT5 watcher for 3+ minutes while gold is trading. Check the laptop, MT5, and the scheduled task.'),
      ('set_silent',  set_silent,  'SET scanner silent',  'No SET scanner run for 20+ minutes inside a trading session. Check cron.job_run_details and the set-scan function logs.'),
      ('push_stuck',  push_stuck,  'Push delivery stuck',  'Deliveries have been pending for 10+ minutes. Check the push-fanout function and VAPID secrets.')
    ) as p(key, active, title, body)
  loop
    if problem.active and coalesce((state ->> problem.key)::boolean, false) = false then
      insert into public.alerts (id, source, symbol, timeframe, direction, bar_time, title, body, payload)
      values ('system:' || problem.key || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24'),
              'system', 'watchdog', 0, 'info', date_trunc('hour', now()), problem.title, problem.body,
              jsonb_build_object('problem', problem.key))
      on conflict do nothing;
      fired := array_append(fired, problem.key);
    elsif not problem.active and coalesce((state ->> problem.key)::boolean, false) = true then
      insert into public.alerts (id, source, symbol, timeframe, direction, bar_time, title, body, payload)
      values ('system:' || problem.key || ':recovered:' || to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MI'),
              'system', 'watchdog', 0, 'info', date_trunc('minute', now()), problem.title || ' recovered',
              'The condition cleared.', jsonb_build_object('problem', problem.key, 'recovered', true))
      on conflict do nothing;
      recovered := array_append(recovered, problem.key);
    end if;
    new_state := jsonb_set(new_state, array[problem.key], to_jsonb(problem.active), true);
  end loop;
  insert into public.settings (key, value) values ('watchdog_state', new_state)
  on conflict (key) do update set value = excluded.value;
  return format('fired=%s recovered=%s', array_to_string(fired, ','), array_to_string(recovered, ','));
end $$;

create or replace function ops.purge_ops() returns text
language plpgsql as $$
declare
  removed_runs bigint; removed_deliveries bigint; removed_system bigint;
begin
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics removed_runs = row_count;
  delete from public.push_deliveries where created_at < now() - interval '30 days';
  get diagnostics removed_deliveries = row_count;
  delete from public.alerts where source = 'system' and created_at < now() - interval '30 days';
  get diagnostics removed_system = row_count;
  return format('runs=%s deliveries=%s system_alerts=%s', removed_runs, removed_deliveries, removed_system);
end $$;

-- Fan-out trigger: fires push-fanout for every new alert (async, on commit). The secret key is
-- read from Vault at call time so it never appears in the trigger definition.
create or replace function ops.alerts_notify() returns trigger
language plpgsql as $$
begin
  perform ops.invoke_function('push-fanout', jsonb_build_object('type', 'INSERT', 'table', 'alerts', 'record', to_jsonb(new)), 5000);
  return new;
end $$;

drop trigger if exists alerts_push_fanout on public.alerts;
create trigger alerts_push_fanout after insert on public.alerts
  for each row execute function ops.alerts_notify();

-- ---------------------------------------------------------------- cron (UTC)

select cron.schedule('aurum-set-scan',   '1,16,31,46,56 3-9 * * 1-5', $$select ops.set_scan_gate()$$);
select cron.schedule('aurum-push-sweep', '*/2 * * * *',              $$select ops.push_sweep()$$);
select cron.schedule('aurum-watchdog',   '* * * * *',                $$select ops.watchdog_check()$$);
select cron.schedule('aurum-purge-ops',  '15 20 * * 0',              $$select ops.purge_ops()$$);
