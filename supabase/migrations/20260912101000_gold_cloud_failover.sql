-- Gold cloud failover: keep alerts flowing while the laptop and its MT5 terminal are off.
--
-- The gate below posts to the gold-scan function only when the laptop heartbeat has gone
-- quiet, so the broker feed stays authoritative whenever it is available and the two
-- producers never evaluate the same bar at the same time.
--
-- Session rules are also corrected here for the Wisdom Financial server (UTC+3), measured
-- from its own M10 history: the week opens Sunday 22:00 UTC, closes Friday 21:00 UTC, and
-- the daily break runs 21:00-22:00 UTC. The previous values described Exness.

insert into public.settings (key, value) values
  ('gold_cloud_enabled',          'false'::jsonb),  -- flip to true after a dry run
  ('gold_cloud_dry_run',          'true'::jsonb),   -- log crosses without inserting alerts
  ('gold_cloud_takeover_seconds', '180'::jsonb),    -- laptop silence before the cloud takes over
  ('gold_cloud_max_age_seconds',  '900'::jsonb),    -- never alert on a bar that closed long ago
  ('gold_symbol',                 '"GOLD.wis"'::jsonb)
on conflict (key) do nothing;

update public.settings set value = '"21:00"'::jsonb     where key = 'gold_break_start_utc';
update public.settings set value = '"22:00"'::jsonb     where key = 'gold_break_end_utc';
update public.settings set value = '"Sun 22:00"'::jsonb where key = 'gold_week_open_utc';
update public.settings set value = '"Fri 21:00"'::jsonb where key = 'gold_week_close_utc';

-- Gold trades from Sunday 22:00 UTC to Friday 21:00 UTC with a one-hour break each night.
create or replace function ops.gold_market_open(at_time timestamptz) returns boolean
language plpgsql stable as $$
declare
  dow int  := extract(isodow from at_time at time zone 'UTC');
  t   time := (at_time at time zone 'UTC')::time;
  brk_start time := coalesce((select (value #>> '{}')::time from public.settings where key = 'gold_break_start_utc'), time '21:00');
  brk_end   time := coalesce((select (value #>> '{}')::time from public.settings where key = 'gold_break_end_utc'),   time '22:00');
begin
  if dow = 6 then return false; end if;                        -- Saturday
  if dow = 7 then return t >= brk_end; end if;                 -- Sunday: the week opens at the break end
  if dow = 5 and t >= brk_start then return false; end if;     -- after Friday close
  if t >= brk_start and t < brk_end then return false; end if; -- daily break
  return true;
end $$;

-- Failover gate. Runs a minute after each candle boundary and posts only the timeframes that
-- just closed, which keeps the free Twelve Data quota (800 calls a day) far out of reach.
create or replace function ops.gold_scan_gate() returns text
language plpgsql as $$
declare
  laptop_seen timestamptz := (select last_seen from public.heartbeats where source = 'gold_mt5');
  quiet_after integer := coalesce((select (value #>> '{}')::integer from public.settings where key = 'gold_cloud_takeover_seconds'), 180);
  minute_now  integer := extract(minute from now() at time zone 'UTC')::integer;
  due         smallint[] := array[]::smallint[];
  request_id  bigint;
begin
  if not ops.setting_bool('gold_cloud_enabled', false) then return 'skip:disabled'; end if;
  if not ops.gold_market_open(now()) then return 'skip:market-closed'; end if;
  if laptop_seen is not null and laptop_seen > now() - make_interval(secs => quiet_after) then
    return 'skip:laptop-alive';
  end if;
  if (minute_now - 1) % 10 = 0 then due := array_append(due, 10::smallint); end if;
  if (minute_now - 1) % 15 = 0 then due := array_append(due, 15::smallint); end if;
  if array_length(due, 1) is null then return 'skip:no-bar-closed'; end if;
  request_id := ops.invoke_function(
    'gold-scan',
    jsonb_build_object('reason', 'cron', 'timeframes', to_jsonb(due), 'at', now()),
    20000
  );
  return 'posted:' || coalesce(request_id::text, 'null');
end $$;

-- The dead-man's switch now knows about the failover: a silent laptop is only a problem when
-- nothing else is watching gold. The cloud reports in once per closed candle, so it is given
-- a wider silence window than the laptop's three minutes.
create or replace function ops.watchdog_check() returns text
language plpgsql as $$
declare
  state       jsonb := coalesce((select value from public.settings where key = 'watchdog_state'), '{}'::jsonb);
  new_state   jsonb := state;
  gold_seen   timestamptz := (select last_seen from public.heartbeats where source = 'gold_mt5');
  cloud_seen  timestamptz := (select last_seen from public.heartbeats where source = 'gold_cloud');
  set_seen    timestamptz := (select last_seen from public.heartbeats where source = 'set_tv');
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
  push_stuck  boolean := exists (select 1 from public.push_deliveries where status = 'pending' and created_at < now() - interval '10 minutes');
  fired       text[] := array[]::text[];
  recovered   text[] := array[]::text[];
  problem     record;
begin
  for problem in
    select * from (values
      ('gold_silent', gold_silent, 'Gold watcher silent', 'Neither the laptop MT5 watcher nor the cloud failover has reported while gold is trading. Check the laptop, MT5, and the gold-scan function logs.'),
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

-- One minute after every 10- and 15-minute boundary: :01 :11 :16 :21 :31 :41 :46 :51.
select cron.unschedule('aurum-gold-scan') where exists (select 1 from cron.job where jobname = 'aurum-gold-scan');
select cron.schedule('aurum-gold-scan', '1,11,16,21,31,41,46,51 * * * *', $$select ops.gold_scan_gate()$$);
