#!/usr/bin/env bash
#
# Sobe o backend num projeto Supabase NOVO e publica o frontend na Vercel.
#
# Uso:
#   cd backend && cp .env.example .env && $EDITOR .env
#   ./deploy.sh
#
# O script é idempotente: pode rodar de novo depois de corrigir um erro.
# Ele NUNCA aplica nada num projeto que já tenha as tabelas do app antigo —
# a checagem de segurança na etapa 2 aborta se encontrar.

set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# 0. Pré-requisitos
# ---------------------------------------------------------------------------
for cmd in supabase psql; do
  command -v "$cmd" >/dev/null || { echo "❌ Falta instalar: $cmd"; exit 1; }
done

[ -f .env ] || { echo "❌ Crie o .env a partir do .env.example"; exit 1; }
set -a; source .env; set +a

for var in SUPABASE_PROJECT_ID SUPABASE_DB_URL CRON_SECRET; do
  [ -n "${!var:-}" ] || { echo "❌ Defina $var no .env"; exit 1; }
done

echo "▸ Projeto de destino: $SUPABASE_PROJECT_ID"

# ---------------------------------------------------------------------------
# 1. Trava de segurança — nunca aplicar sobre o app que está no ar
# ---------------------------------------------------------------------------
echo "▸ Verificando se o projeto está vazio…"

