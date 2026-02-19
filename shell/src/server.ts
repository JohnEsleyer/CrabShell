import { handleTelegramUpdate, sendTelegramMessage } from './telegram';
import { getAllAgents, isAllowed, initDb } from './db';
import { checkDocker } from './docker';
import * as fs from 'fs';
import * as path from 'path';

const PORT = process.env.PORT || 3000;

export async function startServer() {
    await initDb();
    
    const fastify = require('fastify')({ logger: true });

    fastify.get('/health', async () => {
        const dockerOk = await checkDocker();
        return { 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            docker: dockerOk ? 'online' : 'offline'
        };
    });

    fastify.get('/webhook/:token', async (_request: any, _reply: any) => {
        return { message: 'Use POST /webhook/:token for Telegram updates' };
    });

    fastify.post('/webhook/:token', async (request: any, _reply: any) => {
        try {
            const token = request.params.token;
            const update = request.body as any;
            
            if (!update.message) {
                return { ok: true };
            }

            const chatId = update.message.chat.id;
            const response = await handleTelegramUpdate(token, update);

            if (response) {
                await sendTelegramMessage(token, chatId, response);
            }

            return { ok: true };
        } catch (error) {
            console.error('Error handling webhook:', error);
            return { ok: false, error: 'Internal error' };
        }
    });

    fastify.get('/api/agents', async () => {
        return await getAllAgents();
    });

    fastify.get('/api/docker/status', async () => {
        return { ok: await checkDocker() };
    });

    fastify.register(require('@fastify/static'), {
        root: path.join(__dirname, '../dashboard/dist'),
        prefix: '/dashboard/',
    });

    fastify.get('/dashboard', async (_request: any, reply: any) => {
        return reply.sendFile('index.html');
    });

    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`🦀 Shell listening on port ${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}/dashboard/`);
}

if (require.main === module) {
    require('dotenv').config();
    startServer().catch(console.error);
}
