import http from 'node:http';
import { config } from './config';
import { addNote, apiNotes, apiTopics, getTopicAny } from './db';
import { logger } from './logger';


class RequestError extends Error {}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function numParam(value: string | null, name: string): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new RequestError(`${name} должен быть числом, получил: ${value}`);
  return n;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new RequestError('тело запроса — не валидный JSON');
  }
}

export function startApi(): void {
  if (!config.apiKey) {
    logger.warn('API_KEY не задан — HTTP API выключен.', 'api');
    return;
  }

  const server = http.createServer(async (req, res) => {
    const reqInfo = `${req.method} ${req.url}`;
    try {
      logger.debug(`Incoming request: ${reqInfo}`, 'api');

      if (req.headers['x-api-key'] !== config.apiKey) {
        logger.warn(`Unauthorized access attempt: ${reqInfo}`, 'api');
        return send(res, 401, { error: 'неверный или отсутствующий заголовок X-API-Key' });
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = url.searchParams;

      // GET /api/topics?user_id=
      if (req.method === 'GET' && url.pathname === '/api/topics') {
        const userId = numParam(q.get('user_id'), 'user_id');
        logger.info(`GET /api/topics for user_id=${userId}`, 'api');
        return send(res, 200, apiTopics(userId));
      }

      // GET /api/notes?user_id=&topic_id=&topic_name=&since=2026-06-10T12:00:00 (UTC)
      if (req.method === 'GET' && url.pathname === '/api/notes') {
        const userId = numParam(q.get('user_id'), 'user_id');
        const topicId = numParam(q.get('topic_id'), 'topic_id');
        const topicName = q.get('topic_name') ?? undefined;
        const since = q.get('since') ?? undefined;
        logger.info(`GET /api/notes (user_id=${userId}, topic_id=${topicId}, topic_name=${topicName}, since=${since})`, 'api');
        return send(
          res,
          200,
          apiNotes({
            userId,
            topicId,
            topicName,
            since,
          }),
        );
      }

      // POST /api/notes  {"topic_id": 1, "text": "..."}
      if (req.method === 'POST' && url.pathname === '/api/notes') {
        const body = await readJson(req);
        const topicId = Number(body.topic_id);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!Number.isInteger(topicId) || !text) {
          logger.warn(`Bad POST /api/notes request: missing topic_id or text`, 'api');
          return send(res, 400, { error: 'нужны topic_id (число) и text (непустая строка)' });
        }
        const topic = getTopicAny(topicId);
        if (!topic) {
          logger.warn(`POST /api/notes failed: topic id=${topicId} not found`, 'api');
          return send(res, 404, { error: `темы с id=${topicId} нет` });
        }
        logger.info(`POST /api/notes: adding note to topic "${topic.name}" (id=${topicId})`, 'api');
        return send(res, 201, addNote(topic, 'api', text));
      }

      logger.warn(`Not found: ${reqInfo}`, 'api');
      send(res, 404, {
        error: 'not found',
        endpoints: ['GET /api/topics', 'GET /api/notes', 'POST /api/notes'],
      });
    } catch (e) {
      const status = e instanceof RequestError ? 400 : 500;
      if (status === 500) {
        logger.error(`API Internal Error on ${reqInfo}`, e, 'api');
      } else {
        logger.warn(`API Bad Request on ${reqInfo}: ${(e as Error).message}`, 'api');
      }
      send(res, status, { error: (e as Error).message });
    }
  });

  server.listen(config.apiPort, () => {
    logger.info(`HTTP API: http://localhost:${config.apiPort} (заголовок X-API-Key)`, 'api');
  });
}