EXISTING=$(psql "$SUPABASE_DB_URL" -tAc "
  SELECT count(*) FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('profiles','properties','user_roles','cleaning_tasks','connections');
")

if [ "$EXISTING" -gt 0 ] && [ "${FORCE_OVERWRITE:-}" != "eu-sei-o-que-estou-fazendo" ]; then
  cat <<'AVISO'

❌ ABORTADO — este projeto já tem tabelas do app atual.

   Aplicar aqui vai colidir com profiles, properties, user_roles,
   cleaning_tasks e connections, e pode apagar dados de clientes reais.

   Use um projeto Supabase NOVO. Se este É o projeto novo e as tabelas
   vieram de uma tentativa anterior, limpe antes:

     psql "$SUPABASE_DB_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
     psql "$SUPABASE_DB_URL" -c 'DROP SCHEMA IF EXISTS private CASCADE;'

AVISO
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Migrations, na ordem
# ---------------------------------------------------------------------------
echo "▸ Aplicando migrations…"
for file in supabase/migrations/*.sql; do
  echo "  · $(basename "$file")"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$file"
done
echo "  ✓ schema aplicado"

# ---------------------------------------------------------------------------
# 3. Segredos das functions
# ---------------------------------------------------------------------------
echo "▸ Publicando segredos…"
supabase secrets set --project-ref "$SUPABASE_PROJECT_ID" \
  APP_BASE_URL="${APP_BASE_URL:-}" \
  APP_TIMEZONE="${APP_TIMEZONE:-America/Sao_Paulo}" \
  CRON_SECRET="$CRON_SECRET" \
  STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}" \
  STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}" \
  AI_PROVIDER="${AI_PROVIDER:-anthropic}" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  GOOGLE_AI_API_KEY="${GOOGLE_AI_API_KEY:-}" \
  EMAIL_PROVIDER="${EMAIL_PROVIDER:-resend}" \
  RESEND_API_KEY="${RESEND_API_KEY:-}" \
  EMAIL_FROM_ADDRESS="${EMAIL_FROM_ADDRESS:-}" \
  EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-HospedePay}" \
  WHATSAPP_ENABLED="${WHATSAPP_ENABLED:-false}" \
  PORTER_ENABLED="${PORTER_ENABLED:-true}" \
  PORTER_API_BASE_URL="${PORTER_API_BASE_URL:-https://api.cloud.kiper.com.br}" \
  >/dev/null
echo "  ✓ segredos publicados"

# ---------------------------------------------------------------------------
# 4. Edge functions
# ---------------------------------------------------------------------------
echo "▸ Publicando edge functions…"
supabase functions deploy --project-ref "$SUPABASE_PROJECT_ID"
echo "  ✓ functions publicadas"

# ---------------------------------------------------------------------------
# 5. Ligar o cron (o passo que não pode ficar no código)
# ---------------------------------------------------------------------------
echo "▸ Configurando os jobs…"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO private.job_config (id, functions_url, cron_secret)
VALUES (1, 'https://$SUPABASE_PROJECT_ID.supabase.co/functions/v1', '$CRON_SECRET')
ON CONFLICT (id) DO UPDATE
  SET functions_url = EXCLUDED.functions_url,
      cron_secret   = EXCLUDED.cron_secret,
      updated_at    = now();
SQL

echo "  ✓ jobs agendados:"
psql "$SUPABASE_DB_URL" -tAc "SELECT '    · ' || jobname || '  (' || schedule || ')' FROM cron.job ORDER BY jobname;"

# ---------------------------------------------------------------------------
# 6. Preços do Stripe (opcional — sem isto o checkout não funciona)
# ---------------------------------------------------------------------------
if [ -n "${STRIPE_PRICE_ESSENCIAL_MONTHLY:-}" ]; then
  echo "▸ Vinculando preços do Stripe…"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q <<SQL
UPDATE public.plans SET stripe_price_monthly='${STRIPE_PRICE_ESSENCIAL_MONTHLY}',
       stripe_price_annual='${STRIPE_PRICE_ESSENCIAL_ANNUAL:-}' WHERE tier='essencial';
UPDATE public.plans SET stripe_price_monthly='${STRIPE_PRICE_PRO_MONTHLY:-}',
       stripe_price_annual='${STRIPE_PRICE_PRO_ANNUAL:-}' WHERE tier='pro';
UPDATE public.plans SET stripe_price_monthly='${STRIPE_PRICE_ILIMITADO_MONTHLY:-}',
       stripe_price_annual='${STRIPE_PRICE_ILIMITADO_ANNUAL:-}' WHERE tier='ilimitado';
SQL
  echo "  ✓ preços vinculados"
else
  echo "▸ Preços do Stripe não informados — o checkout fica indisponível até preencher."
fi

# ---------------------------------------------------------------------------
# 7. Fumaça
# ---------------------------------------------------------------------------
echo "▸ Teste de fumaça…"
BASE="https://$SUPABASE_PROJECT_ID.supabase.co/functions/v1"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/job-sync-ical" \
  -H "x-cron-secret: $CRON_SECRET" -H 'Content-Type: application/json' -d '{}')
[ "$CODE" = "200" ] && echo "  ✓ job-sync-ical respondeu 200" \
                    || echo "  ⚠ job-sync-ical respondeu $CODE — veja os logs"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/job-sync-ical" \
  -H 'x-cron-secret: errado' -H 'Content-Type: application/json' -d '{}')
[ "$CODE" = "403" ] && echo "  ✓ segredo errado é rejeitado" \
                    || echo "  ⚠ segredo errado devolveu $CODE (esperado 403)"

cat <<FIM

──────────────────────────────────────────────────────────────
✓ Backend no ar em https://$SUPABASE_PROJECT_ID.supabase.co

Falta, fora deste script:

  1. Webhook do Stripe apontando para
     $BASE/stripe-webhook
     (eventos: checkout.session.completed, customer.subscription.*,
      invoice.paid, invoice.payment_failed)

  2. Frontend: em .env na raiz do repositório, trocar
     VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY
     para os deste projeto novo — e então publicar na Vercel:

       vercel --prod

     ATENÇÃO: o frontend atual foi escrito para o schema ANTIGO.
     Ele não funciona contra este banco sem adaptação. Suba primeiro
     em preview (vercel) e vá corrigindo tela por tela.
──────────────────────────────────────────────────────────────
FIM
