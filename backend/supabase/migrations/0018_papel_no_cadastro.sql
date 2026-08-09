-- O papel do usuário era gravado pelo navegador logo após o cadastro. Com a
-- confirmação de e-mail ligada, o cadastro não devolve sessão, então aquela
-- gravação saía sem autenticação e a RLS recusava — em silêncio. Resultado:
-- conta criada, perfil criado, e nenhum papel. O usuário entrava sem ser nada.
--
-- Papel é decisão do servidor. Passa para o mesmo gatilho que cria o perfil,
-- onde roda como SECURITY DEFINER e não depende de sessão nenhuma.

CREATE OR REPLACE FUNCTION public.tg_handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _trial_days int := COALESCE(public.app_setting('trial_days', '7')::int, 7);
  _code       text;
  _role       public.app_role;
BEGIN
  LOOP
    _code := upper(substr(public.generate_token(6), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = _code);
  END LOOP;

  INSERT INTO public.profiles (
    user_id, email, full_name, phone_e164,
    trial_started_at, trial_ends_at, subscription_status, referral_code
  ) VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    public.normalize_phone(NEW.raw_user_meta_data ->> 'whatsapp'),
    now(),
    now() + make_interval(days => _trial_days),
    'trialing',
    _code
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Quem chega por convite de diarista se identifica no metadado; todo o
  -- resto que cria conta pela tela pública é dono. 'admin' nunca vem daqui —
  -- é concedido à mão, para não existir caminho de auto-promoção.
  _role := CASE
             WHEN NEW.raw_user_meta_data ->> 'role' = 'cleaner' THEN 'cleaner'::public.app_role
             ELSE 'owner'::public.app_role
           END;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, _role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Conserta quem já se cadastrou antes desta correção e ficou sem papel.
INSERT INTO public.user_roles (user_id, role)
SELECT p.user_id, 'owner'::public.app_role
FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id)
ON CONFLICT (user_id, role) DO NOTHING;
