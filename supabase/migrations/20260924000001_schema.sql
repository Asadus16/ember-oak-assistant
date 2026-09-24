-- Ember & Oak store assistant: schema, deny by default RLS, and server only functions.
--
-- Security model (see README):
--   * Every table has RLS enabled. anon and authenticated get NO default access.
--   * Store admins (rows in store_admins) may use the /admin dashboard through the normal user
--     session, governed by the policies below.
--   * The public chat and WhatsApp routes run on the server with the service role key and call only
--     the functions at the bottom of this file. The model never writes SQL and never sees a table.

create extension if not exists vector with schema extensions;
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------
create table public.store_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create function private.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.store_admins where user_id = (select auth.uid())
  )
$$;

revoke all on function private.is_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Catalog and orders (live facts: price, stock and order status come from here, never from embeddings)
-- ---------------------------------------------------------------------------
create table public.products (
  sku text primary key,
  name text not null,
  category text not null check (category in ('coffee', 'gear', 'accessory', 'subscription', 'gift')),
  price_cents integer not null check (price_cents >= 0),
  stock_qty integer not null default 0 check (stock_qty >= 0),
  description text not null,
  published boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.orders (
  id bigint generated always as identity primary key,
  order_number text not null unique,
  customer_email text not null,
  status text not null check (status in ('processing', 'roasting', 'shipped', 'delivered', 'cancelled', 'refunded')),
  placed_at timestamptz not null,
  carrier text,
  tracking_number text,
  estimated_delivery date,
  total_cents integer not null check (total_cents >= 0)
);
create index orders_email_idx on public.orders (lower(customer_email));

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  sku text not null references public.products (sku),
  qty integer not null check (qty > 0)
);
create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- Knowledge base (guides, policies, FAQ and one descriptive doc per product)
-- Embeddings are gemini-embedding-2 at 768 dimensions. embedding_model is stored because vectors from
-- different embedding models are not comparable and must be re embedded together.
-- ---------------------------------------------------------------------------
create table public.knowledge_docs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('product', 'guide', 'policy', 'faq')),
  slug text not null unique,
  title text not null,
  product_sku text references public.products (sku) on delete cascade,
  body text not null,
  published boolean not null default true,
  content_hash text not null,
  updated_at timestamptz not null default now()
);

create table public.knowledge_chunks (
  id bigint generated always as identity primary key,
  doc_id bigint not null references public.knowledge_docs (id) on delete cascade,
  chunk_index integer not null,
  heading text,
  content text not null,
  fts tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
  embedding extensions.vector(768),
  embedding_model text,
  unique (doc_id, chunk_index)
);
create index knowledge_chunks_doc_idx on public.knowledge_chunks (doc_id);
create index knowledge_chunks_fts_idx on public.knowledge_chunks using gin (fts);
create index knowledge_chunks_embedding_idx on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Conversation log (for the owner dashboard and evals). Emails are masked by the app before insert.
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('web', 'whatsapp')),
  external_id text,
  created_at timestamptz not null default now()
);
create unique index conversations_channel_external_idx
  on public.conversations (channel, external_id) where external_id is not null;

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  tools jsonb not null default '[]'::jsonb,
  outcome text check (outcome in ('answered', 'refused', 'fallback', 'error', 'rate_limited')),
  model text,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, id);

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------
-- RLS: on everywhere, nothing granted by default, then only what admins need.
-- ---------------------------------------------------------------------------
alter table public.store_admins enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.knowledge_docs enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.rate_limits enable row level security;

-- Default grants in Supabase give anon and authenticated access to new tables. Policies alone do not
-- remove a grant, so revoke first, then grant only what is needed.
revoke all on table
  public.store_admins, public.products, public.orders, public.order_items,
  public.knowledge_docs, public.knowledge_chunks, public.conversations,
  public.messages, public.rate_limits
from anon, authenticated;

grant select, insert, update, delete on public.products, public.knowledge_docs, public.knowledge_chunks to authenticated;
grant select on public.orders, public.order_items, public.conversations, public.messages to authenticated;

create policy "admins manage products" on public.products
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "admins manage knowledge docs" on public.knowledge_docs
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "admins manage knowledge chunks" on public.knowledge_chunks
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "admins read orders" on public.orders
  for select to authenticated using ((select private.is_admin()));

create policy "admins read order items" on public.order_items
  for select to authenticated using ((select private.is_admin()));

