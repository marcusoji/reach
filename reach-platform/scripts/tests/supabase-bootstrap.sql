-- Minimal Supabase scaffolding so the REACH migrations can run on a plain Postgres+PostGIS
-- instance during validation. Reproduces the pieces the migrations depend on: the auth
-- schema, auth.uid()/auth.role(), the anon/authenticated/service_role roles, and the
-- supabase_realtime publication.

-- Supabase installs extensions into a dedicated `extensions` schema, NOT public, and its
-- default search_path is `"$user", public, extensions`. Functions here pin
-- `set search_path=public`, so an extension function called from inside one resolves only if
-- the extension schema is also on the function's path. Installing pgcrypto in public (as this
-- fixture used to) hides that whole class of production-only failure, so mirror Supabase.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

-- Supabase exposes auth.jwt() (full claims as jsonb). Migrations 0009+ rely on it.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

do $$ begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Supabase Storage scaffolding. Migration 0017 creates the 'incident-evidence' bucket and its
-- object policies, so the objects/buckets tables and storage.foldername() must exist here.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  metadata jsonb
);

alter table storage.objects enable row level security;

-- Supabase's helper: splits an object path into its folder segments.
create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end $$;

grant usage on schema storage to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
