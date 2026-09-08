-- Chart data for the PWA: recent gold candles with MACD (published by the laptop watcher) and
-- a per-bar MACD history for SET tickers (written by the set-scan function; the free scanner
-- gives no OHLC history, so SET charts are MACD lines only).

create table if not exists public.candles (
  symbol      text not null,                 -- XAUUSDm
  timeframe   smallint not null,             -- 10 | 15
  bar_time    timestamptz not null,          -- candle OPEN (UTC)
  open        numeric,
  high        numeric,
  low         numeric,
  close       numeric not null,
  macd        double precision,
  signal      double precision,
  histogram   double precision,
  provisional boolean not null default false, -- closed by the wall clock, may still be revised once
  updated_at  timestamptz not null default now(),
  primary key (symbol, timeframe, bar_time)
);
create index if not exists candles_recent_idx on public.candles (symbol, timeframe, bar_time desc);

create table if not exists public.set_macd_history (
  symbol      text not null,                 -- SET:PTT
  timeframe   smallint not null default 15,
  bar_time    timestamptz not null,          -- candle OPEN (UTC)
  close       numeric,
  macd        double precision not null,
  signal      double precision not null,
  histogram   double precision not null,
  update_mode text,
  created_at  timestamptz not null default now(),
  primary key (symbol, timeframe, bar_time)
);

alter table public.candles          enable row level security;
alter table public.set_macd_history enable row level security;

revoke all on public.candles, public.set_macd_history from anon, authenticated;
grant select on public.candles, public.set_macd_history to authenticated;
grant all on public.candles, public.set_macd_history to service_role;

drop policy if exists owner_read on public.candles;
create policy owner_read on public.candles for select to authenticated using (true);
drop policy if exists owner_read on public.set_macd_history;
create policy owner_read on public.set_macd_history for select to authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'candles') then
    alter publication supabase_realtime add table public.candles;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'set_macd_history') then
    alter publication supabase_realtime add table public.set_macd_history;
  end if;
end $$;

-- Keep the tables small on the 500 MB plan.
create or replace function ops.purge_ops() returns text
language plpgsql as $$
declare
  removed_runs bigint; removed_deliveries bigint; removed_system bigint; removed_candles bigint; removed_set bigint;
begin
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics removed_runs = row_count;
  delete from public.push_deliveries where created_at < now() - interval '30 days';
  get diagnostics removed_deliveries = row_count;
  delete from public.alerts where source = 'system' and created_at < now() - interval '30 days';
  get diagnostics removed_system = row_count;
  delete from public.candles where bar_time < now() - interval '14 days';
  get diagnostics removed_candles = row_count;
  delete from public.set_macd_history where bar_time < now() - interval '60 days';
  get diagnostics removed_set = row_count;
  return format('runs=%s deliveries=%s system_alerts=%s candles=%s set_history=%s',
                removed_runs, removed_deliveries, removed_system, removed_candles, removed_set);
end $$;
