-- Configuração que a página de vendas lê sem login (WhatsApp do botão
-- flutuante e do formulário). Vive em app_settings, que não é pública; só as
-- chaves desta lista saem para o anônimo, e a RPC é a única porta.
--
-- O valor também pode vir de VITE_WHATSAPP no build da Vercel; o banco é o
-- caminho para trocar o número sem novo deploy.
INSERT INTO public.app_settings (key, value, description)
VALUES ('landing_whatsapp', '5521998215198', 'WhatsApp (E.164, só dígitos) do botão flutuante e do formulário da página de vendas')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.landing_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM public.app_settings
  WHERE key IN ('landing_whatsapp');
$$;

REVOKE ALL ON FUNCTION public.landing_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landing_config() TO anon, authenticated, service_role;
