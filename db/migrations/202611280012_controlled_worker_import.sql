-- Stable import identifiers survive subsequent name/contact amendments.
ALTER TABLE public.workers ADD COLUMN import_key text;
CREATE UNIQUE INDEX workers_import_key_unique ON public.workers(business_id,import_key) WHERE import_key IS NOT NULL;
