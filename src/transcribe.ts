import { config } from './config';
import { logger } from './logger';

/** Скачивает аудио по URL и распознаёт через Groq Whisper. Возвращает текст. */
export async function transcribeVoice(audioUrl: string): Promise<string> {
  if (!config.groqApiKey) {
    logger.warn('Voice transcription requested but GROQ_API_KEY is not configured', 'transcribe');
    throw new Error('Распознавание голоса не настроено (нет GROQ_API_KEY)');
  }

  logger.info('Starting voice transcription...', 'transcribe');
  const startTime = Date.now();
  const download = await fetch(audioUrl);
  if (!download.ok) {
    logger.error(`Failed to download voice file: HTTP ${download.status}`, undefined, 'transcribe');
    throw new Error(`Не смог скачать аудио: HTTP ${download.status}`);
  }
  const buffer = await download.arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-large-v3');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Groq transcription API failed: HTTP ${response.status} ${errorText}`, undefined, 'transcribe');
    throw new Error(`Ошибка распознавания: HTTP ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as { text?: string };
  const text = (data.text ?? '').trim();
  if (!text) {
    logger.warn('Groq transcription API returned empty text', 'transcribe');
    throw new Error('Распознавание вернуло пустой текст');
  }
  const duration = Date.now() - startTime;
  logger.info(`Voice transcription completed successfully in ${duration}ms`, 'transcribe');
  return text;
}
