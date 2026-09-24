-- The private schema is not exposed to the API, so the dashboard asks this wrapper whether the signed in
-- user is a store admin. Anonymous callers cannot execute it.
create function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin()
$$;

revoke all on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;
