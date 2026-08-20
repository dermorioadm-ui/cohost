-- =============================================================================
-- 0036 — Não existe teste grátis
-- =============================================================================
-- O produto nasceu com 7 dias de teste: `profiles.subscription_status` já vinha
-- 'trialing', o gatilho de cadastro carimbava `trial_ends_at`, e
-- `subscription_is_active` liberava o acesso enquanto o prazo não vencesse.
--
-- A decisão comercial mudou: a assinatura começa cobrando. Isso precisa valer
-- nos três lugares onde o teste existia, ou ele sobrevive em algum canto.
--
-- CUIDADO QUE ESTA MIGRAÇÃO PRECISOU TER: a conta do dono da plataforma estava
-- 'trialing', e era ela que mantinha `subscription_is_active` verdadeiro. Tirar
-- o ramo do teste sem mais nada derrubaria a página de cadastro do hóspede na
-- mesma transação — com a mensagem "Este cadastro está temporariamente
-- indisponível", que é justamente o erro que acabamos de consertar. Por isso o
-- passo 4 promove quem já estava em teste ANTES de a regra nova valer.
-- =============================================================================

-- ---- 1. conta nova não nasce em teste ---------------------------------------
ALTER TABLE public.profiles
  ALTER COLUMN subscription_status SET DEFAULT 'expired';

COMMENT ON COLUMN public.profiles.subscription_status IS
  'Estado da assinatura no Stripe. Nasce expired — o enum não tem "sem '
  'assinatura", e expired é o valor que já significa isso para '
  'subscription_is_active. Sem teste grátis, o acesso só abre depois do '
  'primeiro pagamento confirmado pelo webhook.';

-- ---- 2. quem já estava em teste vira assinante ------------------------------
-- Feito antes do passo 3 de propósito: entre os dois comandos não pode existir
-- um instante em que a regra nova já vale e a conta ainda está 'trialing'.
UPDATE public.profiles
SET subscription_status = 'active',
    trial_ends_at = NULL
WHERE subscription_status = 'trialing'
  AND trial_ends_at IS NOT NULL
  AND trial_ends_at > now();

-- Diarista tem perfil mas não assina nada — o acesso dela vem do vínculo com o
-- dono, não de assinatura. Sai de 'trialing' para não parecer cliente inadimplente.
UPDATE public.profiles p
SET subscription_status = 'expired',
    trial_ends_at = NULL
WHERE p.subscription_status = 'trialing'
  AND EXISTS (
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id = p.user_id AND r.role = 'cleaner'
  );

-- ---- 3. o portão deixa de aceitar teste -------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_is_active(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- `past_due` continua liberado de propósito: cobrança que falhou é problema
  -- a resolver com o cliente, não motivo para derrubar o cadastro do hóspede
  -- que já está com a viagem marcada. Quem cancela de vez cai em canceled ou
  -- expired pelo webhook, e aí o acesso fecha.
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = _user_id
      AND p.subscription_status IN ('active', 'past_due')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.subscription_is_active(uuid) FROM anon;

COMMENT ON FUNCTION public.subscription_is_active(uuid) IS
  'Assinatura viva? Só active ou past_due. Não existe teste grátis desde a 0036.';

-- ---- 4. o gatilho de cadastro para de carimbar prazo ------------------------
-- `tg_handle_new_user` preenchia trial_started_at/trial_ends_at. Reescrever a
-- função inteira aqui seria arriscado (ela também decide o papel do usuário),
-- então zeramos só o que o teste deixava para trás.
CREATE OR REPLACE FUNCTION public.tg_profile_sem_teste()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.trial_started_at := NULL;
  NEW.trial_ends_at    := NULL;
  IF NEW.subscription_status = 'trialing' THEN
    NEW.subscription_status := 'expired';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tg_profile_sem_teste() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profile_sem_teste ON public.profiles;
CREATE TRIGGER trg_profile_sem_teste
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profile_sem_teste();

-- O índice existia para varrer testes vencendo. Não há mais o que varrer.
DROP INDEX IF EXISTS public.idx_profiles_trial_ends;

-- ---- 5. a conta do dono da plataforma é vitalícia ---------------------------
-- Ela não passa pelo Stripe: não há assinatura para cobrar nem período para
-- vencer. `current_period_end` fica nulo de propósito — é o que impede
-- qualquer varredura futura de tratá-la como ciclo terminado. Como não existe
-- `stripe_subscription_id` nessa linha, nenhum evento do webhook casa com ela,
-- então o estado não volta atrás sozinho.
UPDATE public.profiles
SET subscription_status = 'active',
    plan                = 'ilimitado',
    billing_cycle       = 'annual',
    trial_ends_at       = NULL,
    current_period_end  = NULL
WHERE email = 'dermorioadm@gmail.com';
