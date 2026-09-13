-- Real-time SET alerts by webhook.
--
-- The set-scan cron polls TradingView's anonymous scanner endpoint, which serves 15-minute
-- delayed data regardless of what the account subscribes to. With the SET real-time data add-on,
-- alerts fired from the subscriber's own TradingView session arrive at the candle close instead,
-- so the tv-webhook function becomes the alert producer and set-scan is demoted to chart history.
--
-- Both write the same alert id for the same bar, so running both is safe: the first one through
-- notifies and the later duplicate is ignored.

insert into public.settings (key, value) values
  ('tv_webhook_enabled',         'true'::jsonb),
  ('tv_webhook_max_age_seconds', '1800'::jsonb)   -- never notify on a replayed or long-delayed alert
on conflict (key) do nothing;

-- Keep the scanner running for the PWA's SET MACD chart and for set_state, but stop it inserting
-- alerts: the webhook now owns that, 15 minutes earlier. Flip set_scan_dry_run back to false if
-- the webhook is ever turned off.
update public.settings set value = 'true'::jsonb  where key = 'set_scan_dry_run';
update public.settings set value = 'true'::jsonb  where key = 'set_scan_enabled';

-- The watchdog already warns when the delayed scanner goes quiet. Add the webhook path: silence
-- there means alerts have stopped arriving from TradingView, which is the failure that matters
-- now. Only inside a SET session, and only once the webhook has ever been seen, so a user who
-- has not set up the alerts yet is not nagged.
create or replace function ops.watchdog_check() returns text
language plpgsql as $$
declare
  state        jsonb := coalesce((select value from public.settings where key = 'watchdog_state'), '{}'::jsonb);
  new_state    jsonb := state;
  gold_seen    timestamptz := (select last_seen from public.heartbeats where source = 'gold_mt5');
  cloud_seen   timestamptz := (select last_seen from public.heartbeats where source = 'gold_cloud');
  set_seen     timestamptz := (select last_seen from public.heartbeats where source = 'set_tv');
  hook_seen    timestamptz := (select last_seen from public.heartbeats where source = 'set_tv_webhook');
  bkk_time     time := (now() at time zone 'Asia/Bangkok')::time;
  bkk_date     date := (now() at time zone 'Asia/Bangkok')::date;
  in_set_session boolean := extract(isodow from bkk_date) <= 5
                            and not exists (select 1 from public.set_holidays h where h.day = bkk_date)
                            and (bkk_time between time '10:31' and time '12:47' or bkk_time between time '14:31' and time '16:57');
  cloud_armed  boolean := ops.setting_bool('gold_cloud_enabled', false)
                          and not ops.setting_bool('gold_cloud_dry_run', true);
  cloud_quiet  boolean := cloud_seen is null or cloud_seen < now() - interval '20 minutes';
  gold_silent  boolean := ops.gold_market_open(now())
                          and (gold_seen is null or gold_seen < now() - interval '3 minutes')
                          and (not cloud_armed or cloud_quiet);
  set_silent   boolean := ops.setting_bool('set_scan_enabled', false) and in_set_session
                          and (set_seen is null or set_seen < now() - interval '20 minutes');
  -- A cross is not guaranteed every session, so silence here is only suspicious over a long
  -- window: a full trading day with no webhook at all means the alerts have lapsed or expired.
  hook_silent  boolean := ops.setting_bool('tv_webhook_enabled', true) and in_set_session
                          and hook_seen is not null and hook_seen < now() - interval '3 days';
  push_stuck   boolean := exists (select 1 from public.push_deliveries where status = 'pending' and created_at < now() - interval '10 minutes');
  fired        text[] := array[]::text[];
  recovered    text[] := array[]::text[];
  problem      record;
begin
  for problem in
    select * from (values
      ('gold_silent', gold_silent, 'Gold watcher silent', 'Neither the laptop MT5 watcher nor the cloud failover has reported while gold is trading. Check the laptop, MT5, and the gold-scan function logs.'),
      ('set_silent',  set_silent,  'SET scanner silent',  'No SET scanner run for 20+ minutes inside a trading session. Check cron.job_run_details and the set-scan function logs.'),
      ('hook_silent', hook_silent, 'TradingView alerts silent', 'No TradingView webhook has arrived for three days. The alerts may have expired, or 2FA or the webhook URL may have changed.'),
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
