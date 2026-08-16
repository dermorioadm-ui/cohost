-- =============================================================================
-- 0025 — A portaria digital passa a gerar o código de acesso (TOTP)
-- =============================================================================
-- Entre 10 e 13/ago/2026 a Kiper passou a exigir, em InsertDwellerFromMobile,
-- um `otp` de 6 dígitos que troca a cada 30 s — o mesmo esquema do app do banco
-- (TOTP, RFC 6238). Até então a chamada passava sem código nenhum; o backend
-- antigo nunca mandou esse header, e por isso todo cadastro começou a voltar
-- "Usuário não autorizado, token inválido." da noite para o dia.
--
-- O app calcula esse código a partir de um segredo (`keyHash`) que a Kiper
-- devolve na resposta do login (/auth/activate). É um segredo compartilhado,
-- não uma chave presa ao aparelho — então o servidor consegue gerar o mesmo
-- código, e a integração volta a rodar sozinha.
--
-- Algoritmo confirmado contra códigos reais capturados do app: HMAC-SHA1,
-- janela de 30 s, 6 dígitos, semente = base32(keyHash) — 64 bytes.
--
-- O segredo é tão sensível quanto o token: fica em porter_accounts (sem policy
-- de SELECT) e as funções abaixo só podem ser executadas pelo service_role, na
-- hora em que o job monta a chamada. Ninguém lê o segredo de volta, nem o dono.
-- =============================================================================

-- Duas colunas novas na conta da portaria:
--   porter_totp_secret     — a semente (keyHash) da resposta do login
--   porter_app_device_id   — o appdeviceid que o app registrou no activate;
--                            a Kiper confere junto com o token
ALTER TABLE public.porter_accounts
  ADD COLUMN IF NOT EXISTS porter_totp_secret   text,
  ADD COLUMN IF NOT EXISTS porter_app_device_id text;

-- -----------------------------------------------------------------------------
-- base32 (RFC 4648) -> bytea. Sem dependência externa: decodifica caractere a
-- caractere pela tabela padrão.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.porter_b32decode(secret text)
RETURNS bytea AS $$
DECLARE
  alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  bitstr   text := '';
  i int; v int; nbytes int; hexstr text := ''; bytev int;
BEGIN
  secret := upper(regexp_replace(secret, '=+$', ''));
  FOR i IN 1..length(secret) LOOP
    v := position(substr(secret, i, 1) in alphabet) - 1;
    IF v < 0 THEN CONTINUE; END IF;      -- ignora caractere fora do alfabeto
    bitstr := bitstr || (v::bit(5))::text;
  END LOOP;
  nbytes := length(bitstr) / 8;          -- descarta bits de padding
  FOR i IN 0..nbytes - 1 LOOP
    bytev  := (substr(bitstr, i*8 + 1, 8))::bit(8)::int;
    hexstr := hexstr || lpad(to_hex(bytev), 2, '0');
  END LOOP;
  RETURN decode(hexstr, 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- -----------------------------------------------------------------------------
-- TOTP no instante `_at` (default: agora). O job chama sem argumento; o
-- parâmetro existe para reprodutibilidade em teste.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.porter_totp(_secret text, _at timestamptz DEFAULT now())
RETURNS text AS $$
DECLARE
  key     bytea  := public.porter_b32decode(_secret);
  counter bigint := floor(extract(epoch from _at) / 30);
  ctr     bytea  := decode(lpad(to_hex(counter), 16, '0'), 'hex');
  mac     bytea  := extensions.hmac(ctr, key, 'sha1');
  off     int    := get_byte(mac, length(mac) - 1) & 15;
  bin     bigint := ((get_byte(mac, off) & 127)::bigint << 24)
                  | (get_byte(mac, off + 1)::bigint << 16)
                  | (get_byte(mac, off + 2)::bigint << 8)
                  |  get_byte(mac, off + 3)::bigint;
BEGIN
  RETURN lpad((bin % 1000000)::text, 6, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- O segredo não pode ser exposto a cliente nenhum. Só o service_role (o job)
-- executa estas funções; a semente vem de porter_accounts, que já é ilegível
-- para authenticated/anon.
REVOKE ALL ON FUNCTION public.porter_b32decode(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.porter_totp(text, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.porter_b32decode(text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.porter_totp(text, timestamptz) TO service_role;
