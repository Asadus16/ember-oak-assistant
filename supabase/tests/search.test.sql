-- Hybrid search behaviour with synthetic vectors. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

-- Hermetic: ignore any real documents that were ingested. This runs inside a transaction that is rolled back.
delete from public.knowledge_docs;

insert into public.knowledge_docs (id, kind, slug, title, body, published, content_hash) overriding system value values
  (9001, 'policy', 'test-shipping', 'Test Shipping', 'x', true, 'h1'),
  (9002, 'guide', 'test-secret', 'Test Unpublished', 'x', false, 'h2'),
  (9003, 'guide', 'test-brewing', 'Test Brewing', 'x', true, 'h3');

-- Vectors: one hot dimension each, so cosine distance is easy to reason about.
create function pg_temp.vec(hot int) returns extensions.vector language sql as $$
  select (array_fill(0::float4, array[hot - 1]) || array[1::float4] || array_fill(0::float4, array[768 - hot]))::extensions.vector
$$;

insert into public.knowledge_chunks (doc_id, chunk_index, heading, content, embedding, embedding_model) values
  (9001, 0, 'Costs', 'Standard shipping is free over fifty dollars.', pg_temp.vec(1), 'test'),
  (9002, 0, null, 'Secret unpublished shipping note.', pg_temp.vec(1), 'test'),
  (9003, 0, 'V60', 'Grind medium fine and pour slowly for the pour over.', pg_temp.vec(2), 'test'),
  (9003, 1, 'Cold', 'Steep coarse grounds overnight in cold water.', pg_temp.vec(3), 'test');

set local role service_role;

select is((select doc_slug from public.hybrid_search('zzz', pg_temp.vec(2), 1)), 'test-brewing',
  'semantic only: the nearest vector wins when no words match');
select is((select doc_slug from public.hybrid_search('free shipping', pg_temp.vec(768), 1)), 'test-shipping',
  'full text only: matching words win when the vector is far');
select is((select count(*) from public.hybrid_search('shipping', pg_temp.vec(1), 10) where doc_slug = 'test-secret'), 0::bigint,
  'unpublished documents are never returned');
select is((select doc_slug from public.hybrid_search('shipping', pg_temp.vec(1), 1)), 'test-shipping',
  'when words and vector agree the chunk ranks first');
select cmp_ok((select count(*) from public.hybrid_search('pour over cold', pg_temp.vec(2), 10)), '>=', 2::bigint,
  'both signals contribute results');
select cmp_ok((select count(*) from public.hybrid_search('anything', pg_temp.vec(1), 500)), '<=', 20::bigint,
  'result count is capped at 20');
select is((select score > 0 from public.hybrid_search('shipping', pg_temp.vec(1), 1)), true, 'scores are positive');

select * from finish();
rollback;
