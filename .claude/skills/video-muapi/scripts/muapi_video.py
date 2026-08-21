#!/usr/bin/env python3
"""
Cliente de linha de comando para geração de vídeo na MuAPI.

Portado do cliente do Open Generative AI (github.com/Anil-matcha/Open-Generative-AI,
packages/studio/src/muapi.js). Só usa a biblioteca padrão do Python 3.

Padrão da API: POST /api/v1/<endpoint> devolve request_id ->
GET /api/v1/predictions/<request_id>/result até status completed/succeeded/success.
Autenticação sempre pelo header x-api-key (nunca Authorization: Bearer).

Uso rápido:
    python3 muapi_video.py models --kind t2v --search kling
    python3 muapi_video.py show seedance-2.5-image-to-video
    python3 muapi_video.py gen --model seedance-2.5-text-to-video \
        --prompt "..." --ar 9:16 --duration 8 --out saida.mp4
"""

import argparse
import json
import mimetypes
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE_URL = os.environ.get("MUAPI_BASE_URL", "https://api.muapi.ai").rstrip("/")
CATALOG_PATH = pathlib.Path(__file__).resolve().parent.parent / "references" / "catalogo.json"
JOBS_PATH = pathlib.Path(os.environ.get("MUAPI_JOBS_FILE", pathlib.Path.home() / ".muapi" / "jobs.jsonl"))

KINDS = ("t2v", "i2v", "v2v", "lipsync", "audio")
LIST_FIELDS = {"images_list", "videos_list", "audios_list", "reference_images",
               "reference_videos", "reference_audios", "image_urls", "video_files", "audio_files"}


# ---------------------------------------------------------------- infra

def die(msg, code=1):
    print(f"erro: {msg}", file=sys.stderr)
    sys.exit(code)


def api_key():
    for var in ("MUAPI_KEY", "MUAPI_API_KEY", "MUAPI_TOKEN"):
        key = os.environ.get(var)
        if key:
            return key.strip()
    for path in (pathlib.Path.home() / ".muapi_key", pathlib.Path.home() / ".config" / "muapi" / "key"):
        if path.is_file():
            key = path.read_text(encoding="utf-8").strip()
            if key:
                return key
    die("chave da MuAPI não encontrada. Defina MUAPI_KEY ou grave a chave em ~/.muapi_key "
        "(pegue em https://muapi.ai).")


def load_catalog():
    if not CATALOG_PATH.is_file():
        die(f"catálogo não encontrado em {CATALOG_PATH}")
    with CATALOG_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def find_model(model_id, catalog=None):
    """Devolve (kind, model) ou (None, None)."""
    catalog = catalog or load_catalog()
    for kind in KINDS:
        for model in catalog.get(kind, []):
            if model["id"] == model_id or model.get("endpoint") == model_id:
                return kind, model
    return None, None


def http_json(method, path, payload=None, key=None, timeout=120):
    url = f"{BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", key or api_key())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        return exc.code, {"_error": detail}
    except urllib.error.URLError as exc:
        die(f"falha de rede em {url}: {exc.reason}")


# ---------------------------------------------------------------- upload

