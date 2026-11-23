import { GoogleGenAI, ThinkingLevel } from '@google/genai';

export type SupportedLanguage = 'en' | 'hi';
export type ReplyMode = 'fast' | 'deep';

export interface IncomingMessage {
  role: string;
  content: string;
}

interface NormalizedContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 500, code = 'GEMINI_ERROR') {
    super(message);
    this.name = 'GeminiServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

export function getActiveModel(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_GEMINI_MODEL;
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new GeminiServiceError(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.',
      503,
      'MISSING_API_KEY'
    );
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildSystemInstruction(language: SupportedLanguage): string {
  const languageRule =
    language === 'hi'
      ? 'Respond primarily in natural, clear, modern Hindi (Devanagari script), unless the user explicitly requests English or code comments in English. Keep technical terms accurate.'
      : 'Respond primarily in clear, well-structured English, unless the user writes in Hindi or asks for a Hindi response.';

  return [
    'You are JABRA AI, an intelligent, accurate, and thoughtful bilingual assistant.',
    'Founder & Creator Profile: Your founder and creator is Aditya Nishad (आदित्य निषाद), who lives at Chandwak Ghat (चंदवक घाट) and studies in Class 9 (कक्षा 9).',
    'Whenever anyone asks (in English, Hindi, or Hinglish) who your founder or creator is, who built or made you ("who is founder", "who made you", "kisne banaya", "आपका निर्माता कौन है"), where Aditya Nishad lives ("kaha rahte hai"), or what class he studies in ("kitne class me padte hai"), answer clearly and accurately using these details: Founder Aditya Nishad (आदित्य निषाद), from Chandwak Ghat (चंदवक घाट), currently studying in Class 9 (कक्षा 9).',
    languageRule,
    'Use clean Markdown formatting (headings, concise bullet lists, and fenced code blocks with language tags) when helpful.',
    'Be direct, honest about uncertainty, and never fabricate facts or citations.',
  ].join(' ');
}

export function normalizeLanguage(lang: unknown): SupportedLanguage {
  return lang === 'hi' ? 'hi' : 'en';
}

export function normalizeReplyMode(mode: unknown): ReplyMode {
  return mode === 'deep' ? 'deep' : 'fast';
}

export function normalizeMessages(messages: unknown): NormalizedContent[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GeminiServiceError(
      'Request must include a non-empty messages array.',
      400,
      'INVALID_PAYLOAD'
    );
  }

  const recent = messages.slice(-40);
  const contents: NormalizedContent[] = [];

  for (const item of recent) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Partial<IncomingMessage>;
    if (typeof msg.content !== 'string') continue;

    const text = msg.content.trim();
    if (!text) continue;

    if (text.length > 16000) {
      throw new GeminiServiceError(
        'A single message cannot exceed 16,000 characters.',
        400,
        'MESSAGE_TOO_LONG'
      );
    }

    const role: 'user' | 'model' =
      msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';

    const previous = contents[contents.length - 1];
    if (previous && previous.role === role) {
      previous.parts[0].text += `\n\n${text}`;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }

  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    throw new GeminiServiceError(
      'The last message in the conversation must be from the user.',
      400,
      'INVALID_CONVERSATION'
    );
  }

  return contents;
}

export function mapUpstreamError(err: unknown): GeminiServiceError {
  if (err instanceof GeminiServiceError) {
    return err;
  }

  const rawMessage = err instanceof Error ? err.message : String(err);
  const lower = rawMessage.toLowerCase();

  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return new GeminiServiceError(
      'Rate limit or quota reached on the Gemini API. Please wait a moment and try again, or verify your API key quota in Settings > Secrets.',
      429,
      'RESOURCE_EXHAUSTED'
    );
  }

  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('api key not valid')
  ) {
    return new GeminiServiceError(
      'Gemini API authentication failed. Please check your GEMINI_API_KEY in Settings > Secrets.',
      403,
      'API_KEY_INVALID'
    );
  }

  if (lower.includes('404') || lower.includes('not_found')) {
    return new GeminiServiceError(
      'The configured Gemini model was not found or is unsupported.',
      404,
      'MODEL_NOT_FOUND'
    );
  }

  return new GeminiServiceError(
    rawMessage || 'Unable to reach Gemini right now. Please try again.',
    502,
    'UPSTREAM_ERROR'
  );
}

export async function streamGeminiResponse({
  messages,
  language,
  replyMode = 'fast',
  onChunk,
  signal,
}: {
  messages: unknown;
  language: SupportedLanguage;
  replyMode?: ReplyMode;
  onChunk: (chunkText: string) => void;
  signal?: AbortSignal;
}): Promise<{ model: string; fullText: string }> {
  const ai = getClient();
  const model = getActiveModel();
  const contents = normalizeMessages(messages);
  const thinkingLevel = replyMode === 'deep' ? ThinkingLevel.HIGH : ThinkingLevel.LOW;

  const responseStream = await ai.models.generateContentStream({
    model,
    contents,
    config: {
      systemInstruction: buildSystemInstruction(language),
      thinkingConfig: { thinkingLevel },
    },
  });

  let fullText = '';
  for await (const chunk of responseStream) {
    if (signal?.aborted) break;
    const text = chunk?.text;
    if (text) {
      fullText += text;
      onChunk(text);
    }
  }

  if (!fullText && !signal?.aborted) {
    throw new GeminiServiceError(
      'Gemini returned an empty response. Please try rephrasing your prompt.',
      502,
      'EMPTY_RESPONSE'
    );
  }

  return { model, fullText };
}
