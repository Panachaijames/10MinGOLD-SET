-- Data API writes run as service_role. The alert trigger must call the non-exposed ops schema
-- without granting that role general access to operational functions or Vault helpers.
-- Run only this narrowly scoped trigger wrapper with its postgres owner's privileges.
create or replace function ops.alerts_notify() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ops.invoke_function(
    'push-fanout',
    jsonb_build_object('type', 'INSERT', 'table', 'alerts', 'record', to_jsonb(new)),
    5000
  );
  return new;
end $$;

alter function ops.alerts_notify() owner to postgres;
revoke all on function ops.alerts_notify() from public, anon, authenticated, service_role;
