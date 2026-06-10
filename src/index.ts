import { createBot } from './bot';
import { startApi } from './api';

async function main(): Promise<void> {
  const bot = createBot();
  startApi();
  await bot.api.setMyCommands([
    { command: 'topics', description: 'Темы' },
    { command: 'cancel', description: 'Отменить ввод' },
  ]);
  console.log('Бот запущен (long polling). Ctrl+C — остановить.');
  await bot.start();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