create policy "admins read conversations" on public.conversations
  for select to authenticated using ((select private.is_admin()));

create policy "admins read messages" on public.messages
  for select to authenticated using ((select private.is_admin()));

-- store_admins and rate_limits have RLS on and no policies: only the service role can touch them.

-- ---------------------------------------------------------------------------
-- Server only functions (service role). Execute is revoked from everyone else because functions are
-- executable by public by default.
-- ---------------------------------------------------------------------------

-- Hybrid search: full text plus semantic, merged with reciprocal rank fusion. Adapted from the Supabase
-- hybrid search guide (function shape and RRF formula) to this schema, cosine distance and published docs.
create function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(768),
  match_count integer default 6,
  full_text_weight double precision default 1,
  semantic_weight double precision default 1,
  rrf_k integer default 50
)
returns table (
  chunk_id bigint,
  doc_id bigint,
  doc_slug text,
  doc_kind text,
  doc_title text,
  heading text,
  content text,
  score double precision
)
language sql
stable
set search_path = ''
as $$
  with full_text as (
    select c.id,
      row_number() over (order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc) as rank_ix
    from public.knowledge_chunks c
    join public.knowledge_docs d on d.id = c.doc_id
    where d.published and c.fts @@ websearch_to_tsquery('english', query_text)
    order by rank_ix
    limit least(match_count, 20) * 2
  ),
  semantic as (
    select c.id,
      row_number() over (order by c.embedding operator(extensions.<=>) query_embedding) as rank_ix
    from public.knowledge_chunks c
    join public.knowledge_docs d on d.id = c.doc_id
    where d.published and c.embedding is not null
    order by rank_ix
    limit least(match_count, 20) * 2
  )
  select
    c.id, d.id, d.slug, d.kind, d.title, c.heading, c.content,
    (coalesce(1.0 / (rrf_k + f.rank_ix), 0.0) * full_text_weight
      + coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight)::double precision as score
  from full_text f
  full outer join semantic s on f.id = s.id
  join public.knowledge_chunks c on c.id = coalesce(f.id, s.id)
  join public.knowledge_docs d on d.id = c.doc_id
  order by score desc
  limit least(match_count, 20)
$$;

create function public.get_products(p_query text default null, p_sku text default null, p_category text default null)
returns table (sku text, name text, category text, price_cents integer, stock_qty integer, in_stock boolean)
language sql
stable
set search_path = ''
as $$
  select p.sku, p.name, p.category, p.price_cents, p.stock_qty, p.stock_qty > 0
  from public.products p
  where p.published
    and (p_sku is null or p.sku = upper(p_sku))
    and (p_category is null or p.category = p_category)
    and (p_query is null
         or p.name ilike '%' || p_query || '%'
         or p.category ilike '%' || p_query || '%'
         or p.sku = upper(p_query))
  order by p.name
  limit 5
$$;

-- Returns nothing unless BOTH the order number and the email match. Returns no name or address.
create function public.lookup_order(p_order_number text, p_email text)
returns table (
  order_number text,
  status text,
  placed_at timestamptz,
  carrier text,
  tracking_number text,
  estimated_delivery date,
  total_cents integer,
  items jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    o.order_number, o.status, o.placed_at, o.carrier, o.tracking_number, o.estimated_delivery, o.total_cents,
    (select coalesce(jsonb_agg(jsonb_build_object('sku', i.sku, 'name', p.name, 'qty', i.qty)), '[]'::jsonb)
       from public.order_items i join public.products p on p.sku = i.sku
      where i.order_id = o.id)
  from public.orders o
  where o.order_number = upper(p_order_number)
    and lower(o.customer_email) = lower(p_email)
$$;

-- Fixed window counter. Returns true while the caller is within the limit.
create function public.hit_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_count <= p_limit;
end
$$;

revoke all on function public.hybrid_search(text, extensions.vector, integer, double precision, double precision, integer) from public, anon, authenticated;
revoke all on function public.get_products(text, text, text) from public, anon, authenticated;
revoke all on function public.lookup_order(text, text) from public, anon, authenticated;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;

grant execute on function public.hybrid_search(text, extensions.vector, integer, double precision, double precision, integer) to service_role;
grant execute on function public.get_products(text, text, text) to service_role;
grant execute on function public.lookup_order(text, text) to service_role;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