def upload_file(path, key):
    """POST multipart em /api/v1/upload_file. Devolve a URL pública do arquivo."""
    path = pathlib.Path(path).expanduser()
    if not path.is_file():
        die(f"arquivo não encontrado: {path}")
    boundary = f"----muapi{uuid.uuid4().hex}"
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    head = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n").encode("utf-8")
    body = head + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(f"{BASE_URL}/api/v1/upload_file", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("x-api-key", key)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        die(f"upload falhou ({exc.code}): {exc.read().decode('utf-8', 'replace')[:300]}")
    except urllib.error.URLError as exc:
        die(f"upload falhou (rede): {exc.reason}")
    url = data.get("url") or data.get("file_url") or (data.get("data") or {}).get("url")
    if not url:
        die(f"upload não devolveu URL: {json.dumps(data)[:300]}")
    return url


def ensure_url(value, key):
    """Caminho local vira URL (upload); URL http(s) passa direto."""
    if value.startswith("http://") or value.startswith("https://") or value.startswith("data:"):
        return value
    if not key:
        die(f"{value} é arquivo local e precisa de upload — tire o --dry-run ou passe uma URL")
    return upload_file(value, key)


# ---------------------------------------------------------------- submit + poll

def record_job(request_id, endpoint, payload):
    try:
        JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with JOBS_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"request_id": request_id, "endpoint": endpoint,
                                 "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                 "payload": payload}, ensure_ascii=False) + "\n")
    except OSError:
        pass  # registro é conveniência, nunca motivo para abortar


def submit(endpoint, payload, key):
    status, data = http_json("POST", f"/api/v1/{endpoint}", payload, key)
    if status >= 400:
        die(f"POST /api/v1/{endpoint} devolveu {status}: {data.get('_error', '')}")
    request_id = data.get("request_id") or data.get("id")
    if request_id:
        record_job(request_id, endpoint, payload)
    return request_id, data


def poll(request_id, key, timeout=1800, interval=5, quiet=False):
    """Espera o resultado. Erro 5xx no polling é transitório: continua tentando."""
    deadline = time.time() + timeout
    attempt = 0
    while time.time() < deadline:
        time.sleep(interval)
        attempt += 1
        status, data = http_json("GET", f"/api/v1/predictions/{request_id}/result", None, key)
        if status >= 500:
            continue
        if status >= 400:
            die(f"polling falhou ({status}): {data.get('_error', '')}")
        state = str(data.get("status", "")).lower()
        if state in ("completed", "succeeded", "success"):
            return data
        if state in ("failed", "error"):
            die(f"geração falhou: {data.get('error') or json.dumps(data)[:300]}")
        if not quiet:
            print(f"[{attempt}] status={state or 'pendente'} ({int(time.time() - deadline + timeout)}s)",
                  file=sys.stderr)
    die(f"timeout depois de {timeout}s. O job continua rodando — retome com: "
        f"muapi_video.py poll {request_id}")


def outputs_of(result):
    out = result.get("outputs") or result.get("url") or (result.get("output") or {}).get("url")
    if out is None:
        return []
    return out if isinstance(out, list) else [out]


def download(url, dest):
    dest = pathlib.Path(dest).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=900) as resp, dest.open("wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    return dest


# ---------------------------------------------------------------- payload

def coerce(raw):
    low = raw.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "none"):
        return None
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    if raw[:1] in "[{":
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    return raw


def check_enum(model, field, value, force):
    spec = (model.get("inputs") or {}).get(field) or {}
    if "enum" in spec and value not in spec["enum"] and str(value) not in [str(v) for v in spec["enum"]]:
        msg = (f"{model['id']}: {field}={value!r} não é aceito. "
               f"Valores válidos: {', '.join(str(v) for v in spec['enum'])}")
        die(msg) if not force else print(f"aviso: {msg}", file=sys.stderr)
    if "min" in spec and isinstance(value, (int, float)):
        if not (spec["min"] <= value <= spec.get("max", value)):
            msg = f"{model['id']}: {field}={value} fora da faixa {spec['min']}-{spec.get('max')}"
            die(msg) if not force else print(f"aviso: {msg}", file=sys.stderr)


def is_list_field(model, field):
    spec = (model.get("inputs") or {}).get(field) or {}
    return spec.get("type") == "array" or field in LIST_FIELDS


def _pick_field(inputs, candidates, fallback):
    """Primeiro campo do modelo que existe entre os candidatos."""
    for field in candidates:
        if field in inputs:
            return field
    return fallback


