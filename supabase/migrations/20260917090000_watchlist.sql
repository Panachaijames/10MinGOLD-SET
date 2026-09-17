-- Self-service watchlists: any member adds any TradingView instrument on any supported
-- timeframe, and the cloud scanner computes the MACD itself.
--
-- Why this exists. Real-time SET alerts needed one hand-made TradingView alert per symbol and
-- timeframe, which capped the deployment at that plan's twenty alerts and made every addition
-- the owner's job. `gold-scan` already proved the alternative: read closed candles from the
-- anonymous chart socket and detect the crossover inside the function. That path needs no
-- per-symbol setup at all, so it scales to whatever members ask for.
--
-- The trade-off is unavoidable and stated rather than hidden: the anonymous SET feed is 15
-- minutes delayed, so a self-service SET alert arrives about 15 minutes after the candle closes.
-- The owner's existing TradingView webhooks stay real time for the nine configured symbols, and
-- because both producers build the same alert id, a bar covered by both is delivered once.

-- ---------------------------------------------------------------- timeframes
-- M5, M10, M15, M30, H1, H4, D1. Only M10 is not a native TradingView resolution (it is a paid
-- "custom resolution"), so it is built from pairs of M5 bars exactly as gold already is.

alter table public.alerts drop constraint if exists alerts_timeframe_check;
alter table public.alerts add constraint alerts_timeframe_check
  check (timeframe in (0, 5, 10, 15, 30, 60, 240, 1440));

alter table public.candles drop constraint if exists candles_timeframe_check;
alter table public.candles add constraint candles_timeframe_check
  check (timeframe in (5, 10, 15, 30, 60, 240, 1440));

alter table public.set_state drop constraint if exists set_state_timeframe_check;
alter table public.set_state add constraint set_state_timeframe_check
  check (timeframe in (5, 10, 15, 30, 60, 240, 1440));

alter table public.set_macd_history drop constraint if exists set_macd_history_timeframe_check;
alter table public.set_macd_history add constraint set_macd_history_timeframe_check
  check (timeframe in (5, 10, 15, 30, 60, 240, 1440));

-- A watchlist alert is its own producer, distinct from the broker feed and the SET webhooks, so
-- the history list and the fan-out can tell them apart. Postgres 12+ allows this inside a
-- transaction as long as the value is not used in the same one; nothing below inserts an alert.
alter type public.alert_source add value if not exists 'watchlist';

-- ---------------------------------------------------------------- watchlist

create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol     text not null,                       -- canonical TradingView ticker: SET:PTT, BINANCE:BTCUSDT
  timeframe  smallint not null,
  label      text,                                -- description captured at search time, for the UI
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, symbol, timeframe),
  constraint watchlist_timeframe_check check (timeframe in (5, 10, 15, 30, 60, 240, 1440)),
  -- EXCHANGE:TICKER as TradingView writes it (CME_MINI:ES1!, SET:PTT, BINANCE:BTCUSDT).
  constraint watchlist_symbol_check check (symbol ~ '^[A-Z0-9_]{2,24}:[A-Za-z0-9._!$+-]{1,32}$'),
  constraint watchlist_label_size_check check (label is null or char_length(label) <= 120)
);
create index if not exists watchlist_user_idx on public.watchlist (user_id);
create index if not exists watchlist_instrument_idx on public.watchlist (symbol, timeframe) where enabled;

-- Scanner cursor: one row per distinct instrument, however many members watch it.
create table if not exists public.watch_state (
  symbol         text not null,
  timeframe      smallint not null,
  last_bar_time  bigint,                          -- epoch seconds of the last processed CLOSED bar open
  last_close     numeric,
  last_hist      double precision,
  last_macd      double precision,
  last_signal    double precision,
  bars           integer,                         -- closed bars the last fetch returned
  last_polled_at timestamptz,
  last_error     text,
  primary key (symbol, timeframe),
  constraint watch_state_timeframe_check check (timeframe in (5, 10, 15, 30, 60, 240, 1440)),
  constraint watch_state_symbol_size_check check (char_length(symbol) between 1 and 64),
  constraint watch_state_error_size_check check (last_error is null or char_length(last_error) <= 1000)
);

insert into public.settings (key, value) values
  ('watchlist_enabled',        'true'::jsonb),
  ('watchlist_dry_run',        'false'::jsonb),  -- detect and chart without raising alerts
  ('watchlist_max_per_user',   '20'::jsonb),     -- per member, enforced by trigger and UI
  ('watchlist_max_instruments','80'::jsonb),     -- distinct symbol+timeframe pairs across everyone
  ('watchlist_settle_ms',      '2500'::jsonb),   -- let the provider finish the candle before reading it
  ('watchlist_batch_size',     '20'::jsonb)      -- instruments per function invocation
on conflict (key) do nothing;

