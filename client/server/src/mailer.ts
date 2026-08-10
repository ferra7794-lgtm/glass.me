const apiKey = process.env.MAILTRAP_API_KEY;
const from = process.env.SMTP_FROM || 'Glass Messenger <hello@demomailtrap.co>';

export const mailEnabled = Boolean(apiKey);

export async function sendVerificationEmail(email: string, code: string) {
  if (!apiKey) {
    throw new Error('MAILTRAP_API_KEY is not configured in environment variables');
  }

  const res = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: { email: 'hello@demomailtrap.co', name: 'Glass Messenger' },
      to: [{ email }],
      subject: 'Your verification code',
      html: `
        <div style="font-family:Inter,Arial,sans-serif;background:#0b0f16;color:#eaf0ff;padding:24px;border-radius:20px;border:1px solid rgba(255,255,255,.08)">
          <div style="font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:#8fa3c7">Glass Messenger</div>
          <h1 style="margin:16px 0 8px;font-size:28px">Your verification code</h1>
          <div style="font-size:42px;font-weight:700;letter-spacing:.2em;margin:20px 0;padding:18px 22px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;display:inline-block">${code}</div>
          <p style="margin:18px 0 0;color:#b8c7e0">Code expires in 10 minutes.</p>
        </div>`
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Mailtrap error: ${JSON.stringify(err)}`);
  }
}