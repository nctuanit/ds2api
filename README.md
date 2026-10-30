# ds2api

[![npm](https://img.shields.io/npm/v/ds2api)](https://www.npmjs.com/package/ds2api)
[![CI](https://github.com/nctuanit/ds2api/actions/workflows/ci.yml/badge.svg)](https://github.com/nctuanit/ds2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**English** | [Tiếng Việt](https://github.com/nctuanit/ds2api/blob/main/README.vi.md)

OpenAI-compatible TypeScript SDK for the DeepSeek Web API (`chat.deepseek.com`). Runs on **Node.js 18+, Bun, Deno and Cloudflare Workers** — pure TS, no WASM, no Node-only deps.

Ported from [`CJackHwang/ds2api`](https://github.com/CJackHwang/ds2api) (Go) with the API surface of [`openai-node`](https://github.com/openai/openai-node).

## Features

- Drop-in replacement for the `openai` package: `chat.completions`, `responses`, `completions`, `models`, `files`, streaming, tool calling, structured output
- Built-in `DeepSeekHashV1` Proof-of-Work solver (also available as `ds2api/pow`)
- Email / mobile / token login, multi-account round-robin, auto token refresh & caching
- One-line OpenAI-compatible HTTP gateway: `client.fetch(request)`

## Install

```bash
npm i ds2api
```

## Quick start

```ts
import OpenAI from 'ds2api';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_TOKEN, // or 'email:password' / 'mobile:password'
});

const res = await client.chat.completions.create({
  model: 'deepseek-reasoner',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(res.choices[0].message.reasoning_content);
console.log(res.choices[0].message.content);
```

### Streaming

```ts
const stream = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Write a haiku.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Multiple accounts

```ts
const client = new OpenAI({
  accounts: [{ token: process.env.DS_TOKEN_1 }, { email: 'a@example.com', password: '...' }],
  tokenCacheFile: '.deepseek-tokens.json', // or false
  autoDeleteSession: 'single', // 'none' | 'single' | 'all'
});
```

### Cloudflare Worker / Bun proxy

```ts
export default {
  fetch: (req: Request, env: { DEEPSEEK_TOKEN: string }) =>
    new OpenAI({ apiKey: env.DEEPSEEK_TOKEN }).fetch(req),
};
// Exposes /v1/models, /v1/chat/completions, /v1/completions, /v1/responses, /v1/files
```

Use with the official `openai` package (or Vercel AI SDK, LangChain):

```ts
import OfficialOpenAI from 'openai';
import { DS2OpenAI } from 'ds2api';

const openai = new OfficialOpenAI({
  apiKey: 'ds2api',
  fetch: new DS2OpenAI({ apiKey: process.env.DEEPSEEK_TOKEN }).asFetch(),
});
```

## Models

| Model                                          | Thinking | Search |
| :--------------------------------------------- | :------: | :----: |
| `deepseek-chat` / `deepseek-v4-flash`          |    –     |   –    |
| `deepseek-reasoner` / `deepseek-v4-thinking`   |    ✅    |   –    |
| `deepseek-chat-search`                         |    –     |   ✅   |
| `deepseek-reasoner-search`                     |    ✅    |   ✅   |
| `deepseek-expert` / `deepseek-expert-reasoner` |  – / ✅  |   –    |
| `deepseek-vision`                              |    –     |   –    |

Aliases: `gpt-4o`, `gpt-4.1`, `gpt-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` → `deepseek-v4-flash`; `o1`, `o3`, `o4-mini`, `gpt-5-codex` → `deepseek-v4-thinking`.

## Development

```bash
npm run build      # ESM + CJS + .d.ts
npm test           # Node tests (bun test for Bun)
npm run typecheck
npm run format
```

## License

[MIT](./LICENSE)
