import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Chat, Message, MessageOrigin } from 'grammy/types';
import { config } from './config';
import * as store from './db';
import { transcribeVoice } from './transcribe';
import { logger } from './logger';


const NAME_LIMIT = 64;
const NOTE_PREVIEW = 300;
const DEL_PREVIEW = 30;

type Pending = { action: 'new_topic' } | { action: 'rename_topic'; topicId: number };

/** Кто сейчас вводит название темы (в памяти — переживать рестарт не обязано). */
const pendingInput = new Map<number, Pending>();

/** Распознанный войс, ждущий подтверждения/правки. Ключ — message_id превью. */
interface VoiceDraft {
  topicId: number;
  text: string;
  forwardFrom: string | null;
  sourceType: store.SourceType;
}
const voiceDrafts = new Map<number, VoiceDraft>();
/** userId -> message_id последнего превью: следующий текст юзера = правка этого драфта. */
const lastDraft = new Map<number, number>();

// ---------- отрисовка ----------

function fmtStamp(createdAtUtc: string): string {
  const d = new Date(createdAtUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderTopics(userId: number): { text: string; kb: InlineKeyboard } {
  const topics = store.listTopics(userId);
  const active = store.getActiveTopic(userId);
  const kb = new InlineKeyboard();
  for (const t of topics) {
    kb.text(t.id === active?.id ? `📁 ${t.name} ✓` : `📁 ${t.name}`, `t:${t.id}`).row();
  }
  kb.text('➕ Новая тема', 'new');
  const text = topics.length
    ? 'Темы (тап — открыть и сделать активной):'
    : 'Тем пока нет. Создай первую.';
  return { text, kb };
}

const SOURCE_ICON: Record<store.SourceType, string> = {
  text: '',
  voice: '🎤 ',
  forward: '↩️ ',
  api: '🌐 ',
};

function renderTopic(topic: store.Topic): { text: string; kb: InlineKeyboard } {
  const notes = store.listNotes(topic.id);
  const total = store.countNotes(topic.id);
  const lines = [`📁 ${topic.name} — активная тема, заметок: ${total}`];
  if (total > notes.length) lines.push(`(показаны последние ${notes.length})`);
  lines.push('');
  if (notes.length) {
    for (const n of notes) {
      const body = n.text.length > NOTE_PREVIEW ? n.text.slice(0, NOTE_PREVIEW) + '…' : n.text;
      const src = n.forward_from ? `↩️ ${n.forward_from}: ` : SOURCE_ICON[n.source_type] ?? '';
      lines.push(`• [${fmtStamp(n.created_at)}] ${src}${body}`);
    }
  } else {
    lines.push('Пусто.');
  }
  lines.push('', 'Кидай текст / войс / форвард — запишу сюда.');

  const kb = new InlineKeyboard();
  if (notes.length) kb.text('🗑 Удалить заметку', `delnotes:${topic.id}`).row();
  kb.text('✏️ Переименовать', `ren:${topic.id}`)
    .text('❌ Удалить тему', `del:${topic.id}`)
    .row();
  kb.text('⬅️ Темы', 'topics');
  return { text: lines.join('\n'), kb };
}

function renderDelNotes(topic: store.Topic): { text: string; kb: InlineKeyboard } {
  const notes = store.listNotes(topic.id);
  const kb = new InlineKeyboard();
  for (const n of notes) {
    const preview = n.text.length > DEL_PREVIEW ? n.text.slice(0, DEL_PREVIEW) + '…' : n.text;
    kb.text(`✖ ${preview}`, `delnote:${n.id}`).row();
  }
  kb.text('⬅️ Назад', `t:${topic.id}`);
  return { text: `📁 ${topic.name}\nКакую заметку удалить (последние ${notes.length})?`, kb };
}

// ---------- мелкие помощники ----------

async function safeEdit(ctx: Context, text: string, kb: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    // «message is not modified» и подобное — не критично
  }
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // просроченный колбэк — не критично
  }
}

async function react(ctx: Context, emoji: '👀' | '✍'): Promise<void> {
  try {
    await ctx.react(emoji);
  } catch {
    // реакция — только индикация, без неё переживём
  }
}

