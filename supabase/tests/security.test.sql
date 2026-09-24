-- Security tests: deny by default RLS, admin only access, server only functions, order lookup rules.
-- Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- Two users: an admin and a normal customer account.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@example.com', now(), now()),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'customer@example.com', now(), now());
insert into public.store_admins (user_id) values ('00000000-0000-4000-8000-0000000000a1');

-- 1. anon (the public browser key) gets nothing, from any table -------------------------------------------
set local role anon;
select throws_ok('select * from public.products', '42501', null, 'anon cannot read products');
select throws_ok('select * from public.orders', '42501', null, 'anon cannot read orders');
select throws_ok('select * from public.order_items', '42501', null, 'anon cannot read order items');
select throws_ok('select * from public.knowledge_docs', '42501', null, 'anon cannot read knowledge docs');
select throws_ok('select * from public.knowledge_chunks', '42501', null, 'anon cannot read chunks');
select throws_ok('select * from public.conversations', '42501', null, 'anon cannot read conversations');
select throws_ok('select * from public.messages', '42501', null, 'anon cannot read messages');
select throws_ok('select * from public.rate_limits', '42501', null, 'anon cannot read rate limits');
select throws_ok('select * from public.store_admins', '42501', null, 'anon cannot read admins');
select throws_ok($$insert into public.products (sku, name, category, price_cents, description) values ('X', 'x', 'coffee', 1, 'x')$$, '42501', null, 'anon cannot insert products');

select throws_ok($$select public.am_i_admin()$$, '42501', null, 'anon cannot call am_i_admin');

-- 2. anon cannot call the server functions -----------------------------------------------------------------
select throws_ok($$select * from public.lookup_order('EO-10001', 'maya.lopez@example.com')$$, '42501', null, 'anon cannot call lookup_order');
select throws_ok($$select * from public.get_products('coffee', null)$$, '42501', null, 'anon cannot call get_products');
select throws_ok($$select public.hit_rate_limit('k', 1, 60)$$, '42501', null, 'anon cannot call hit_rate_limit');
select throws_ok($$select public.is_rate_limited('k', 1, 60)$$, '42501', null, 'anon cannot call is_rate_limited');
select throws_ok($$select * from public.hybrid_search('coffee', array_fill(0, array[768])::extensions.vector, 3)$$, '42501', null, 'anon cannot call hybrid_search');

-- 3. a signed in customer who is not an admin sees no rows and cannot write ------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
select is((select count(*) from public.products), 0::bigint, 'non admin sees no products');
select is((select count(*) from public.orders), 0::bigint, 'non admin sees no orders');
select is((select count(*) from public.messages), 0::bigint, 'non admin sees no messages');
select throws_ok($$insert into public.products (sku, name, category, price_cents, description) values ('X', 'x', 'coffee', 1, 'x')$$, '42501', null, 'non admin cannot insert products');
select lives_ok($$update public.products set price_cents = 1$$, 'non admin update runs but is filtered by RLS');
select throws_ok($$select * from public.lookup_order('EO-10001', 'maya.lopez@example.com')$$, '42501', null, 'signed in user cannot call lookup_order');
select throws_ok($$select * from public.store_admins$$, '42501', null, 'signed in user cannot read the admin list');
select is(public.am_i_admin(), false, 'a customer account is not an admin');

-- 4. an admin sees the data through the dashboard session ------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
select is(public.am_i_admin(), true, 'the admin account is recognised');
select is((select count(*) from public.products), 24::bigint, 'admin sees all products');
select is((select count(*) from public.products where price_cents = 1), 0::bigint, 'the non admin update changed nothing');
select is((select count(*) from public.orders), 14::bigint, 'admin sees all orders');
select lives_ok($$update public.products set stock_qty = stock_qty where sku = 'EO-COF-001'$$, 'admin can update products');
select throws_ok($$delete from public.orders$$, '42501', null, 'admin cannot delete orders (no grant)');

-- 5. the service role (server routes) uses the functions correctly ---------------------------------------
reset role;
set local role service_role;
select is((select count(*) from public.lookup_order('EO-10002', 'sam.okafor@example.com')), 1::bigint, 'right order and email returns the order');
select is((select count(*) from public.lookup_order('eo-10002', 'SAM.OKAFOR@EXAMPLE.COM')), 1::bigint, 'order number and email match ignoring case');
select is((select count(*) from public.lookup_order('EO-10002', 'someone.else@example.com')), 0::bigint, 'right order with wrong email returns nothing');
select is((select count(*) from public.lookup_order('EO-99999', 'sam.okafor@example.com')), 0::bigint, 'unknown order returns nothing');
select is((select sku from public.get_products(null, 'eo-cof-001')), 'EO-COF-001', 'get_products finds a sku ignoring case');
select is((select in_stock from public.get_products('sumatra', null)), false, 'sold out product reports not in stock');
select is((select count(*) from public.get_products('coffee', null)), 5::bigint, 'get_products is capped at 5 rows');
select is((select count(*) from public.get_products(null, null, 'coffee') where name ilike '%scale%'), 0::bigint, 'category filter excludes gear whose name contains coffee');
select is((select count(*) from public.get_products(null, null, 'gear')), 5::bigint, 'category filter returns gear only');
select is(public.hit_rate_limit('test-key', 2, 60), true, 'rate limit: first call allowed');
select is(public.hit_rate_limit('test-key', 2, 60), true, 'rate limit: second call allowed');
select is(public.hit_rate_limit('test-key', 2, 60), false, 'rate limit: third call refused');
select is(public.is_rate_limited('fresh-key', 2, 60), false, 'is_rate_limited: an unseen key is not limited');
select is(public.is_rate_limited('test-key', 2, 60), true, 'is_rate_limited: a key at its limit is limited');
select is(public.is_rate_limited('test-key', 5, 60), false, 'is_rate_limited: below the limit is not limited');
select is((select count from public.rate_limits where key = 'test-key'), 3, 'is_rate_limited does not increment the counter');

select * from finish();
rollback;
