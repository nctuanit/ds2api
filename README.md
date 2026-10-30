# ds2api

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B%20Strict-3178C6?logo=typescript&logoColor=white)](#)
[![Zero any/unknown](https://img.shields.io/badge/Types-Zero%20any%20%2F%20unknown-success)](#architecture--design-patterns)
[![Runtimes](https://img.shields.io/badge/Runtimes-Node.js%20%7C%20Bun%20%7C%20Cloudflare%20Workers-F38020)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**`ds2api`** is a universal, strictly-typed **OpenAI-compatible TypeScript/JavaScript SDK** for DeepSeek's Web API (`chat.deepseek.com`), ported and re-architected in pure TypeScript from [**`CJackHwang/ds2api`**](https://github.com/CJackHwang/ds2api) (Go) combined with the full SDK interface of [**`openai/openai-node`**](https://github.com/openai/openai-node).

It serves both as a **drop-in replacement for the `openai` npm package** (`new Deepseek(...)` / `new OpenAI(...)`) and as a **1-line WinterCG Edge HTTP Gateway** (`client.fetch(request)`) for Cloudflare Workers, Bun, Deno, and Node.js.

---

## 🏛️ Origin & Attribution (Covered / Ported From)

This package covers and unifies two upstream projects into a single zero-WASM TypeScript library:

1. **[`CJackHwang/ds2api`](https://github.com/CJackHwang/ds2api) (Go — Core DeepSeek Web Protocol & PoW Engine)**
   All internal DeepSeek Web (`chat.deepseek.com`) protocol mechanics are faithfully ported from `CJackHwang/ds2api` into pure TypeScript:

   | Upstream `CJackHwang/ds2api` (Go)    | `ds2api` (TypeScript)       | Covered Functionality                                                                                                                                      |
   | :----------------------------------- | :-------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `internal/pow/` + `sha3_custom_wasm` | `src/pow/keccak.ts`         | Custom 23-round `Keccak-f[1600]` (`DeepSeekHashV1`, skipping round 0) & PoW challenge solver without `.wasm` binaries                                      |
   | `internal/deepseek/`                 | `src/deepseek/client.ts`    | Mobile/Email login (`/api/v0/users/login`), session creation/cleanup, PoW challenge handshake, file uploads, and completion calls                          |
   | `internal/config/` & model settings  | `src/protocol/constants.ts` | Dynamic model sync from `/api/v0/client/settings?did=<deviceId>&scope=model`, `DEFAULT_MODEL_ALIASES`, and Android client headers                          |
   | `internal/sse/`                      | `src/sse/parser.ts`         | DeepSeek JSON-Patch SSE stream parser (`response/fragments`, `thinking_content`, continuation overlap deduper, citation sanitizer, `CONTENT_FILTER` guard) |
   | `internal/toolcall/`                 | `src/toolcall/sieve.ts`     | Streaming `<\|DSML\|tool_calls>` / XML state machine (`ToolSieveStateMachine`), CDATA parser, and JSON Schema type coercion                                |
   | `internal/prompt/`                   | `src/prompt/builder.ts`     | `<\|begin▁of▁sentence\|>` prompt serialization, DSML tool instruction injection, and delimiter sanitization                                                |
   | `internal/auth/`                     | `src/auth/account-pool.ts`  | Multi-account Round-Robin pool, automatic token refresh, and `.deepseek-tokens.json` persistence                                                           |

2. **[`openai/openai-node`](https://github.com/openai/openai-node) (TypeScript — Official OpenAI SDK Surface)**
   Covers the public client ergonomics and DeepSeek-backed resource namespaces of the official `openai` npm package (`src/openai/`):
   - **Resource namespaces**: `chat.completions` (`.create()`, `.stream()`, `.parse()`, `.runTools()`, `.messages`), `responses` (`.create()`, `.stream()`, `.parse()`, `.inputItems`), `completions`, `models` (`.list()`, `.listConfigs()`, `.retrieve()`), `files`, `uploads`, and `beta` (`beta.chat.completions`, `beta.assistants`, `beta.threads`).
   - Core primitives: `APIPromise` (`.withResponse()`, `.asResponse()`), `Stream` (`AsyncIterable`, `.tee()`, `.toReadableStream()`), `Page` auto-pagination, `toFile()`, and typed `APIError` hierarchy.

---

## ✨ Key Features

- **🌐 Universal Web-Standard Runtime (Node.js 18+, Bun, Cloudflare Workers, Deno):**
  Uses only WinterCG web standards (`fetch`, `ReadableStream`, `TextEncoder`, `crypto.subtle`). Zero Node-only dependencies (`fs`/`net`/`http`), and **zero `.wasm` binary files** that break Edge bundlers.
- **⚡ Pure TypeScript `DeepSeekHashV1` PoW Engine:**
  Implements custom 23-round `Keccak-f[1600]` over 32-bit lane pairs (`Uint32Array(50)`) with pre-absorbed `${salt}_${expireAt}_` prefixes and zero heap allocations inside the hot nonce loop (~8–25ms solve time).
- **🧩 DeepSeek-Backed OpenAI SDK Method Surface:**
  Implements the OpenAI SDK resource namespaces genuinely supported by DeepSeek Web (`chat.completions`, `completions`, `responses`, `models`, `files`, `uploads`, `beta`) plus `APIPromise` (`.withResponse()`, `.asResponse()`), `Stream` (`.tee()`, `.toReadableStream()`), and `Page` auto-pagination.
- **🔄 Multi-Account Pool & Auto-Login:**
  Built-in Round-Robin account rotation (`AccountPool`) supporting DeepSeek Bearer tokens, `email:password`, or `mobile:password` with automatic token refresh on expiration.
- **🛡️ Strict Clean Architecture (Zero `any` / Zero `unknown`):**
  Built with GoF Design Patterns (**Strategy, State Machine, Builder, Factory, Adapter, Observer, Router, Facade**) and exhaustive pattern matching via [`ts-pattern`](https://github.com/gvergnaud/ts-pattern).

---

## 📦 Installation

```bash
# npm
npm install ds2api

# bun
bun add ds2api

# pnpm / yarn
pnpm add ds2api
```

---

## 🔑 Authentication, Auto-Token Caching & Multi-Account Pool

`ds2api` exports `Deepseek` (as well as `DeepSeek`, `OpenAI`, `DS2OpenAI` aliases) and accepts several credential formats out of the box:

```ts
import { Deepseek } from 'ds2api';

// Option A: Email/Password or Mobile/Password
// -> Logs in via /api/v0/users/login and automatically caches the acquired token
//    to `.deepseek-tokens.json` (mode 0o600) so subsequent runs skip re-login!
const client = new Deepseek({
  apiKey: 'user@example.com:your_password',
  autoDeleteSession: 'single',
});

// Option B: Direct Bearer Token (or via env DEEPSEEK_TOKEN / DS2API_KEY / OPENAI_API_KEY)
const clientToken = new Deepseek({
  apiKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
});

// Option C: Multi-Account Round-Robin Pool (comma-separated string or structured array)
const clientPool = new Deepseek({
  accounts: [
    { token: process.env.DS_TOKEN_1 },
    { email: 'account2@example.com', password: 'password2' },
    { mobile: '+8613800138000', password: 'password3' },
  ],
  // Custom token cache file path, or `false` to disable disk caching (default: '.deepseek-tokens.json')
  tokenCacheFile: '.deepseek-tokens.json',
  // Session cleanup after each completion: 'none' (default) | 'single' | 'all'
  autoDeleteSession: 'single',
  // Automatically strip web search citation markers like [citation:1] (default: true)
  stripReferenceMarkers: true,
});
```

---

## 🚀 Usage Examples

### 1. Chat Completions & Reasoning (`deepseek-reasoner`)

```ts
import OpenAI from 'ds2api';

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_TOKEN });

const completion = await client.chat.completions.create({
  model: 'deepseek-reasoner', // or 'deepseek-chat', 'gpt-4o', 'claude-sonnet-4-5'
  messages: [
    { role: 'system', content: 'You are a concise systems architect.' },
    { role: 'user', content: 'Explain how Keccak-f[1600] sponge absorbing works.' },
  ],
});

console.log('Thinking:', completion.choices[0].message.reasoning_content);
console.log('Answer:', completion.choices[0].message.content);
console.log('Usage:', completion.usage);
```

Need raw HTTP response headers alongside the parsed data? Use `.withResponse()`:

```ts
const { data, response } = await client.chat.completions
  .create({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Hello!' }],
  })
  .withResponse();
```

---

### 2. Streaming Chat Completions (`AsyncIterable` & `.stream()` Event Bus)

#### Standard `for await...of` Streaming

```ts
const stream = await client.chat.completions.create({
  model: 'deepseek-reasoner',
  messages: [{ role: 'user', content: 'Write a haiku about Edge computing.' }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.reasoning_content) process.stdout.write(delta.reasoning_content);
  if (delta?.content) process.stdout.write(delta.content);
}
```

#### Event-Driven `.stream()` Helper (Observer Pattern)

```ts
const runner = client.chat.completions
  .stream({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'Summarize clean architecture.' }],
  })
  .on('reasoning_content', (delta) => process.stdout.write(`[Think] ${delta}`))
  .on('content', (delta) => process.stdout.write(delta))
  .on('error', (err) => console.error('Stream error:', err));

const finalCompletion = await runner.finalChatCompletion();
```

---

### 3. Function / Tool Calling & Automatic `runTools()` Loop

`ds2api` includes a streaming state machine (`ToolSieveStateMachine`) that intercepts DeepSeek's `<｜DSML｜function_calls>` / XML / JSON tool invocations in real time and converts them into standard OpenAI `tool_calls`.

```ts
const runner = client.chat.completions.runTools({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'What is the stock price of AAPL?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_stock_price',
        description: 'Get the latest stock price for a ticker symbol',
        parameters: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'Ticker symbol, e.g. AAPL, NVDA' },
          },
          required: ['ticker'],
        },
        function: async (args) => {
          return { ticker: args.ticker, price: '185.50 USD', change: '+1.4%' };
        },
      },
    },
  ],
});

const finalResult = await runner.finalChatCompletion();
console.log(finalResult.choices[0].message.content);
```

---

### 4. Structured JSON Outputs (`chat.completions.parse`)

```ts
interface ArchitectureSummary {
  project: string;
  powAlgorithm: string;
  runtimes: string[];
  strictTyped: boolean;
}

const parsed = await client.chat.completions.parse<ArchitectureSummary>({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Describe the ds2api SDK in JSON.' }],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'architecture_summary',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          powAlgorithm: { type: 'string' },
          runtimes: { type: 'array', items: { type: 'string' } },
          strictTyped: { type: 'boolean' },
        },
        required: ['project', 'powAlgorithm', 'runtimes', 'strictTyped'],
      },
    },
  },
});

console.log(parsed.choices[0].message.parsed?.powAlgorithm); // "DeepSeekHashV1"
```

---

### 5. OpenAI Responses API (`client.responses`)

```ts
// Non-streaming
const response = await client.responses.create({
  model: 'deepseek-reasoner',
  instructions: 'Answer in one sentence.',
  input: 'Why is WebAssembly often restricted in Edge Workers?',
});
console.log(response.output_text);

// Streaming Responses API events
const eventStream = await client.responses.create({
  model: 'deepseek-chat',
  input: 'Explain Round-Robin load balancing.',
  stream: true,
});

for await (const event of eventStream) {
  if (event.type === 'response.output_text.delta' && event.delta) {
    process.stdout.write(event.delta);
  }
}
```

---

### 6. File Uploads (`client.files`)

Uploading a file automatically acquires a PoW challenge for `/api/v0/file/upload_file`, solves it, and attaches the file ID ready for `ref_file_ids`:

```ts
import OpenAI, { toFile } from 'ds2api';

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_TOKEN });

// 1. Upload file to DeepSeek
const fileBlob = await toFile('# Project Spec\nStrict TypeScript SDK', 'spec.md', {
  type: 'text/markdown',
});
const uploaded = await client.files.create({
  file: fileBlob,
  purpose: 'assistants',
});

// 2. Reference uploaded file in Chat Completion
const chatWithFile = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Summarize the attached file.' }],
  ref_file_ids: [uploaded.id],
});
```

---

### 7. Standalone `DeepSeekHashV1` PoW Solver (`ds2api/pow`)

You can import the PoW engine directly as a lightweight subpath (`ds2api/pow`) without instantiating the full OpenAI client:

```ts
import { solvePow, solveAndBuildHeader, deepSeekHashV1Hex, PowSolverRegistry } from 'ds2api/pow';

const hashHex = deepSeekHashV1Hex('testsalt_1700000000_42');
// => "d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09"

const answer = solvePow({
  algorithm: 'DeepSeekHashV1',
  challenge: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09',
  salt: 'testsalt',
  difficulty: 144000,
  expire_at: 1700000000,
});
// => 42
```

---

## ☁️ Edge Deployment & Ecosystem Integration

### Deploy as a Cloudflare Worker OpenAI Proxy

```ts
import OpenAI from 'ds2api';

export interface Env {
  DEEPSEEK_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new OpenAI({
      apiKey: env.DEEPSEEK_TOKEN,
      autoDeleteSession: 'single',
    });
    // Exposes /v1/models, /v1/chat/completions, /v1/completions, /v1/responses, /v1/files
    return client.fetch(request);
  },
};
```

### Run as a `Bun.serve` HTTP Server

```ts
import OpenAI from 'ds2api';

const client = new OpenAI({ apiKey: process.env.DEEPSEEK_TOKEN });

Bun.serve({
  port: 3000,
  fetch: (req) => client.fetch(req),
});
```

### Plug into the Official `openai` Package / Vercel AI SDK / LangChain (`client.asFetch()`)

```ts
import OfficialOpenAI from 'openai';
import { DS2OpenAI } from 'ds2api';

const ds = new DS2OpenAI({ apiKey: process.env.DEEPSEEK_TOKEN });

const openai = new OfficialOpenAI({
  apiKey: 'ds2api',
  fetch: ds.asFetch(),
});

const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Routed through ds2api in-memory!' }],
});
```

---

## 🤖 Supported Models & Built-in Aliases

| Model ID                                     | Thinking (`reasoning_content`) | Web Search (`search_enabled`) | Upstream `model_type` |
| :------------------------------------------- | :----------------------------: | :---------------------------: | :-------------------: |
| `deepseek-chat` / `deepseek-v4-flash`        |               ❌               |              ❌               |       `default`       |
| `deepseek-reasoner` / `deepseek-v4-thinking` |               ✅               |              ❌               |       `default`       |
| `deepseek-chat-search`                       |               ❌               |              ✅               |       `default`       |
| `deepseek-reasoner-search`                   |               ✅               |              ✅               |       `default`       |
| `deepseek-expert`                            |               ❌               |              ❌               |       `expert`        |
| `deepseek-expert-reasoner`                   |               ✅               |              ❌               |       `expert`        |
| `deepseek-vision`                            |               ❌               |              ❌               |       `vision`        |

**Automatic OpenAI & Claude Model Aliases:**

- `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` $\rightarrow$ `deepseek-v4-flash`
- `o1`, `o1-mini`, `o3`, `o3-mini`, `o4-mini`, `gpt-5-codex` $\rightarrow$ `deepseek-v4-thinking`

---

## 📋 Implemented OpenAI SDK Namespaces & Methods

| Namespace                 | Implemented Methods                                                                                      |
| :------------------------ | :------------------------------------------------------------------------------------------------------- |
| `client.chat.completions` | `create`, `parse`, `stream`, `runTools`, `retrieve`, `update`, `list`, `del` / `delete`, `messages.list` |
| `client.completions`      | `create`                                                                                                 |
| `client.responses`        | `create`, `parse`, `stream`, `retrieve`, `del` / `delete`, `cancel`, `inputItems.list`                   |
| `client.models`           | `list`, `listConfigs`, `retrieve`, `del` / `delete`                                                      |
| `client.files`            | `create`, `retrieve`, `list`, `del` / `delete`, `content`, `waitForProcessing`                           |
| `client.uploads`          | `create`, `addPart`, `complete`, `cancel`                                                                |
| `client.beta`             | `beta.chat.completions.*`, `beta.assistants.*`, `beta.threads.*`                                         |
| Low-level HTTP & Edge     | `get`, `post`, `put`, `patch`, `delete`, `request`, `withOptions`, `fetch`, `asFetch`                    |

---

## 🏗️ Architecture & Design Patterns

The codebase enforces **0 occurrences of `any` and `unknown`** across all source (`src/**/*.ts`) and declaration (`dist/**/*.d.ts`) files, verified automatically in the test suite.

| Design Pattern      | Implementation Class                                               | Responsibility                                                                                                             |
| :------------------ | :----------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **Strategy**        | `PowSolverStrategy`, `DeepSeekHashV1Strategy`, `PowSolverRegistry` | Pluggable Proof-of-Work hash & nonce solver registry (`src/pow/keccak.ts`).                                                |
| **Strategy**        | `AccountSelectionStrategy`, `RoundRobinSelectionStrategy`          | Pluggable account rotation strategy inside `AccountPool` (`src/auth/account-pool.ts`).                                     |
| **State Machine**   | `ToolSieveStateMachine`                                            | Streaming XML / `<｜DSML｜function_calls>` / fenced-code state machine (`src/toolcall/sieve.ts`).                          |
| **Builder**         | `DeepSeekPromptBuilder`, `CompletionPayloadBuilder`                | Fluent construction of `<｜begin▁of▁sentence｜>` prompts and completion payloads (`src/prompt/builder.ts`).                |
| **Factory**         | `OpenAIErrorFactory`, `OpenAIResponseFactory`                      | Standardized instantiation of OpenAI error subclasses and response objects (`src/openai/core.ts`, `src/openai/engine.ts`). |
| **Adapter**         | `RequestPayloadAdapter`                                            | Type-safe conversion from OpenAI SDK parameter interfaces to `JsonObject` (`src/openai/engine.ts`).                        |
| **Observer**        | `TypedStreamEventBus`                                              | Strictly-typed per-event listener buckets for `ChatCompletionStream` (`src/openai/chat-stream-helper.ts`).                 |
| **Router / Facade** | `EdgeHttpRouter`, `OpenAI`                                         | Declarative `ts-pattern` HTTP routing for `/v1/*` endpoints and unified SDK facade (`src/openai/client.ts`).               |

---

## 🧪 Development & Testing

```bash
# Typecheck with strict TypeScript
npm run typecheck

# Build ESM (.mjs) + CommonJS (.cjs) + TypeScript Declarations (.d.ts)
npm run build

# Run test suite on Node.js
npm test

# Run test suite on Bun
bun test tests/sdk.test.mjs

# Run interactive TypeScript examples (with Bun or Node.js 22+)
bun examples/hello.ts
bun examples/login.ts
bun examples/models.ts
```

---

## 📄 License

[MIT](./LICENSE)