-- A member could otherwise post a thousand rows straight at PostgREST and make the scanner
-- everyone's problem, so the caps live in the database rather than only in the UI.
create or replace function public.watchlist_enforce_limits() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  per_user integer := coalesce((select (value #>> '{}')::integer from public.settings where key = 'watchlist_max_per_user'), 20);
  global   integer := coalesce((select (value #>> '{}')::integer from public.settings where key = 'watchlist_max_instruments'), 80);
  mine     integer;
  instruments integer;
begin
  select count(*) into mine from public.watchlist w where w.user_id = new.user_id;
  if mine > per_user then
    raise exception 'Watchlist limit reached: % instruments per person.', per_user
      using errcode = 'check_violation';
  end if;
  select count(*) into instruments
    from (select distinct w.symbol, w.timeframe from public.watchlist w where w.enabled) s;
  if instruments > global then
    raise exception 'The shared scanner is full: % instruments across all members.', global
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists watchlist_limits on public.watchlist;
create constraint trigger watchlist_limits
  after insert or update on public.watchlist
  deferrable initially immediate
  for each row execute function public.watchlist_enforce_limits();

-- ---------------------------------------------------------------- RLS

alter table public.watchlist   enable row level security;
alter table public.watch_state enable row level security;

revoke all on public.watchlist, public.watch_state from anon, authenticated;
grant select, insert, update, delete on public.watchlist to authenticated;
grant select on public.watch_state to authenticated;
grant all on public.watchlist, public.watch_state to service_role;

-- Each member sees and edits only their own list. The scanner and the fan-out read every row
-- with the secret key, which bypasses RLS.
drop policy if exists own_watchlist on public.watchlist;
create policy own_watchlist on public.watchlist for all to authenticated
  using ((select auth.uid()) = user_id and public.is_member())
  with check ((select auth.uid()) = user_id and public.is_member());

-- Scanner state is not private: it is the same public candle data every chart already draws.
drop policy if exists member_read on public.watch_state;
create policy member_read on public.watch_state for select to authenticated using (public.is_member());

-- ---------------------------------------------------------------- scanner schedule
--
-- Every supported timeframe is a multiple of five minutes, so a five-minute tick lands on every
-- boundary. An instrument is due when the tick is a multiple of its own timeframe; H4 and D1 are
-- polled hourly instead, because on a session-bounded market (SET) their bars do not close on an
-- epoch-aligned boundary and the exact close time is not knowable from the feed.
create or replace function ops.watch_cadence(timeframe integer) returns integer
language sql immutable as $$
  select least(greatest(timeframe, 5), 60)
$$;

create or replace function ops.watch_scan_gate(catchup boolean default false) returns text
language plpgsql as $$
declare
  boundary      timestamptz := date_trunc('minute', now())
                               - (case when catchup then interval '2 minutes' else interval '0 minutes' end);
  minute_of_day integer := extract(hour from boundary at time zone 'UTC')::integer * 60
                           + extract(minute from boundary at time zone 'UTC')::integer;
  batch_size    integer := coalesce((select (value #>> '{}')::integer from public.settings where key = 'watchlist_batch_size'), 20);
  due           jsonb;
  total         integer;
  posted        integer := 0;
  chunk         jsonb;
  taken         integer := 0;
begin
  if not ops.setting_bool('watchlist_enabled', true) then return 'skip:disabled'; end if;
  batch_size := greatest(1, least(batch_size, 40));

  select coalesce(jsonb_agg(jsonb_build_object('symbol', d.symbol, 'timeframe', d.timeframe)
                            order by d.timeframe, d.symbol), '[]'::jsonb)
    into due
  from (
    select distinct w.symbol, w.timeframe
      from public.watchlist w
      left join public.watch_state s on s.symbol = w.symbol and s.timeframe = w.timeframe
     where w.enabled
       and minute_of_day % ops.watch_cadence(w.timeframe) = 0
       -- The catch-up run only picks up what the run on the boundary did not manage.
       and (not catchup or s.last_polled_at is null or s.last_polled_at < boundary)
  ) d;

  total := jsonb_array_length(due);
  if total = 0 then return 'skip:nothing-due'; end if;

  while taken < total loop
    -- `position` is a SQL keyword, so the ordinality column is named plainly.
    select jsonb_agg(entry.item) into chunk
      from jsonb_array_elements(due) with ordinality as entry(item, idx)
     where entry.idx > taken and entry.idx <= taken + batch_size;
    perform ops.invoke_function(
      'watch-scan',
      jsonb_build_object(
        'instruments', chunk,
        'reason', case when catchup then 'catchup' else 'boundary' end,
        'at', now()
      ),
      60000
    );
    posted := posted + 1;
    taken := taken + batch_size;
  end loop;

  return format('posted:%s instruments=%s', posted, total);
end $$;

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname in ('aurum-watch-scan', 'aurum-watch-scan-catchup')
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
end $$;

select cron.schedule('aurum-watch-scan',         '*/5 * * * *',    $$select ops.watch_scan_gate(false)$$);
select cron.schedule('aurum-watch-scan-catchup', '2-59/5 * * * *', $$select ops.watch_scan_gate(true)$$);

-- ---------------------------------------------------------------- retention
--
-- Candles were purged after a fixed fourteen days, which is fewer than 200 bars on H4 and D1 and
-- would leave the new charts permanently short. Retention is now proportional to the timeframe
-- (400 bars' worth), and never shorter than the fourteen days gold already kept.
create or replace function ops.purge_ops() returns text
language plpgsql as $$
declare
  removed_runs bigint; removed_deliveries bigint; removed_system bigint;
  removed_candles bigint; removed_set bigint; removed_cursors bigint;
begin
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics removed_runs = row_count;
  delete from public.push_deliveries where created_at < now() - interval '30 days';
  get diagnostics removed_deliveries = row_count;
  delete from public.alerts where source = 'system' and created_at < now() - interval '30 days';
  get diagnostics removed_system = row_count;
  delete from public.candles c
   where c.bar_time < now() - greatest(interval '14 days', make_interval(mins => c.timeframe * 400));
  get diagnostics removed_candles = row_count;
  delete from public.set_macd_history where bar_time < now() - interval '60 days';
  get diagnostics removed_set = row_count;
  -- Cursors for instruments nobody watches any more; a later watcher simply reseeds.
  delete from public.watch_state s
   where not exists (
     select 1 from public.watchlist w
      where w.symbol = s.symbol and w.timeframe = s.timeframe and w.enabled
   )
     and (s.last_polled_at is null or s.last_polled_at < now() - interval '7 days');
  get diagnostics removed_cursors = row_count;
  return format('runs=%s deliveries=%s system_alerts=%s candles=%s set_history=%s watch_cursors=%s',
                removed_runs, removed_deliveries, removed_system, removed_candles, removed_set, removed_cursors);
end $$;

-- ---------------------------------------------------------------- watchdog
--
-- A silent watchlist scanner is only a problem when somebody is actually watching something on a
-- timeframe short enough that an hour of silence cannot be normal.
create or replace function ops.watchdog_check() returns text
language plpgsql as $$
declare
  state       jsonb := coalesce((select value from public.settings where key = 'watchdog_state'), '{}'::jsonb);
  new_state   jsonb := state;
  gold_seen   timestamptz := (select last_seen from public.heartbeats where source = 'gold_mt5');
  cloud_seen  timestamptz := (select last_seen from public.heartbeats where source = 'gold_cloud');
  set_seen    timestamptz := (select last_seen from public.heartbeats where source = 'set_tv');
  watch_seen  timestamptz := (select last_seen from public.heartbeats where source = 'watchlist');
  bkk_time    time := (now() at time zone 'Asia/Bangkok')::time;
  bkk_date    date := (now() at time zone 'Asia/Bangkok')::date;
  in_set_session boolean := extract(isodow from bkk_date) <= 5
                            and not exists (select 1 from public.set_holidays h where h.day = bkk_date)
                            and (bkk_time between time '10:31' and time '12:47' or bkk_time between time '14:31' and time '16:57');
  cloud_armed boolean := ops.setting_bool('gold_cloud_enabled', false)
                         and not ops.setting_bool('gold_cloud_dry_run', true);
  cloud_quiet boolean := cloud_seen is null or cloud_seen < now() - interval '20 minutes';
  gold_silent boolean := ops.gold_market_open(now())
                         and (gold_seen is null or gold_seen < now() - interval '3 minutes')
                         and (not cloud_armed or cloud_quiet);
  set_silent  boolean := ops.setting_bool('set_scan_enabled', false) and in_set_session
                         and (set_seen is null or set_seen < now() - interval '20 minutes');
  watch_armed boolean := ops.setting_bool('watchlist_enabled', true)
                         and exists (select 1 from public.watchlist w where w.enabled and w.timeframe <= 30);
  watch_silent boolean := watch_armed and (watch_seen is null or watch_seen < now() - interval '45 minutes');
  push_stuck  boolean := exists (select 1 from public.push_deliveries where status = 'pending' and created_at < now() - interval '10 minutes');
  fired       text[] := array[]::text[];
  recovered   text[] := array[]::text[];
  problem     record;
begin
  for problem in
    select * from (values
      ('gold_silent', gold_silent, 'Gold watcher silent', 'Neither the laptop MT5 watcher nor the cloud failover has reported while gold is trading. Check the laptop, MT5, and the gold-scan function logs.'),
      ('set_silent',  set_silent,  'SET scanner silent',  'No SET scanner run for 20+ minutes inside a trading session. Check cron.job_run_details and the set-scan function logs.'),
      ('watch_silent', watch_silent, 'Watchlist scanner silent', 'No watchlist scan for 45+ minutes while somebody is watching an intraday instrument. Check cron.job_run_details and the watch-scan function logs.'),
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
