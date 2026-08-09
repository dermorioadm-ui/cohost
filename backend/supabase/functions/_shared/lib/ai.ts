import Anthropic from "npm:@anthropic-ai/sdk@^0.72.0";
import { env, optional, required } from "./env.ts";
import { errors } from "./http.ts";

/**
 * Camada de IA da assistente do hóspede.
 *
 * Dois provedores, escolhidos por AI_PROVIDER no .env:
 *   - "anthropic" (padrão)  -> SDK oficial da Anthropic, modelo claude-opus-5
 *   - "google"              -> Gemini via REST
 *
 * Ambos expõem a mesma interface e devolvem um stream de texto, para o chat
 * aparecer palavra por palavra em vez de esperar a resposta inteira.
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  history: ChatTurn[];
  message: string;
  maxTokens?: number;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  /** Emite pedaços de texto conforme o modelo gera. */
  stream(req: ChatRequest): AsyncGenerator<string, void, unknown>;
}

// ---------------------------------------------------------------------------
// Anthropic — claude-opus-5
// ---------------------------------------------------------------------------

const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";

class AnthropicProvider implements ChatProvider {
  readonly name = "anthropic";
  readonly model: string;
  #client: Anthropic;

  constructor() {
    this.#client = new Anthropic({ apiKey: required("ANTHROPIC_API_KEY") });
    this.model = optional("AI_MODEL") || ANTHROPIC_DEFAULT_MODEL;
  }

  async *stream(req: ChatRequest): AsyncGenerator<string, void, unknown> {
    const messages = [
      ...req.history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: req.message },
    ];

    // `fallbacks: "default"` faz a Anthropic reexecutar a requisição em outro
    // modelo caso os classificadores de segurança recusem — em vez de devolver
    // a recusa para o hóspede. Custa nada quando não acontece.
    const stream = this.#client.beta.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? env.aiMaxTokens(),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // O prompt do imóvel é estável entre mensagens e entre hóspedes:
      // cacheado, as respostas seguintes ficam bem mais baratas.
      system: [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ],
      // Resposta de FAQ de hóspede: prioriza latência. O modelo continua com
      // raciocínio adaptativo (padrão no opus-5), só que raso.
      output_config: { effort: "low" },
      messages,
    });

    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }

      const final = await stream.finalMessage();

      if (final.stop_reason === "refusal") {
        // Toda a cadeia (modelo + fallback) recusou. Raro num assistente de
        // hospedagem, mas o hóspede não pode ficar sem resposta.
        yield "\n\nNão consigo responder isso por aqui. " +
          "Vou pedir para o responsável pelo imóvel falar com você.";
      }

      if (final.stop_reason === "max_tokens") {
        yield "…";
      }
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        throw errors.rateLimited("Muitas mensagens agora. Tente de novo em instantes.");
      }
      if (e instanceof Anthropic.AuthenticationError) {
        console.error("ANTHROPIC_API_KEY inválida ou ausente");
        throw errors.upstream("Assistente indisponível no momento.");
      }
      if (e instanceof Anthropic.APIError) {
        console.error(`Anthropic API error ${e.status}: ${e.message}`);
        throw errors.upstream("Assistente indisponível no momento.");
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Google Gemini (REST) — alternativa
// ---------------------------------------------------------------------------

const GOOGLE_DEFAULT_MODEL = "gemini-2.5-flash";

class GoogleProvider implements ChatProvider {
  readonly name = "google";
  readonly model: string;
  #apiKey: string;

  constructor() {
    this.#apiKey = required("GOOGLE_AI_API_KEY");
    this.model = optional("AI_MODEL") || GOOGLE_DEFAULT_MODEL;
  }

  async *stream(req: ChatRequest): AsyncGenerator<string, void, unknown> {
    const contents = [
      ...req.history.map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: [{ text: t.content }],
      })),
      { role: "user", parts: [{ text: req.message }] },
    ];

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}` +
      `:streamGenerateContent?alt=sse&key=${this.#apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents,
        generationConfig: { maxOutputTokens: req.maxTokens ?? env.aiMaxTokens() },
      }),
    });

    if (!res.ok || !res.body) {
      if (res.status === 429) throw errors.rateLimited();
      console.error(`Gemini error ${res.status}: ${await res.text()}`);
      throw errors.upstream("Assistente indisponível no momento.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (typeof text === "string" && text !== "") yield text;
        } catch {
          // Fragmento incompleto — o próximo chunk completa.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------

export function chatProvider(): ChatProvider {
  const provider = env.aiProvider().toLowerCase();
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "google":
      return new GoogleProvider();
    default:
      throw new Error(
        `AI_PROVIDER inválido: "${provider}". Use "anthropic" ou "google".`,
      );
  }
}

/** Converte o gerador de texto em SSE para o navegador consumir. */
export function toSSE(gen: AsyncGenerator<string, void, unknown>): {
  stream: ReadableStream<Uint8Array>;
  collected: Promise<string>;
} {
  const encoder = new TextEncoder();
  let resolveCollected: (v: string) => void;
  let rejectCollected: (e: unknown) => void;
  const collected = new Promise<string>((res, rej) => {
    resolveCollected = res;
    rejectCollected = rej;
  });

  let full = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of gen) {
          full += chunk;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        resolveCollected(full);
      } catch (e) {
        console.error("Erro no stream da IA:", e);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: "Falha ao gerar resposta." })}\n\n`,
          ),
        );
        // Resolve com o parcial: o que já foi enviado ao hóspede precisa
        // ser gravado no histórico, senão a conversa fica inconsistente.
        resolveCollected(full);
      } finally {
        controller.close();
      }
    },
  });

  return { stream, collected };
}
