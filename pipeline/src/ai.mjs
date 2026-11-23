import { env, requireEnv } from './env.mjs';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chat({
  system,
  user,
  json = false,
  temperature = 0.3,
  maxTokens = 4096,
  retries = 3,
}) {
  const apiKey = requireEnv('deepseekKey');
  // DeepSeek 要求启用 json_object 时提示词中必须出现 "json" 字样。
  const systemContent = json && !/json/i.test(system) ? `${system}\n\n请严格以 JSON 对象输出。` : system;
  const body = {
    model: env.deepseekModel,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const response = await fetch(`${env.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      return {
        content,
        usage: data.usage ?? null,
        model: data.model ?? env.deepseekModel,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
      };
    }

    if (RETRYABLE.has(response.status)) {
      await sleep(900 * attempt * attempt);
      continue;
    }

    const text = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 400)}`);
  }

  throw new Error(`DeepSeek 请求失败（已重试 ${retries} 次）`);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型未返回 JSON 对象');
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function chatJSON({ system, user, temperature = 0.2, maxTokens = 4096 }) {
  const result = await chat({ system, user, json: true, temperature, maxTokens });
  let parsed;
  try {
    parsed = extractJson(result.content);
  } catch (error) {
    const repair = await chat({
      system: '你是 JSON 修复器。只输出合法 JSON，不要解释。',
      user: `请把下面的内容修复为严格合法的 JSON 对象：\n\n${result.content.slice(0, 6000)}`,
      json: true,
      temperature: 0,
      maxTokens,
    });
    try {
      parsed = extractJson(repair.content);
    } catch {
      throw new Error(
        `模型未返回可解析的 JSON（finish=${result.finishReason}，长度=${result.content.length}）：${result.content.slice(0, 200)}`,
      );
    }
  }
  return { data: parsed, usage: result.usage, model: result.model };
}

export function countWords(markdown) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`\-[\]()]/g, ' ')
    .trim();
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + latin;
}
