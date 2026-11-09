import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openStore } from './src/store.mjs';
import { createAppServer } from './src/app.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.MOONBRIDGE_LOCAL_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MOONBRIDGE_LOCAL_PORT');
const db = openStore(join(root, 'data', 'moonbridge-local.sqlite'));
const server = createAppServer(db, join(root, 'public'));
server.listen(port, '127.0.0.1', () => {
  console.log(`MoonBridge local demo: http://127.0.0.1:${port}`);
  console.log('Desktop server address: http://127.0.0.1:' + port);
});
function close() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
