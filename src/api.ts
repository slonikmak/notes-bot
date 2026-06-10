import http from 'node:http';
import { config } from './config';
import { addNote, apiNotes, apiTopics, getTopicAny } from './db';

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
    console.warn('API_KEY не задан — HTTP API выключен.');
    return;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-api-key'] !== config.apiKey) {
        return send(res, 401, { error: 'неверный или отсутствующий заголовок X-API-Key' });
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = url.searchParams;

      // GET /api/topics?user_id=
      if (req.method === 'GET' && url.pathname === '/api/topics') {
        return send(res, 200, apiTopics(numParam(q.get('user_id'), 'user_id')));
      }

      // GET /api/notes?user_id=&topic_id=&topic_name=&since=2026-06-10T12:00:00 (UTC)
      if (req.method === 'GET' && url.pathname === '/api/notes') {
        return send(
          res,
          200,
          apiNotes({
            userId: numParam(q.get('user_id'), 'user_id'),
            topicId: numParam(q.get('topic_id'), 'topic_id'),
            topicName: q.get('topic_name') ?? undefined,
            since: q.get('since') ?? undefined,
          }),
        );
      }

      // POST /api/notes  {"topic_id": 1, "text": "..."}
      if (req.method === 'POST' && url.pathname === '/api/notes') {
        const body = await readJson(req);
        const topicId = Number(body.topic_id);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!Number.isInteger(topicId) || !text) {
          return send(res, 400, { error: 'нужны topic_id (число) и text (непустая строка)' });
        }
        const topic = getTopicAny(topicId);
        if (!topic) return send(res, 404, { error: `темы с id=${topicId} нет` });
        return send(res, 201, addNote(topic, 'api', text));
      }

      send(res, 404, {
        error: 'not found',
        endpoints: ['GET /api/topics', 'GET /api/notes', 'POST /api/notes'],
      });
    } catch (e) {
      const status = e instanceof RequestError ? 400 : 500;
      send(res, status, { error: (e as Error).message });
    }
  });

  server.listen(config.apiPort, () => {
    console.log(`HTTP API: http://localhost:${config.apiPort} (заголовок X-API-Key)`);
  });
}
