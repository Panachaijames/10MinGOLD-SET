-- Tighten the initial single-user schema and keep SET state ready for both M10 and M15.
-- The first migration is already live, so these corrections intentionally live in a new,
-- forward-only migration instead of rewriting applied history.

-- One SET symbol can have independent M10 and M15 cursors/state.
alter table public.set_state drop constraint if exists set_state_pkey;
alter table public.set_state add constraint set_state_pkey primary key (symbol, timeframe);

alter table public.alerts
  add constraint alerts_timeframe_check check (timeframe in (0, 10, 15)),
  add constraint alerts_bar_order_check check (bar_close is null or bar_close > bar_time),
  add constraint alerts_delay_check check (detection_delay_ms is null or detection_delay_ms >= 0),
  add constraint alerts_text_size_check check (
    char_length(symbol) between 1 and 64
    and char_length(title) between 1 and 160
    and char_length(body) between 1 and 1000
  ),
  add constraint alerts_payload_object_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768
  );

alter table public.push_subscriptions
  add constraint push_subscriptions_platform_check check (
    platform is null or platform in ('apple', 'fcm', 'wns', 'mozilla', 'other')
  ),
  add constraint push_subscriptions_fail_count_check check (fail_count >= 0),
  add constraint push_subscriptions_text_size_check check (
    user_agent is null or char_length(user_agent) <= 500
  );

alter table public.push_deliveries
  add constraint push_deliveries_kind_check check (kind in ('alert', 'test', 'watchdog')),
  add constraint push_deliveries_status_check check (status in ('pending', 'accepted', 'received', 'failed', 'dead')),
  add constraint push_deliveries_attempts_check check (attempts >= 0),
  add constraint push_deliveries_error_size_check check (
    last_error is null or char_length(last_error) <= 1000
  );

alter table public.heartbeats
  add constraint heartbeats_source_size_check check (char_length(source) between 1 and 64),
  add constraint heartbeats_details_object_check check (
    jsonb_typeof(details) = 'object' and octet_length(details::text) <= 32768
  );

alter table public.set_state
  add constraint set_state_timeframe_check check (timeframe in (10, 15)),
  add constraint set_state_symbol_size_check check (char_length(symbol) between 1 and 64),
  add constraint set_state_error_size_check check (
    last_error is null or char_length(last_error) <= 1000
  );

alter table public.candles
  add constraint candles_timeframe_check check (timeframe in (10, 15)),
  add constraint candles_symbol_size_check check (char_length(symbol) between 1 and 64),
  add constraint candles_bar_values_check check (
    close > 0
    and (open is null or open > 0)
    and (high is null or high > 0)
    and (low is null or low > 0)
  );

alter table public.set_macd_history
  add constraint set_macd_history_timeframe_check check (timeframe in (10, 15)),
  add constraint set_macd_history_symbol_size_check check (char_length(symbol) between 1 and 64),
  add constraint set_macd_history_close_check check (close is null or close > 0);

-- Replace two functions solely to resolve plpgsql_check warnings in the applied migration.
create or replace function ops.set_scan_gate() returns text
language plpgsql as $$
declare
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
  fired       text[] := array[]::text[];
  recovered   text[] := array[]::text[];
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