async function fileUrl(ctx: Context, fileId: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');
  return `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
}

function chatTitle(chat: Chat): string {
  if ('title' in chat && chat.title) return chat.title;
  if ('first_name' in chat && chat.first_name) return chat.first_name;
  return String(chat.id);
}

function describeOrigin(origin: MessageOrigin): string {
  switch (origin.type) {
    case 'user': {
      const u = origin.sender_user;
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      return u.username ? `${name} (@${u.username})` : name;
    }
    case 'hidden_user':
      return origin.sender_user_name;
    case 'chat':
      return `чат «${chatTitle(origin.sender_chat)}»`;
    case 'channel': {
      const c = origin.chat;
      const at = 'username' in c && c.username ? ` (@${c.username})` : '';
      return `канал «${chatTitle(c)}»${at}`;
    }
  }
}

// ---------- сохранение входящих ----------

const PREVIEW_LIMIT = 3500; // показываемая часть распознанного текста (лимит сообщения 4096)
const COPY_TEXT_LIMIT = 256; // лимит Telegram на copy_text кнопку

/** Распознали войс — не сохраняем сразу, а даём подтвердить или поправить. */
async function sendVoicePreview(
  ctx: Context,
  topic: store.Topic,
  text: string,
  forwardFrom: string | null,
): Promise<void> {
  const kb = new InlineKeyboard().text('💾 Сохранить', 'vsave').text('✖ Отмена', 'vcancel');
  if (text.length <= COPY_TEXT_LIMIT) kb.row().copyText('📋 Скопировать для правки', text);
  const shown = text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) + '…' : text;
  const sent = await ctx.reply(
    `🎤 Распознал (тема «${topic.name}»):\n\n${shown}\n\n` +
      '💾 — сохранить как есть, или сразу пришли исправленный текст.',
    {
      reply_markup: kb,
      reply_parameters: { message_id: ctx.message!.message_id },
    },
  );
  voiceDrafts.set(sent.message_id, {
    topicId: topic.id,
    text,
    forwardFrom,
    sourceType: forwardFrom ? 'forward' : 'voice',
  });
  lastDraft.set(ctx.from!.id, sent.message_id);
}

/** Текст юзера при висящем превью — исправленная версия распознанного. */
async function applyDraftEdit(
  ctx: Context,
  userId: number,
  draftMsgId: number,
  newText: string,
): Promise<void> {
  const draft = voiceDrafts.get(draftMsgId)!;
  voiceDrafts.delete(draftMsgId);
  if (lastDraft.get(userId) === draftMsgId) lastDraft.delete(userId);

  const topic = store.getTopic(draft.topicId, userId);
  if (!topic) {
    logger.warn(`User ${userId} attempted to save voice draft but topic ${draft.topicId} was deleted`, 'bot');
    await ctx.reply('Тема этого черновика уже удалена — не сохранил.');
    return;
  }
  logger.info(`User ${userId} saved voice note in topic "${topic.name}"`, 'bot');
  store.addNote(topic, draft.sourceType, newText, draft.forwardFrom);
  if (ctx.chat) {
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        draftMsgId,
        `✍ Записал с правкой в «${topic.name}».`,
      );
    } catch {
      // превью могли удалить руками — не критично
    }
  }
  await react(ctx, '✍');
}

async function saveIncoming(ctx: Context, msg: Message, topic: store.Topic): Promise<void> {
  const userId = ctx.from?.id;
  // пересланное сообщение: текст/подпись сохраняем сразу, войс внутри — через превью
  if (msg.forward_origin) {
    const from = describeOrigin(msg.forward_origin);
    const text = msg.text ?? msg.caption ?? null;
    if (text) {
      logger.info(`User ${userId} saved forwarded text note in topic "${topic.name}"`, 'bot');
      store.addNote(topic, 'forward', text, from);
      await react(ctx, '✍');
      return;
    }
    if (msg.voice || msg.audio) {
      logger.info(`User ${userId} sent forwarded voice/audio for transcription in topic "${topic.name}"`, 'bot');
      await react(ctx, '👀');
      const recognized = await transcribeVoice(
        await fileUrl(ctx, (msg.voice ?? msg.audio)!.file_id),
      );
      await sendVoicePreview(ctx, topic, recognized, from);
      return;
    }
    logger.warn(`User ${userId} sent forwarded message without text/voice`, 'bot');
    await ctx.reply('В пересланном сообщении нет текста — не сохранил.');
    return;
  }

  // голосовое / аудио: распознаём и даём поправить перед сохранением
  if (msg.voice || msg.audio) {
    logger.info(`User ${userId} sent voice/audio for transcription in topic "${topic.name}"`, 'bot');
    await react(ctx, '👀');
    const recognized = await transcribeVoice(
      await fileUrl(ctx, (msg.voice ?? msg.audio)!.file_id),
    );
    await sendVoicePreview(ctx, topic, recognized, null);
    return;
  }

  // обычный текст
  if (msg.text) {
    logger.info(`User ${userId} saved text note in topic "${topic.name}"`, 'bot');
    store.addNote(topic, 'text', msg.text);
    await react(ctx, '✍');
    return;
  }

  logger.warn(`User ${userId} sent unsupported message type`, 'bot');
  await ctx.reply('Такое не сохраню. Кидай текст, войс или пересланное сообщение.');
}

async function handlePending(
  ctx: Context,
  userId: number,
  pending: Pending,
  name: string,
): Promise<void> {
  if (!name || name.length > NAME_LIMIT) {
    await ctx.reply(`Название — от 1 до ${NAME_LIMIT} символов. Попробуй ещё (или /cancel).`);
    return;
  }
  try {
    if (pending.action === 'new_topic') {
      logger.info(`User ${userId} creating new topic: "${name}"`, 'bot');
      const topic = store.createTopic(userId, name);
      store.setActiveTopic(userId, topic.id);
      pendingInput.delete(userId);
      const { text, kb } = renderTopic(topic);
      await ctx.reply(`Тема «${name}» создана и сделана активной.\n\n${text}`, {
        reply_markup: kb,
      });
    } else {
      logger.info(`User ${userId} renaming topic id=${pending.topicId} to "${name}"`, 'bot');
      store.renameTopic(pending.topicId, userId, name);
      pendingInput.delete(userId);
      const topic = store.getTopic(pending.topicId, userId);
      if (!topic) {
        logger.warn(`Renamed topic id=${pending.topicId} not found after renaming`, 'bot');
        const { text, kb } = renderTopics(userId);
        await ctx.reply(text, { reply_markup: kb });
        return;
      }
      const { text, kb } = renderTopic(topic);
      await ctx.reply(`Переименовал.\n\n${text}`, { reply_markup: kb });
    }
  } catch (e) {
    logger.error(`Error handling pending input for user ${userId}`, e, 'bot');
    if (store.isDuplicateError(e)) {
      await ctx.reply('Такая тема уже есть. Напиши другое название (или /cancel).');
      return;
    }
    throw e;
  }
}

// ---------- сборка бота ----------

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // доступ только для ALLOWED_USER_IDS (если список задан)
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (config.allowedUserIds.length && (!id || !config.allowedUserIds.includes(id))) {
      logger.warn(`Access denied for user ID: ${id}`, 'bot');
      if (ctx.message) await ctx.reply(`Доступ закрыт. Твой id: ${id} — попроси добавить его в ALLOWED_USER_IDS.`);
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    pendingInput.delete(ctx.from.id);
    const { text, kb } = renderTopics(ctx.from.id);
    await ctx.reply(
      'Привет! Я записываю мысли по темам.\n' +
        'Выбери тему — и просто кидай в чат текст, войсы и пересланные сообщения, всё лягут в неё заметками.\n\n' +
        text,
      { reply_markup: kb },
    );
  });

  bot.command('topics', async (ctx) => {
    if (!ctx.from) return;
    pendingInput.delete(ctx.from.id);
    const { text, kb } = renderTopics(ctx.from.id);
    await ctx.reply(text, { reply_markup: kb });
  });

  bot.command('cancel', async (ctx) => {
    if (!ctx.from) return;
    pendingInput.delete(ctx.from.id);
    const { text, kb } = renderTopics(ctx.from.id);
    await ctx.reply('Ок, отменил.\n\n' + text, { reply_markup: kb });
  });

  bot.callbackQuery('topics', async (ctx) => {
    pendingInput.delete(ctx.from.id);
    const { text, kb } = renderTopics(ctx.from.id);
    await safeEdit(ctx, text, kb);
  });

  bot.callbackQuery('new', async (ctx) => {
    pendingInput.set(ctx.from.id, { action: 'new_topic' });
    await safeEdit(ctx, 'Напиши название новой темы (или /cancel):', new InlineKeyboard());
  });

  bot.callbackQuery(/^t:(\d+)$/, async (ctx) => {
    pendingInput.delete(ctx.from.id);
    const topic = store.getTopic(Number(ctx.match[1]), ctx.from.id);
    if (!topic) {
      const { text, kb } = renderTopics(ctx.from.id);
      await safeEdit(ctx, 'Тема не найдена.\n\n' + text, kb);
      return;
    }
    store.setActiveTopic(ctx.from.id, topic.id);
    const { text, kb } = renderTopic(topic);
    await safeEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^ren:(\d+)$/, async (ctx) => {
    const topic = store.getTopic(Number(ctx.match[1]), ctx.from.id);
    if (!topic) {
      await ctx.answerCallbackQuery({ text: 'Тема не найдена' });
      return;
    }
    pendingInput.set(ctx.from.id, { action: 'rename_topic', topicId: topic.id });
    await safeEdit(ctx, `Новое название для «${topic.name}» (или /cancel):`, new InlineKeyboard());
  });

  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const topic = store.getTopic(Number(ctx.match[1]), ctx.from.id);
    if (!topic) {
      await ctx.answerCallbackQuery({ text: 'Тема не найдена' });
      return;
    }
    const n = store.countNotes(topic.id);
    const kb = new InlineKeyboard()
      .text('Да, удалить', `delyes:${topic.id}`)
      .text('Отмена', `t:${topic.id}`);
    await safeEdit(ctx, `Удалить тему «${topic.name}» и все её заметки (${n} шт.)?`, kb);
  });

  bot.callbackQuery(/^delyes:(\d+)$/, async (ctx) => {
    store.deleteTopic(Number(ctx.match[1]), ctx.from.id);
    const { text, kb } = renderTopics(ctx.from.id);
    await safeEdit(ctx, 'Тема удалена.\n\n' + text, kb);
  });

  bot.callbackQuery(/^delnotes:(\d+)$/, async (ctx) => {
    const topic = store.getTopic(Number(ctx.match[1]), ctx.from.id);
    if (!topic) {
      await ctx.answerCallbackQuery({ text: 'Тема не найдена' });
      return;
    }
    const { text, kb } = renderDelNotes(topic);
    await safeEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^delnote:(\d+)$/, async (ctx) => {
    const topicId = store.deleteNote(Number(ctx.match[1]), ctx.from.id);
    if (!topicId) {
      await ctx.answerCallbackQuery({ text: 'Заметка не найдена' });
      return;
    }
    const topic = store.getTopic(topicId, ctx.from.id)!;
    const { text, kb } = store.countNotes(topicId) ? renderDelNotes(topic) : renderTopic(topic);
    await safeEdit(ctx, text, kb);
  });

  // подтверждение распознанного войса
  bot.callbackQuery('vsave', async (ctx) => {
    const msgId = ctx.callbackQuery.message?.message_id;
    const draft = msgId !== undefined ? voiceDrafts.get(msgId) : undefined;
    if (msgId === undefined || !draft) {
      await safeEdit(ctx, 'Черновик потерян (бот перезапускался) — пришли войс заново.', new InlineKeyboard());
      return;
    }
    const topic = store.getTopic(draft.topicId, ctx.from.id);
    if (!topic) {
      voiceDrafts.delete(msgId);
      await safeEdit(ctx, 'Тема уже удалена — некуда сохранять.', new InlineKeyboard());
      return;
    }
    store.addNote(topic, draft.sourceType, draft.text, draft.forwardFrom);
    voiceDrafts.delete(msgId);
    if (lastDraft.get(ctx.from.id) === msgId) lastDraft.delete(ctx.from.id);
    await safeEdit(ctx, `✍ Записал в «${topic.name}».`, new InlineKeyboard());
  });

  bot.callbackQuery('vcancel', async (ctx) => {
    const msgId = ctx.callbackQuery.message?.message_id;
    if (msgId !== undefined) {
      voiceDrafts.delete(msgId);
      if (lastDraft.get(ctx.from.id) === msgId) lastDraft.delete(ctx.from.id);
    }
    await safeEdit(ctx, '✖ Не сохранил.', new InlineKeyboard());
  });

  // всё остальное: ввод названия, правка войса либо заметка в активную тему
  bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const msg = ctx.message;

    const pending = pendingInput.get(userId);
    if (pending) {
      if (!msg.text) {
        await ctx.reply('Жду текст — название темы (или /cancel).');
        return;
      }
      await handlePending(ctx, userId, pending, msg.text.trim());
      return;
    }

    // текст при висящем превью войса = исправленная версия распознанного;
    // reply на конкретное превью правит именно его, иначе правится последнее
    if (msg.text) {
      const replyId = msg.reply_to_message?.message_id;
      const draftMsgId =
        replyId !== undefined && voiceDrafts.has(replyId) ? replyId : lastDraft.get(userId);
      if (draftMsgId !== undefined && voiceDrafts.has(draftMsgId)) {
        await applyDraftEdit(ctx, userId, draftMsgId, msg.text);
        return;
      }
    }

    const active = store.getActiveTopic(userId);
    if (!active) {
      const { text, kb } = renderTopics(userId);
      await ctx.reply(
        'Сначала выбери активную тему — всё, что кидаешь, я записываю в неё.\n\n' + text,
        { reply_markup: kb },
      );
      return;
    }

    try {
      await saveIncoming(ctx, msg, active);
    } catch (e) {
      await ctx.reply(`⚠️ ${(e as Error).message}`);
    }
  });

  bot.catch((err) => {
    logger.error('Ошибка обработки апдейта:', err.error, 'bot');
  });

  return bot;
}
