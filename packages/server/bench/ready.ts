import { io } from 'socket.io-client';
const ORIGIN = 'http://localhost:4000';
const NICK = process.argv[2]!;
const res = await fetch(`${ORIGIN}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `${NICK.toLowerCase()}@bot.example.com`, password: 'password123' }),
});
const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
const s = io(ORIGIN, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
s.on('connect', () => { s.emit('msg', { t: 'ready:toggle' }); setTimeout(() => { s.close(); process.exit(0); }, 800); });