def build_payload(model, kind, args, key):
    inputs = model.get("inputs") or {}
    payload = {}

    if args.prompt:
        payload["prompt"] = args.prompt
    elif kind == "lipsync" and model.get("hasPrompt"):
        payload["prompt"] = ""

    if args.request_id:            # modelos de extensão continuam um job anterior
        payload["request_id"] = args.request_id

    # imagens (start frame, referências, retrato do lipsync)
    if args.image:
        urls = [ensure_url(v, key) for v in args.image]
        field = model.get("imageField") or ("image_url" if kind != "lipsync" else "image_url")
        if is_list_field(model, field):
            payload[field] = urls
        else:
            payload[field] = urls[0]
            if len(urls) > 1:
                print(f"aviso: {model['id']} aceita uma imagem só em '{field}'; "
                      f"as outras {len(urls) - 1} foram ignoradas", file=sys.stderr)

    # último frame (first-last-frame / transição)
    if args.last_image:
        url = ensure_url(args.last_image, key)
        field = model.get("lastImageField") or ("last_image" if "last_image" in inputs else None)
        if field == "images_list" or (field is None and is_list_field(model, model.get("imageField", ""))):
            payload.setdefault(model.get("imageField", "images_list"), []).append(url)
        elif field:
            payload[field] = url
        else:
            die(f"{model['id']} não aceita último frame (sem lastImageField no catálogo)")

    # vídeo de entrada (v2v, lipsync de vídeo, omni-reference, extends por URL)
    if args.video:
        urls = [ensure_url(v, key) for v in args.video]
        field = _pick_field(inputs, ("videos_list", "reference_videos", "video_files", "video_url"),
                            model.get("videoField") or "video_url")
        payload[field] = urls if is_list_field(model, field) else urls[0]

    # áudio (lipsync, omni-reference, wan2.7)
    if args.audio:
        urls = [ensure_url(v, key) for v in args.audio]
        field = _pick_field(inputs, ("audios_list", "reference_audios", "audio_files", "audio_url"),
                            "audio_url")
        payload[field] = urls if is_list_field(model, field) else urls[0]

    scalars = {
        "aspect_ratio": args.aspect_ratio,
        "duration": args.duration,
        "resolution": args.resolution,
        "quality": args.quality,
        "mode": args.mode,
        "negative_prompt": args.negative_prompt,
        "seed": args.seed,
    }
    for field, value in scalars.items():
        if value is None:
            continue
        check_enum(model, field, value, args.force)
        payload[field] = value

    for item in args.param or []:
        if "=" not in item:
            die(f"--param espera chave=valor, recebi {item!r}")
        field, raw = item.split("=", 1)
        value = coerce(raw)
        check_enum(model, field, value, args.force)
        payload[field] = value

    if kind in ("t2v",) and not payload.get("prompt") and not args.request_id:
        die(f"{model['id']} é text-to-video: --prompt é obrigatório")
    return payload


# ---------------------------------------------------------------- comandos

def cmd_models(args):
    catalog = load_catalog()
    kinds = [args.kind] if args.kind else list(KINDS)
    needle = (args.search or "").lower()
    rows = []
    for kind in kinds:
        for model in catalog.get(kind, []):
            hay = f"{model['id']} {model['name']} {model.get('provider', '')}".lower()
            if needle and needle not in hay:
                continue
            rows.append((kind, model))
    if args.json:
        print(json.dumps([{**m, "kind": k} for k, m in rows], ensure_ascii=False, indent=1))
        return
    for kind, model in rows:
        bits = []
        for field, spec in (model.get("inputs") or {}).items():
            if field == "prompt":
                continue
            if "enum" in spec:
                bits.append(f"{field}={'/'.join(str(v) for v in spec['enum'])}")
            elif "min" in spec:
                bits.append(f"{field}={spec['min']}-{spec.get('max')}")
        print(f"[{kind}] {model['id']:<45} {model['name']} · {model.get('provider', '?')}"
              + (f"\n{'':>7}{' · '.join(bits)}" if bits else ""))
    print(f"\n{len(rows)} modelo(s).", file=sys.stderr)


def cmd_show(args):
    kind, model = find_model(args.model)
    if not model:
        die(f"modelo {args.model!r} não está no catálogo. "
            f"Use `models --search` ou passe --endpoint no gen.")
    print(json.dumps({"kind": kind, **model}, ensure_ascii=False, indent=1))


def cmd_gen(args):
    key = None if args.dry_run else api_key()
    kind, model = find_model(args.model)
    if not model:
        if not args.endpoint:
            die(f"modelo {args.model!r} não está no catálogo. Passe --endpoint <caminho-da-api> "
                f"para usar mesmo assim, ou procure com `models --search`.")
        kind, model = "t2v", {"id": args.model, "name": args.model, "endpoint": args.endpoint, "inputs": {}}
    endpoint = args.endpoint or model.get("endpoint") or model["id"]
    payload = build_payload(model, kind, args, key)

    if args.dry_run:
        print(json.dumps({"endpoint": endpoint, "payload": payload}, ensure_ascii=False, indent=1))
        return

    print(f"-> POST /api/v1/{endpoint}", file=sys.stderr)
    request_id, data = submit(endpoint, payload, key)
    if not request_id:                      # alguns endpoints devolvem o resultado direto
        result = data
    else:
        print(f"request_id={request_id}", file=sys.stderr)
        if args.no_wait:
            print(json.dumps({"request_id": request_id, "status": "submitted"}, ensure_ascii=False))
            return
        result = poll(request_id, key, args.timeout, args.interval, args.quiet)

    urls = outputs_of(result)
    files = []
    if args.out and urls:
        for idx, url in enumerate(urls):
            dest = args.out if len(urls) == 1 else _indexed(args.out, idx)
            files.append(str(download(url, dest)))
    print(json.dumps({"request_id": request_id, "status": result.get("status"),
                      "outputs": urls, "files": files}, ensure_ascii=False, indent=1))


