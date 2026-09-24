-- Read only check of a rate limit counter, so a limit can count only FAILED attempts.
-- (hit_rate_limit increments; this only looks.)
create function public.is_rate_limited(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select r.count >= p_limit
       from public.rate_limits r
      where r.key = p_key
        and r.window_start = to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds)),
    false)
$$;

revoke all on function public.is_rate_limited(text, integer, integer) from public, anon, authenticated;
grant execute on function public.is_rate_limited(text, integer, integer) to service_role;
