-- Vínculo empresa <-> número passa a ser gravado somente pelo backend, após validação na Meta.
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_connections FROM authenticated, anon;
GRANT SELECT ON public.whatsapp_connections TO authenticated;
GRANT ALL ON public.whatsapp_connections TO service_role;
DROP POLICY IF EXISTS "company whatsapp connections" ON public.whatsapp_connections;
CREATE POLICY "company whatsapp connections read" ON public.whatsapp_connections
  FOR SELECT TO authenticated USING (company_id = public.current_company_id());
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS display_phone_number text;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_one_per_company ON public.whatsapp_connections(company_id);