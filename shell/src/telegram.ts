import { getAgentByToken, isAllowed, getBudget, updateSpend, canSpend } from './db';
import { spawnAgent } from './docker';

interface TelegramUpdate {
    message?: {
        from: { id: number; username?: string; first_name?: string };
        text: string;
        chat: { id: number };
    };
}

export async function handleTelegramUpdate(token: string, update: TelegramUpdate): Promise<string | null> {
    const agent = await getAgentByToken(token);
    if (!agent) {
        console.log(`Unknown agent token: ${token.slice(0, 8)}...`);
        return null;
    }

    if (!update.message) {
        return null;
    }

    const userId = update.message.from.id;
    if (!await isAllowed(userId)) {
        console.log(`Unauthorized user: ${userId}`);
        return null;
    }

    if (!await canSpend(agent.id)) {
        return `❌ Budget exceeded for ${agent.name}. Please try again tomorrow.`;
    }

    const text = update.message.text;
    const chatId = update.message.chat.id;

    console.log(`[${agent.name}] Processing: ${text}`);

    try {
        const result = await spawnAgent({
            agentId: agent.id,
            agentName: agent.name,
            agentRole: agent.role,
            dockerImage: agent.docker_image,
            userMessage: text,
            history: [],
            maxTokens: 1000
        });

        const estimatedCost = result.output.length * 0.00001;
        await updateSpend(agent.id, estimatedCost);

        return result.output;
    } catch (error: any) {
        console.error(`[${agent.name}] Error:`, error);
        return `Error: ${error.message}`;
    }
}

export async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        })
    });
}
