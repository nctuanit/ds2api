import Deepseek, {
  safeJsonParseObject,
  type ChatCompletion,
  type ChatCompletionMessageParam,
  type ChatCompletionTool,
  type JsonObject,
  type JsonValue,
} from '../dist/index.mjs';

// Khởi tạo client với token hoặc tài khoản DeepSeek ("email:password" / Bearer token)
const client = new Deepseek({
  apiKey: `opKAYFDJ1reQts/5CD1ZX0/RdPd9xatDx5y0y+NKvYMeVhhCw90Ow40PTo61tlNY`,
});

// 1. Định nghĩa danh sách Tools cho AI Agent
const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Lấy thông tin thời tiết hiện tại của một thành phố',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'Tên thành phố (ví dụ: Hanoi, Ho Chi Minh, Tokyo)',
          },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Thực hiện phép tính toán học cơ bản giữa hai số',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'Số thứ nhất' },
          b: { type: 'number', description: 'Số thứ hai' },
          operator: {
            type: 'string',
            enum: ['add', 'subtract', 'multiply', 'divide'],
            description: 'Phép toán cần thực hiện',
          },
        },
        required: ['a', 'b', 'operator'],
      },
    },
  },
];

// 2. Định nghĩa hàm thực thi tương ứng với từng Tool
const toolHandlers: Record<string, (args: JsonObject) => Promise<JsonValue> | JsonValue> = {
  get_weather: (args: JsonObject): JsonObject => {
    const city = typeof args.city === 'string' ? args.city : 'Unknown';
    const mockData: Record<string, { tempC: number; condition: string }> = {
      hanoi: { tempC: 26, condition: 'Nắng nhẹ' },
      'ho chi minh': { tempC: 33, condition: 'Nắng nóng' },
      tokyo: { tempC: 18, condition: 'Trời quang' },
    };
    const info = mockData[city.toLowerCase()] ?? { tempC: 25, condition: 'Có mây' };
    return {
      city,
      temperature_celsius: info.tempC,
      condition: info.condition,
    };
  },

  calculate: (args: JsonObject): JsonObject => {
    const a = Number(args.a ?? 0);
    const b = Number(args.b ?? 0);
    const op = typeof args.operator === 'string' ? args.operator : 'add';

    let result = 0;
    if (op === 'add') result = a + b;
    else if (op === 'subtract') result = a - b;
    else if (op === 'multiply') result = a * b;
    else if (op === 'divide') result = b !== 0 ? a / b : 0;

    return { a, b, operator: op, result };
  },
};

// 3. Vòng lặp AI Agent (Think -> Act -> Observe -> Repeat)
async function runAgentLoop(userPrompt: string, maxSteps = 8): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        'Bạn là một AI Agent hữu ích. Hãy sử dụng các công cụ (tools) được cung cấp khi cần thiết để trả lời chính xác yêu cầu của người dùng.',
    },
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  console.log(`User: ${userPrompt}\n`);

  for (let step = 1; step <= maxSteps; step++) {
    console.log(`--- [Step ${step}] ---`);

    const response: ChatCompletion = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      tools,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('Không nhận được phản hồi từ model.');
    }

    const assistantMessage = choice.message;

    if (assistantMessage.reasoning_content) {
      console.log(`[Thinking]: ${assistantMessage.reasoning_content}`);
    }

    // Lưu phản hồi của assistant vào lịch sử hội thoại
    messages.push({
      role: 'assistant',
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    // Nếu model không gọi thêm tool nào -> Hoàn thành vòng lặp và in câu trả lời cuối cùng
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log(`\nAssistant: ${assistantMessage.content ?? ''}`);
      return;
    }

    // Thực thi tất cả các tool_calls mà model yêu cầu trong lượt này
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = safeJsonParseObject(toolCall.function.arguments) ?? {};

      console.log(`[Tool Call] ${toolName}(${JSON.stringify(toolArgs)})`);

      const handler = toolHandlers[toolName];
      let toolResult: JsonValue;

      if (!handler) {
        toolResult = { error: `Tool "${toolName}" không tồn tại.` };
      } else {
        try {
          toolResult = await handler(toolArgs);
        } catch (err) {
          toolResult = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const serializedResult =
        typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
      console.log(`[Tool Output] ${serializedResult}`);

      // Đẩy kết quả thực thi tool vào messages để AI xử lý ở vòng lặp tiếp theo
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: serializedResult,
      });
    }
  }

  console.warn(`Đã đạt giới hạn số bước tối đa (${maxSteps} steps).`);
}

async function main(): Promise<void> {
  await runAgentLoop(
    'Kiểm tra thời tiết ở Hanoi và Tokyo, sau đó dùng công cụ tính chênh lệch nhiệt độ giữa hai thành phố này.',
  );
}

main().catch(console.error);
