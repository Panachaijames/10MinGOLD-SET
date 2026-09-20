-- Put the nine configured SET stocks on the owner's watchlist.
--
-- They have been watched since before watchlists existed: `settings.set_tickers` lists them, and
-- one TradingView webhook alert per symbol per timeframe (M10 and M15, eighteen alerts) has been
-- delivering them in real time. None of that put a row in `public.watchlist`, so the owner opened
-- the new panel to an empty list and no charts for stocks they have been trading all along.
--
-- Seeding is safe against those webhooks rather than in competition with them. `tv-webhook` and
-- `watch-scan` build the same alert id for a bar (symbol, timeframe, bar open, direction), and
-- `alerts.id` is the primary key, so whichever arrives first is the one that notifies and the
-- other is discarded. In practice the webhook wins, because it fires at the close while the
-- anonymous scanner's feed is fifteen minutes behind. What the watchlist rows add is the rest of
-- the panel: charts on every timeframe, per-instrument mute and direction, and a fallback that
-- picks the bar up late if a TradingView alert ever expires or its URL changes.

-- Eighteen rows would leave almost nothing under the default cap of twenty, and the seeding is
-- what consumes them, so the cap moves with it. `greatest` means a value already raised by hand
-- is never lowered here.
update public.settings
   set value = to_jsonb(greatest((value #>> '{}')::integer, 40))
 where key = 'watchlist_max_per_user';

insert into public.watchlist (user_id, symbol, timeframe, label)
select owner.user_id,
       ticker.symbol,
       frame.timeframe,
       'SET stock · real time via your TradingView alert'
  from public.app_members owner
 cross join lateral (
   select value as symbol
     from jsonb_array_elements_text(
       coalesce((select value from public.settings where key = 'set_tickers'), '[]'::jsonb)
     )
 ) ticker
 cross join (values (10::smallint), (15::smallint)) as frame(timeframe)
 where owner.is_owner
   and owner.revoked_at is null
-- Re-running must never undo a deliberate choice: an instrument the owner has since muted,
-- re-pointed or removed keeps whatever they set.
on conflict (user_id, symbol, timeframe) do nothing;
