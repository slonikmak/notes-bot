import { config } from './config';

/** Скачивает аудио по URL и распознаёт через Groq Whisper. Возвращает текст. */
export async function transcribeVoice(audioUrl: string): Promise<string> {
  if (!config.groqApiKey) {
    throw new Error('Распознавание голоса не настроено (нет GROQ_API_KEY)');
  }

  const download = await fetch(audioUrl);
  if (!download.ok) {
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
    throw new Error(`Ошибка распознавания: HTTP ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { text?: string };
  const text = (data.text ?? '').trim();
  if (!text) {
    throw new Error('Распознавание вернуло пустой текст');
  }
  return text;
}
