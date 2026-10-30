# ds2api

[![npm](https://img.shields.io/npm/v/ds2api)](https://www.npmjs.com/package/ds2api)
[![CI](https://github.com/nctuanit/ds2api/actions/workflows/ci.yml/badge.svg)](https://github.com/nctuanit/ds2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.md) | **Tiếng Việt**

SDK TypeScript tương thích OpenAI cho DeepSeek Web API (`chat.deepseek.com`). Chạy trên **Node.js 18+, Bun, Deno và Cloudflare Workers** — thuần TS, không WASM, không phụ thuộc API riêng của Node.

Port từ [`CJackHwang/ds2api`](https://github.com/CJackHwang/ds2api) (Go), giữ nguyên giao diện của [`openai-node`](https://github.com/openai/openai-node).

## Tính năng

- Thay thế trực tiếp package `openai`: `chat.completions`, `responses`, `completions`, `models`, `files`, streaming, tool calling, structured output
- Tích hợp sẵn bộ giải Proof-of-Work `DeepSeekHashV1` (dùng riêng qua `ds2api/pow`)
- Đăng nhập bằng email / số điện thoại / token, xoay vòng nhiều tài khoản, tự refresh và cache token
- Dựng HTTP gateway tương thích OpenAI chỉ với 1 dòng: `client.fetch(request)`

## Cài đặt

```bash
npm i ds2api
```

## Bắt đầu nhanh

```ts
import OpenAI from 'ds2api';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_TOKEN, // hoặc 'email:password' / 'mobile:password'
});

const res = await client.chat.completions.create({
  model: 'deepseek-reasoner',
  messages: [{ role: 'user', content: 'Xin chào!' }],
});

console.log(res.choices[0].message.reasoning_content); // phần suy luận
console.log(res.choices[0].message.content); // câu trả lời
```

### Streaming

```ts
const stream = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Viết một bài thơ haiku.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Nhiều tài khoản

```ts
const client = new OpenAI({
  accounts: [{ token: process.env.DS_TOKEN_1 }, { email: 'a@example.com', password: '...' }],
  tokenCacheFile: '.deepseek-tokens.json', // hoặc false để tắt cache
  autoDeleteSession: 'single', // 'none' | 'single' | 'all'
});
```

### Proxy trên Cloudflare Worker / Bun

```ts
export default {
  fetch: (req: Request, env: { DEEPSEEK_TOKEN: string }) =>
    new OpenAI({ apiKey: env.DEEPSEEK_TOKEN }).fetch(req),
};
// Cung cấp /v1/models, /v1/chat/completions, /v1/completions, /v1/responses, /v1/files
```

Dùng chung với package `openai` chính thức (hoặc Vercel AI SDK, LangChain):

```ts
import OfficialOpenAI from 'openai';
import { DS2OpenAI } from 'ds2api';

const openai = new OfficialOpenAI({
  apiKey: 'ds2api',
  fetch: new DS2OpenAI({ apiKey: process.env.DEEPSEEK_TOKEN }).asFetch(),
});
```

## Model

| Model                                          | Suy luận | Tìm kiếm |
| :--------------------------------------------- | :------: | :------: |
| `deepseek-chat` / `deepseek-v4-flash`          |    –     |    –     |
| `deepseek-reasoner` / `deepseek-v4-thinking`   |    ✅    |    –     |
| `deepseek-chat-search`                         |    –     |    ✅    |
| `deepseek-reasoner-search`                     |    ✅    |    ✅    |
| `deepseek-expert` / `deepseek-expert-reasoner` |  – / ✅  |    –     |
| `deepseek-vision`                              |    –     |    –     |

Alias: `gpt-4o`, `gpt-4.1`, `gpt-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` → `deepseek-v4-flash`; `o1`, `o3`, `o4-mini`, `gpt-5-codex` → `deepseek-v4-thinking`.

## Phát triển

```bash
npm run build      # ESM + CJS + .d.ts
npm test           # test trên Node (bun test cho Bun)
npm run typecheck
npm run format
```

## Giấy phép

[MIT](./LICENSE)
