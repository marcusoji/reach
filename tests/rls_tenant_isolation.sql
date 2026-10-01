-- REACH RLS tenant isolation suite
-- Run in staging SQL editor AFTER creating two institutions and users.
-- Replace UUIDs with real test fixtures.

-- Prerequisites (manual setup):
--   institution_a, institution_b
--   citizen_a, citizen_b, staff_a, desk_a, admin_a, operator

\echo '=== RLS isolation checklist (document pass/fail manually or via pgTAP) ==='

-- 1) Citizen cannot update own role
-- SET request.jwt.claim.sub = '<citizen_a_id>';
-- UPDATE profiles SET role = 'operator' WHERE id = '<citizen_a_id>';
-- Expect: 0 rows or policy error

-- 2) Citizen A cannot read institution B incidents
-- SELECT count(*) FROM incidents WHERE institution_id = '<institution_b>';
-- Expect: 0

-- 3) Staff A cannot assign on institution B
-- Expect: policy violation

-- 4) Audit logs not insertable by authenticated client
-- INSERT INTO audit_logs(...) ;
-- Expect: fail

-- 5) Operator can SELECT across tenants (read-only paths)
-- Expect: rows from both institutions on ops views only

-- 6) Relay packets wrong institution rejected at API (not only RLS)

-- Helper: list policies
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
