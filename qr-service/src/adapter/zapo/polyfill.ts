/**
 * A zapo usa o `WebSocket` global (Node >= 22). Em Node 20 não existe; `ws` cobre a
 * mesma API do cliente. Importado antes de qualquer `zapo-js`.
 */
import WebSocket from 'ws';

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === 'undefined') {
    g.WebSocket = WebSocket;
}
