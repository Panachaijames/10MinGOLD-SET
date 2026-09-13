-- Passcode access control.
--
-- Until now every policy read `to authenticated using (true)`, so ANY Supabase Auth account had
-- full access, and the project allows open sign-ups. Someone who found the URL could register,
-- confirm their own email, read every alert and even rewrite public.settings.
--
-- Access is now membership, not merely authentication. The owner account is a member forever;
-- everyone else becomes one only by redeeming a passcode the owner generated, and can be revoked
-- individually without touching anyone else.

create table if not exists public.access_codes (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null unique,              -- sha256 of the passcode; the code itself is never stored
  label       text not null default 'guest',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,                       -- null = no expiry
  max_uses    integer not null default 1 check (max_uses between 1 and 100),
  uses        integer not null default 0 check (uses >= 0),
  -- Which device claimed it, and when. A passcode is single use, so this is the whole story of
  -- where it went: if a second device tries the same code, it is already spoken for.
  claimed_by  uuid references auth.users (id) on delete set null,
  claimed_at  timestamptz,
  revoked_at  timestamptz
);
create index if not exists access_codes_active_idx on public.access_codes (revoked_at, expires_at);

create table if not exists public.app_members (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  label       text not null default 'guest',
  is_owner    boolean not null default false,
  granted_at  timestamptz not null default now(),
  code_id     uuid references public.access_codes (id) on delete set null,
  revoked_at  timestamptz
);

-- The owner keeps access without a passcode. Matched by email so no user id is hard-coded.
insert into public.app_members (user_id, label, is_owner)
select id, 'owner', true from auth.users where email = 'panachaithongvinit@gmail.com'
on conflict (user_id) do update set is_owner = true, revoked_at = null;

-- security definer so the policies below can consult membership without recursing through RLS.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.app_members m
     where m.user_id = (select auth.uid()) and m.revoked_at is null
  );
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.app_members m
     where m.user_id = (select auth.uid()) and m.revoked_at is null and m.is_owner
  );
$$;

revoke all on function public.is_member() from public;
revoke all on function public.is_owner() from public;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_owner() to authenticated;

-- ---------------------------------------------------------------- policies

alter table public.access_codes enable row level security;
alter table public.app_members  enable row level security;
grant select on public.access_codes to authenticated;
grant select on public.app_members to authenticated;

-- Only the owner manages codes and members, and only ever through the redeem function otherwise.
-- The hash column is readable but useless without the code itself.
drop policy if exists owner_manage on public.access_codes;
create policy owner_manage on public.access_codes for select to authenticated using (public.is_owner());
drop policy if exists owner_manage on public.app_members;
create policy owner_manage on public.app_members for select to authenticated using (public.is_owner());

-- Reading the app now requires membership rather than any signed-in account.
drop policy if exists owner_read on public.alerts;
create policy member_read on public.alerts for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.push_deliveries;
create policy member_read on public.push_deliveries for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.heartbeats;
create policy member_read on public.heartbeats for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.set_state;
create policy member_read on public.set_state for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.set_holidays;
create policy member_read on public.set_holidays for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.settings;
create policy member_read on public.settings for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.candles;
create policy member_read on public.candles for select to authenticated using (public.is_member());
drop policy if exists owner_read on public.set_macd_history;
create policy member_read on public.set_macd_history for select to authenticated using (public.is_member());

-- Writes were available to every authenticated account. They belong to the owner alone: a guest
-- with a passcode should be able to watch the signals, not rewrite the scanner's configuration.
drop policy if exists owner_write on public.set_holidays;
create policy owner_write on public.set_holidays for insert to authenticated with check (public.is_owner());
drop policy if exists owner_delete on public.set_holidays;
create policy owner_delete on public.set_holidays for delete to authenticated using (public.is_owner());
drop policy if exists owner_update on public.settings;
create policy owner_update on public.settings for update to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- A device subscription still belongs to whoever enrolled it, and now also requires membership,
-- so a revoked guest stops receiving pushes as well as losing the app.
drop policy if exists own_subscriptions on public.push_subscriptions;
create policy own_subscriptions on public.push_subscriptions for all to authenticated
  using ((select auth.uid()) = user_id and public.is_member())
  with check ((select auth.uid()) = user_id and public.is_member());

-- Redemption in one locked step. Checking the code and then counting the use in two round trips
-- would let two devices redeem the same passcode at the same moment; `for update` makes the
-- second one wait and then find the code already claimed.
--
-- The reason for a refusal is returned so a guest holding a real code learns that it was already
-- used rather than being told, unhelpfully, that it is wrong. A code that does not exist reveals
-- nothing, and guessing one is not a threat: the space is 32^12.
create or replace function public.consume_access_code(p_code_hash text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target public.access_codes%rowtype;
begin
  select * into target from public.access_codes where code_hash = p_code_hash for update;
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  if target.revoked_at is not null then return jsonb_build_object('status', 'revoked'); end if;
  if target.expires_at is not null and target.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if target.uses >= target.max_uses then
    -- Already claimed. Re-offering it from the SAME device that still holds access is harmless
    -- and covers a page reload mid-redemption. Anyone else is refused, and so is the original
    -- device once the owner has revoked it: a cancelled guest must not readmit themselves.
    if target.claimed_by = p_user_id and exists (
      select 1 from public.app_members m where m.user_id = p_user_id and m.revoked_at is null
    ) then
      return jsonb_build_object('status', 'granted', 'label', target.label);
    end if;
    return jsonb_build_object('status', 'spent', 'claimed_at', target.claimed_at);
  end if;

  insert into public.app_members (user_id, label, is_owner, code_id, revoked_at)
  values (p_user_id, target.label, false, target.id, null)
  on conflict (user_id) do update
    set label = excluded.label, code_id = excluded.code_id, revoked_at = null;

  update public.access_codes
     set uses = uses + 1,
         claimed_by = coalesce(claimed_by, p_user_id),
         claimed_at = coalesce(claimed_at, now())
   where id = target.id;
  return jsonb_build_object('status', 'granted', 'label', target.label);
end $$;

-- Only the service role, through the access-code function, may redeem.
revoke all on function public.consume_access_code(text, uuid) from public;
