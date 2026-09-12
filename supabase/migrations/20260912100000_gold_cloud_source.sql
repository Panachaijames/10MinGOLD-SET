-- The cloud failover scanner writes alerts under its own producer name, so the PWA and the
-- alert history can tell a broker-fed signal from a spot-fed one.
-- Kept in its own migration: a new enum value cannot be used in the transaction that adds it.
alter type public.alert_source add value if not exists 'gold_cloud';
