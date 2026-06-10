import { createBot } from './bot';
import { startApi } from './api';
import { logger } from './logger';

async function main(): Promise<void> {
  logger.info('🚀 Starting Notes Bot...', 'bootstrap');
  const bot = createBot();
  startApi();
  await bot.api.setMyCommands([
    { command: 'topics', description: 'Темы' },
    { command: 'cancel', description: 'Отменить ввод' },
  ]);
  logger.info('Бот запущен (long polling). Ctrl+C — остановить.', 'bootstrap');
  await bot.start();
}

main().catch((e) => {
  logger.error('💥 Failed to start the bot', e, 'bootstrap');
  process.exit(1);
});
