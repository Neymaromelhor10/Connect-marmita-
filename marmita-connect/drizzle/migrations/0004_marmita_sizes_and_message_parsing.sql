-- Preços por tamanho (aditivo, com default)
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS price_g NUMERIC NOT NULL DEFAULT 20.00;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS price_p NUMERIC NOT NULL DEFAULT 19.00;
ALTER TABLE public.companies ADD CONSTRAINT companies_price_g_nonneg CHECK (price_g >= 0);
ALTER TABLE public.companies ADD CONSTRAINT companies_price_p_nonneg CHECK (price_p >= 0);

-- Quantidades por tamanho no pedido
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS qty_g INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS qty_p INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD CONSTRAINT orders_qty_g_nonneg CHECK (qty_g >= 0);
ALTER TABLE public.orders ADD CONSTRAINT orders_qty_p_nonneg CHECK (qty_p >= 0);

-- Total calculado no backend: se houver G/P usa a tabela de preços da empresa
CREATE OR REPLACE FUNCTION public.set_order_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
declare
  pg_price numeric;
  pp_price numeric;
begin
  if coalesce(new.qty_g,0) + coalesce(new.qty_p,0) > 0 then
    select price_g, price_p into pg_price, pp_price from public.companies where id = new.company_id;
    new.quantity := coalesce(new.qty_g,0) + coalesce(new.qty_p,0);
    new.total := round(coalesce(new.qty_g,0) * coalesce(pg_price,0) + coalesce(new.qty_p,0) * coalesce(pp_price,0), 2);
    new.unit_price := round(new.total / greatest(new.quantity,1), 2);
  else
    new.total := round(coalesce(new.quantity,0) * coalesce(new.unit_price,0), 2);
  end if;
  return new;
end;
$$;

-- Mensagens interpretadas: revisão manual e anti-duplicação
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ignorado';
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS qty_g INTEGER;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS qty_p INTEGER;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS fiado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS order_date DATE;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS message_uid TEXT;
ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_status_check
  CHECK (status IN ('registrado','revisar','ignorado','erro'));

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_uid_unique
  ON public.whatsapp_messages (company_id, message_uid) WHERE message_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_messages_status_idx
  ON public.whatsapp_messages (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_company_date_idx ON public.orders (company_id, order_date DESC);
