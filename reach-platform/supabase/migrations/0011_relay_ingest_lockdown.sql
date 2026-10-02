-- REACH 0011: close the legacy relay ingest path.
--
-- 0002/0003 created public.ingest_relay_packet(jsonb) and granted EXECUTE to `authenticated`.
-- 0003's later redefinition kept that grant, and no later migration revoked it. That function
-- inserts into public.relay_packets without verifying the source device registration, the
-- packet fingerprint or any signature — checks that only exist in the Edge Function and in
-- ingest_relay_packet_service(). A signed-in client could therefore POST /rest/v1/rpc/
-- ingest_relay_packet directly and create arbitrary relay packets, bypassing the whole
-- verification chain.
--
-- All ingestion now goes through the Edge Function, which verifies signatures and calls
-- ingest_relay_packet_service() with the service role. The legacy entry point is left in place
-- (dropping it could break external callers) but is no longer reachable by client roles.
revoke all on function public.ingest_relay_packet(jsonb) from public;
revoke all on function public.ingest_relay_packet(jsonb) from anon;
revoke all on function public.ingest_relay_packet(jsonb) from authenticated;
grant execute on function public.ingest_relay_packet(jsonb) to service_role;
