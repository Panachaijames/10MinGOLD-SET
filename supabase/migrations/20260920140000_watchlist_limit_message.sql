-- Say what the watchlist caps actually count.
--
-- Timeframes are now chosen per instrument in the PWA, so one stock on M10, M15 and H1 is three
-- rows. The cap has always counted rows — that is the load the scanner actually carries — but it
-- called them "instruments per person", which reads as three slots used by one stock. The limit
-- is unchanged; only the message is, plus it now names the setting to raise.

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
    raise exception
      'Watchlist full: % symbol-and-timeframe pairs per person. Remove a timeframe, or ask the owner to raise watchlist_max_per_user.',
      per_user
      using errcode = 'check_violation';
  end if;
  select count(*) into instruments
    from (select distinct w.symbol, w.timeframe from public.watchlist w where w.enabled) s;
  if instruments > global then
    raise exception
      'The shared scanner is full: % symbol-and-timeframe pairs across all members (watchlist_max_instruments).',
      global
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- New deployments start with room for a handful of stocks across several timeframes each. An
-- existing project keeps whatever it has: this must not quietly widen a cap somebody chose.
insert into public.settings (key, value) values ('watchlist_max_per_user', '40'::jsonb)
on conflict (key) do nothing;
