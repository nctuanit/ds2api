import Deepseek from '../dist/index.mjs';

// Tài khoản từ account.txt ("email|password" hoặc "email:password")
const rawAccount = 'deepseek1@dev4fun.vn|201102@Tuan';

async function main(): Promise<void> {
  console.log('1. Đang khởi tạo Deepseek client với tài khoản...');
  const client = new Deepseek({
    apiKey: rawAccount,
    autoDeleteSession: 'single',
  });

  // 2. Thực hiện login tự động qua AccountPool và lấy token
  console.log('2. Đang đăng nhập vào DeepSeek...');
  const auth = await client.deepseek.pool.acquire();
  console.log('Đăng nhập thành công!');
  console.log('   - Account ID:', auth.accountId);
  console.log('   - Bearer Token:', auth.token);

  // 3. Lấy thông tin chi tiết của User bằng token vừa nhận (/api/v0/users/current)
  console.log('\n3. Đang lấy thông tin User (/api/v0/users/current)...');
  const userInfo = await client.deepseek.getCurrentUser(auth);
  console.log('Thông tin User:', JSON.stringify(userInfo, null, 2));

  // 4. Test gọi thử Chat Completion bằng tài khoản vừa login
  console.log('\n4. Đang test gọi Chat Completion...');
  const completion = await client.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Chào bạn, trả lời ngắn gọn 1 câu thôi nhé!' }],
  });

  console.log('Assistant:', completion.choices[0]?.message.content);
}

main().catch((err) => {
  console.error('Lỗi:', err);
});
