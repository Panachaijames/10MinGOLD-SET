-- Full OHLC chart history for the nine watched SET stocks and 24/7 Bitcoin.
-- TradingView's anonymous SET chart feed is delayed by 15 minutes, so its refresh is gated to
-- delayed session windows. Binance Bitcoin is real time and refreshes after every M10/M15 close.

insert into public.settings (key, value) values
  ('set_tickers', '["SET:EA","SET:KCE","SET:BGRIM","SET:GPSC","SET:IVL","SET:STA","SET:STGT","SET:TOP","SET:CCET"]'::jsonb)
on conflict (key) do update set value = excluded.value;

-- These are owner-facing controls. Seed them once, but do not re-enable a kill switch or undo a
-- deliberate local preference if this migration is replayed during recovery.
insert into public.settings (key, value) values
  ('market_candles_enabled',  'true'::jsonb),
  ('bitcoin_chart_enabled',   'true'::jsonb),
  ('bitcoin_symbol',          '"BINANCE:BTCUSDT"'::jsonb),
  ('bitcoin_timeframes',      '[10,15]'::jsonb),
  ('chart_candle_limit',      '200'::jsonb)
on conflict (key) do nothing;

-- The first regular SET candle opens around 10:00 Bangkok. Because the anonymous data is
-- delayed by 15 minutes, useful refreshes begin around 10:30 and 14:30. The final 17:02 run
-- catches the closing auction/bar if it was not published by 16:47.
create or replace function ops.market_candles_set_gate() returns text
language plpgsql as $$
declare
  bkk_date   date := (now() at time zone 'Asia/Bangkok')::date;
  bkk_time   time := (now() at time zone 'Asia/Bangkok')::time;
  request_id bigint;
begin
  if not ops.setting_bool('market_candles_enabled', true) then return 'skip:disabled'; end if;
  if extract(isodow from bkk_date) > 5 then return 'skip:weekend'; end if;
  if exists (select 1 from public.set_holidays h where h.day = bkk_date) then return 'skip:holiday'; end if;
  if not (
    bkk_time between time '10:29' and time '12:50'
    or bkk_time between time '14:29' and time '17:05'
  ) then
    return 'skip:outside-session';
  end if;

  request_id := ops.invoke_function(
    'market-candles',
    jsonb_build_object('market', 'set', 'reason', 'cron', 'at', now()),
    90000
  );
  return 'posted:' || coalesce(request_id::text, 'null');
end $$;

-- Called two minutes after each possible M10/M15 boundary. Only the timeframe(s) actually due
-- are requested, avoiding redundant socket and database work while retaining 24/7 coverage.
create or replace function ops.market_candles_bitcoin_gate() returns text
language plpgsql as $$
declare
  reference_time timestamptz := date_trunc('minute', now()) - interval '2 minutes';
  reference_minute integer := extract(minute from reference_time at time zone 'UTC')::integer;
  due smallint[] := array[]::smallint[];
  request_id bigint;
begin
  if not ops.setting_bool('market_candles_enabled', true) then return 'skip:disabled'; end if;
  if not ops.setting_bool('bitcoin_chart_enabled', true) then return 'skip:bitcoin-disabled'; end if;

  if reference_minute % 10 = 0 then due := array_append(due, 10::smallint); end if;
  if reference_minute % 15 = 0 then due := array_append(due, 15::smallint); end if;
  if array_length(due, 1) is null then return 'skip:nothing-due'; end if;

  request_id := ops.invoke_function(
    'market-candles',
    jsonb_build_object(
      'market', 'bitcoin',
      'timeframes', to_jsonb(due),
      'reason', 'cron',
      'at', now()
    ),
    45000
  );
  return 'posted:' || coalesce(request_id::text, 'null');
end $$;

-- Remove every same-named job before recreating it, making manual migration replays safe too.
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname in ('aurum-set-candles', 'aurum-bitcoin-candles')
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
end $$;

-- UTC schedules. The SET gate converts to Bangkok time and rejects weekends/holidays/sessions.
select cron.schedule(
  'aurum-set-candles',
  '2,17,32,47 3-10 * * 1-5',
  $$select ops.market_candles_set_gate()$$
);
select cron.schedule(
  'aurum-bitcoin-candles',
  '2,12,17,22,32,42,47,52 * * * *',
  $$select ops.market_candles_bitcoin_gate()$$
);