def _indexed(path, idx):
    p = pathlib.Path(path)
    return str(p.with_name(f"{p.stem}_{idx + 1}{p.suffix}"))


def cmd_poll(args):
    key = api_key()
    result = poll(args.request_id, key, args.timeout, args.interval, args.quiet)
    urls = outputs_of(result)
    files = []
    if args.out and urls:
        for idx, url in enumerate(urls):
            dest = args.out if len(urls) == 1 else _indexed(args.out, idx)
            files.append(str(download(url, dest)))
    print(json.dumps({"request_id": args.request_id, "status": result.get("status"),
                      "outputs": urls, "files": files}, ensure_ascii=False, indent=1))


def cmd_upload(args):
    key = api_key()
    for path in args.files:
        print(upload_file(path, key))


def cmd_balance(args):
    status, data = http_json("GET", "/api/v1/account/balance", None, api_key())
    if status >= 400:
        die(f"saldo indisponível ({status}): {data.get('_error', '')}")
    print(json.dumps(data, ensure_ascii=False, indent=1))


def cmd_cost(args):
    key = api_key()
    kind, model = find_model(args.model)
    endpoint = (model or {}).get("endpoint") or args.model
    payload = {}
    for item in args.param or []:
        field, raw = item.split("=", 1)
        payload[field] = coerce(raw)
    status, data = http_json("POST", "/api/v1/app/calculate_dynamic_cost",
                             {"task_name": endpoint, "payload": payload}, key)
    if status >= 400:
        die(f"cálculo de custo falhou ({status}): {data.get('_error', '')}")
    print(json.dumps(data, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- cli

def main():
    parser = argparse.ArgumentParser(
        prog="muapi_video.py", description="Geração de vídeo na MuAPI (Open Generative AI)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("models", help="lista modelos do catálogo")
    p.add_argument("--kind", choices=KINDS, help="t2v, i2v, v2v, lipsync ou audio")
    p.add_argument("--search", help="filtro por id, nome ou provedor")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_models)

    p = sub.add_parser("show", help="schema completo de um modelo")
    p.add_argument("model")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("gen", help="gera vídeo (t2v, i2v, v2v ou lipsync)")
    p.add_argument("--model", required=True)
    p.add_argument("--endpoint", help="força o caminho da API (modelo fora do catálogo)")
    p.add_argument("--prompt")
    p.add_argument("--negative-prompt")
    p.add_argument("--image", action="append", help="arquivo local ou URL; repita para múltiplas referências")
    p.add_argument("--last-image", help="último frame (first-last-frame / transição)")
    p.add_argument("--video", action="append", help="vídeo de entrada (v2v, lipsync de vídeo)")
    p.add_argument("--audio", action="append", help="áudio de entrada (lipsync, omni-reference)")
    p.add_argument("--ar", "--aspect-ratio", dest="aspect_ratio")
    p.add_argument("--duration", type=int)
    p.add_argument("--resolution")
    p.add_argument("--quality")
    p.add_argument("--mode")
    p.add_argument("--seed", type=int)
    p.add_argument("--request-id", help="job anterior a estender (modelos *-extend)")
    p.add_argument("-p", "--param", action="append", help="campo extra: chave=valor")
    p.add_argument("--out", help="salva o resultado neste arquivo")
    p.add_argument("--no-wait", action="store_true", help="só envia e devolve o request_id")
    p.add_argument("--timeout", type=int, default=1800)
    p.add_argument("--interval", type=int, default=5)
    p.add_argument("--force", action="store_true", help="ignora validação de enum/faixa")
    p.add_argument("--dry-run", action="store_true", help="mostra o payload sem enviar")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=cmd_gen)

    p = sub.add_parser("poll", help="retoma um job pelo request_id")
    p.add_argument("request_id")
    p.add_argument("--out")
    p.add_argument("--timeout", type=int, default=1800)
    p.add_argument("--interval", type=int, default=5)
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=cmd_poll)

    p = sub.add_parser("upload", help="sobe arquivos e devolve as URLs")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_upload)

    p = sub.add_parser("balance", help="saldo da conta")
    p.set_defaults(func=cmd_balance)

    p = sub.add_parser("cost", help="custo estimado de uma chamada")
    p.add_argument("--model", required=True)
    p.add_argument("-p", "--param", action="append")
    p.set_defaults(func=cmd_cost)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
