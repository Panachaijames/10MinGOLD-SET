-- Separate watching from being notified.
--
-- Until now one `enabled` flag on a watchlist row meant three things at once: scan this
-- instrument, chart it, and push every crossover to whoever added it. There was no way to keep a
-- symbol on your charts quietly, no way to take only bearish crosses on one symbol and both on
-- another, and direction was a single project-wide setting only the owner could change.
--
-- `enabled` now means only "scan and chart it". Everything about delivery moved to its own
-- columns and its own table, and the decision moved from the scanner to the fan-out: one scan
-- still serves everybody, and each member's own rules are applied when their devices are chosen.

alter table public.watchlist
  add column if not exists notify     boolean not null default true,
  add column if not exists directions text[]  not null default array['bullish', 'bearish'],
  add column if not exists channels   text[]  not null default array['push', 'line'];

-- Defaults reproduce today's behaviour exactly: every existing row keeps notifying on both
-- directions, and LINE keeps receiving whatever it received before (which is the owner's own
-- instruments, because only the owner has a LINE destination).
do $$ begin
  alter table public.watchlist
    add constraint watchlist_directions_check check (
      cardinality(directions) between 1 and 2
      and directions <@ array['bullish', 'bearish']
    ),
    add constraint watchlist_channels_check check (
      cardinality(channels) between 1 and 2
      and channels <@ array['push', 'line']
    );
exception when duplicate_object then null;
end $$;

-- An instrument nobody wants pushed is still scanned, so the muting is free: the row simply
-- stops contributing recipients.
create index if not exists watchlist_notify_idx
  on public.watchlist (symbol, timeframe) where enabled and notify;

-- ---------------------------------------------------------------- per-member preferences

create table if not exists public.notification_prefs (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- Local times in `time_zone`. Null on either side means no quiet window at all. A window may
  -- wrap past midnight (22:00 to 07:00), which is the common case for crypto and FX.
  quiet_from   time,
  quiet_to     time,
  time_zone    text not null default 'Asia/Bangkok',
  -- The member's own LINE destination. The owner's comes from the function's LINE_USER_ID
  -- secret, so this stays null for them; there is no self-service way to obtain a LINE user id
  -- yet, so for now the owner sets it for a member who asks.
  line_user_id text,
  updated_at   timestamptz not null default now(),
  constraint notification_prefs_quiet_pair_check check (
    (quiet_from is null) = (quiet_to is null)
  ),
  -- A zero-length window would be ambiguous: it reads as either "never" or "always".
  constraint notification_prefs_quiet_span_check check (quiet_from is null or quiet_from <> quiet_to),
  constraint notification_prefs_zone_check check (char_length(time_zone) between 1 and 64),
  constraint notification_prefs_line_check check (
    line_user_id is null or line_user_id ~ '^U[0-9a-f]{32}$'
  )
);

alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
grant select, insert, update, delete on public.notification_prefs to authenticated;
grant all on public.notification_prefs to service_role;

-- A member's own preferences and nobody else's. The fan-out reads every row with the secret key.
drop policy if exists own_notification_prefs on public.notification_prefs;
create policy own_notification_prefs on public.notification_prefs for all to authenticated
  using ((select auth.uid()) = user_id and public.is_member())
  with check ((select auth.uid()) = user_id and public.is_member());

create or replace function public.notification_prefs_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists notification_prefs_touched on public.notification_prefs;
create trigger notification_prefs_touched before update on public.notification_prefs
  for each row execute function public.notification_prefs_touch();

-- ---------------------------------------------------------------- retention

-- Preferences belong to the account, so they go when the account does (the foreign key handles
-- that). Nothing else to purge: the table holds one row per member.
