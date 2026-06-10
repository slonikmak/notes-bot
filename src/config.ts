import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  }
  return value;
}

export const config = {
  botToken: required('TELEGRAM_BOT_TOKEN'),
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  apiKey: process.env.API_KEY ?? '',
  apiPort: Number(process.env.API_PORT ?? 3000),
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  dbPath: process.env.DB_PATH ?? 'notes.db',
};
