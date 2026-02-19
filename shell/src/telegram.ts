import { getAgentByToken, isAllowed, getBudget, updateSpend, canSpend, updateAuditLog, getAgentById, getSetting, getOperator, getActiveMeetings, createMeeting, updateMeetingTranscript, closeMeeting } from './db';
import { spawnAgent, docker, getCubicleStatus, stopCubicle, removeCubicle } from './docker';

interface TelegramUpdate {
    message?: {
        from: { id: number; username?: string; first_name?: string };
        text: string;
        chat: { id: number };
    };
    callback_query?: {
        id: string;
        from: { id: number };
        data: string;
        message?: {
            chat: { id: number };
            message_id: number;
        };
    };
}

const TELEGRAM_MAX_LENGTH = 4000;

const pendingDelegations = new Map<string, { agentId: number; role: string; task: string; timestamp: number }>();

export async function sendChatAction(token: string, chatId: number, action: 'typing' | 'upload_document' = 'typing'): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/sendChatAction`;
    
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                action: action
            })
        });
    } catch (err) {
        console.error('Failed to send chat action:', err);
    }
}

export async function smartReply(token: string, chatId: number, text: string, messageId?: number): Promise<void> {
    if (text.length > TELEGRAM_MAX_LENGTH) {
        const buffer = Buffer.from(text, 'utf-8');
        const url = `https://api.telegram.org/bot${token}/sendDocument`;
        
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        formData.append('document', new Blob([buffer], { type: 'text/plain' }), 'output.txt');
        formData.append('caption', '📄 Output was too long, sent as file.');
        
        if (messageId) {
            try {
                await editMessageText(token, chatId, messageId, '✅ Response ready:');
            } catch {}
        }
        
        try {
            await fetch(url, {
                method: 'POST',
                body: formData
            });
        } catch (err) {
            console.error('Failed to send document:', err);
            const chunks = splitMessage(text);
            for (const chunk of chunks) {
                await sendTelegramMessage(token, chatId, chunk);
            }
        }
    } else {
        if (messageId) {
            await editMessageText(token, chatId, messageId, text);
        } else {
            await sendTelegramMessage(token, chatId, text);
        }
    }
}

function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
    const chunks: string[] = [];
    let remaining = text;
    
    while (remaining.length > maxLength) {
        let splitPoint = maxLength;
        const newlineIndex = remaining.lastIndexOf('\n', maxLength);
        if (newlineIndex > maxLength * 0.5) {
            splitPoint = newlineIndex + 1;
        }
        
        chunks.push(remaining.slice(0, splitPoint));
        remaining = remaining.slice(splitPoint);
    }
    
    if (remaining.length > 0) {
        chunks.push(remaining);
    }
    
    return chunks;
}

export async function handleTelegramUpdate(token: string, update: TelegramUpdate): Promise<string | null> {
    if (update.callback_query) {
        return await handleCallbackQuery(token, update.callback_query);
    }

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
        const username = update.message.from.username || 'unknown';
        const firstName = update.message.from.first_name || '';
        console.log(`[UNAUTHORIZED] Telegram user tried to message bot:`);
        console.log(`  User ID: ${userId}`);
        console.log(`  Username: @${username}`);
        console.log(`  First Name: ${firstName}`);
        console.log(`  Add this user to allowlist in dashboard to grant access.`);
        return `Unauthorized access. Your Telegram User ID is: ${userId}\n\nPlease provide this ID to the administrator to get access.`;
    }

    if (!await canSpend(agent.id)) {
        return `❌ Budget exceeded for ${agent.name}. Please try again tomorrow.`;
    }

    const text = update.message.text;
    const chatId = update.message.chat.id;

    if (text === '/status') {
        const status = await getCubicleStatus(agent.id, userId);
        if (!status) {
            return `📊 No active cubicle for ${agent.name}.`;
        }
        return `📊 Cubicle Status: *${status.status}*\nContainer: \`${status.containerId?.slice(0, 12) || 'N/A'}\``;
    }

    if (text === '/reset') {
        const status = await getCubicleStatus(agent.id, userId);
        if (status?.containerId) {
            await removeCubicle(status.containerId);
            return `🔄 Cubicle reset. A fresh container will be created on your next message.`;
        }
        return `📊 No cubicle to reset.`;
    }

    if (text === '/budget') {
        const budget = await getBudget(agent.id);
        if (budget) {
            return `💰 Budget for ${agent.name}:\nLimit: $${budget.daily_limit_usd.toFixed(2)}/day\nSpent: $${budget.current_spend_usd.toFixed(4)}`;
        }
        return `Budget info not available.`;
    }

    console.log(`[${agent.name}] Processing: ${text}`);

    return null;
}

export async function processAgentMessage(
    token: string,
    chatId: number,
    userId: number,
    text: string,
    statusMessageId?: number
): Promise<{ output: string; messageId?: number }> {
    const agent = await getAgentByToken(token);
    if (!agent) {
        return { output: 'Agent not found.' };
    }

    await sendChatAction(token, chatId, 'typing');
    
    if (statusMessageId) {
        await editMessageText(token, chatId, statusMessageId, `🔄 *${agent.name}* is waking up...`);
    }

    const meetings = await getActiveMeetings(agent.id);
    const meetingContext = meetings.length > 0 
        ? meetings.map(m => `Meeting with Agent ${m.initiator_id === agent.id ? m.participant_id : m.initiator_id}: ${m.topic}\n${m.transcript || 'No transcript yet'}`).join('\n\n')
        : null;

    try {
        if (statusMessageId) {
            await editMessageText(token, chatId, statusMessageId, `🔄 *${agent.name}* is thinking...`);
        }
        
        const result = await spawnAgent({
            agentId: agent.id,
            agentName: agent.name,
            agentRole: agent.role,
            dockerImage: agent.docker_image,
            userMessage: text,
            history: [],
            maxTokens: 1000,
            requireApproval: agent.require_approval === 1,
            userId: userId
        });

        if (result.output.includes('[MEETING]') && result.output.includes('TARGET_ROLE:')) {
            const roleMatch = result.output.match(/TARGET_ROLE:\s*(.+)/);
            const taskMatch = result.output.match(/TASK:\s*(.+)/);
            
            if (roleMatch && taskMatch) {
                const targetRole = roleMatch[1].trim();
                const task = taskMatch[1].trim();
                
                const delegationId = `${agent.id}_${Date.now()}`;
                pendingDelegations.set(delegationId, {
                    agentId: agent.id,
                    role: targetRole,
                    task: task,
                    timestamp: Date.now()
                });
                
                await sendDelegationRequest(token, agent.id, agent.name, targetRole, task, delegationId);
                
                return { 
                    output: `📋 Delegation request sent to operator for approval.\nTarget Role: *${targetRole}*\nTask: ${task.substring(0, 100)}...`,
                    messageId: statusMessageId
                };
            }
        }

        const estimatedCost = result.output.length * 0.00001;
        await updateSpend(agent.id, estimatedCost);

        return { output: result.output, messageId: statusMessageId };
    } catch (error: any) {
        console.error(`[${agent.name}] Error:`, error);
        return { output: `Error: ${error.message}`, messageId: statusMessageId };
    }
}

async function sendDelegationRequest(
    token: string,
    agentId: number,
    agentName: string,
    targetRole: string,
    task: string,
    delegationId: string
): Promise<void> {
    const operator = await getOperator();
    if (!operator) {
        console.log('No operator configured for delegation request');
        return;
    }

    const keyboard = {
        inline_keyboard: [[
            { text: '✅ Approve Delegation', callback_data: `delegate_approve:${delegationId}:${agentId}` },
            { text: '❌ Deny', callback_data: `delegate_deny:${delegationId}:${agentId}` }
        ]]
    };

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: operator.user_id,
            text: `🤝 *Delegation Request*\n\nAgent *${agentName}* wants to delegate a sub-task:\n\n*Target Role:* ${targetRole}\n*Task:*\n\`\`\`\n${task.substring(0, 500)}\n\`\`\`\n\nThis will spawn a new cubicle for the sub-task.`,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        })
    });
}

async function handleCallbackQuery(token: string, query: TelegramUpdate['callback_query']): Promise<string | null> {
    if (!query?.data || !query.message) return null;

    const parts = query.data.split(':');
    const action = parts[0];
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (action === 'delegate_approve' || action === 'delegate_deny') {
        const delegationId = parts[1];
        const agentId = parseInt(parts[2], 10);
        const adminId = query.from.id;
        
        const delegation = pendingDelegations.get(delegationId);
        
        if (!delegation) {
            await editMessageText(token, chatId, messageId, `❌ Delegation request expired or not found.`);
            return null;
        }
        
        if (action === 'delegate_approve') {
            await editMessageText(token, chatId, messageId, `✅ *Delegation Approved!*\n\nSpawning sub-agent for: ${delegation.role}...`);
            
            const agent = await getAgentById(agentId);
            if (agent) {
                try {
                    const result = await spawnAgent({
                        agentId: agentId,
                        agentName: delegation.role,
                        agentRole: delegation.role,
                        dockerImage: agent.docker_image,
                        userMessage: delegation.task,
                        history: [],
                        maxTokens: 1000,
                        requireApproval: false,
                        userId: adminId
                    });
                    
                    await sendTelegramMessage(token, chatId, `🤝 Sub-agent completed:\n\n${result.output.substring(0, 3000)}`);
                } catch (err: any) {
                    await sendTelegramMessage(token, chatId, `❌ Delegation failed: ${err.message}`);
                }
            }
        } else {
            await editMessageText(token, chatId, messageId, `❌ *Delegation Denied.* No sub-agent will be spawned.`);
        }
        
        pendingDelegations.delete(delegationId);
        return null;
    }

    const logIdStr = parts[1];
    const containerId = parts[2];
    const logId = parseInt(logIdStr, 10);

    if (action === 'approve' || action === 'deny') {
        const status = action === 'approve' ? 'approved' : 'denied';
        
        if (!isNaN(logId)) {
            await updateAuditLog(logId, status, query.from.id);
        }

        if (action === 'approve' && containerId) {
            try {
                const container = docker.getContainer(containerId);
                const exec = await container.exec({
                    Cmd: ['touch', '/tmp/hermit_approval.lock'],
                    AttachStdout: true,
                    AttachStderr: true
                });
                await exec.start({});
                await editMessageText(token, chatId, messageId, `✅ *Approved!* Command execution started.`);
            } catch (err) {
                console.error('Failed to approve command:', err);
                await editMessageText(token, chatId, messageId, `❌ Approval applied but container may not have received it.`);
            }
        } else {
            await editMessageText(token, chatId, messageId, `❌ *Denied.* Command will not be executed.`);
            
            if (containerId) {
                try {
                    const container = docker.getContainer(containerId);
                    const exec = await container.exec({
                        Cmd: ['touch', '/tmp/hermit_deny.lock'],
                        AttachStdout: true,
                        AttachStderr: true
                    });
                    await exec.start({});
                } catch {}
            }
        }

        return null;
    }

    return null;
}

export async function sendVerificationCode(token: string, chatId: number, code: string): Promise<boolean> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `🛡️ *HermitClaw Agent Verification*\n\nYou are linking this bot to the Orchestrator.\n\nYour verification code is: \`${code}\`\n\nEnter this code in the dashboard to complete setup.`,
                parse_mode: 'Markdown'
            })
        });
        
        return response.ok;
    } catch (err) {
        console.error('Failed to send verification code:', err);
        return false;
    }
}

export async function sendApprovalRequest(
    agentId: number,
    containerId: string,
    command: string,
    logId: number
): Promise<void> {
    const agent = await getAgentById(agentId);
    if (!agent) return;

    const operator = await getOperator();
    const adminChatId = operator?.user_id || await getSetting('admin_chat_id');
    
    if (!adminChatId) {
        console.log('No operator/admin chat ID configured');
        return;
    }

    const tgToken = agent.telegram_token;
    if (!tgToken) return;

    const keyboard = {
        inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${logId}:${containerId}` },
            { text: '❌ Deny', callback_data: `deny:${logId}:${containerId}` }
        ]]
    };

    const url = `https://api.telegram.org/bot${tgToken}/sendMessage`;
    
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: adminChatId,
            text: `⚠️ *Human Approval Required*\n\nAgent *${agent.name}* wants to execute:\n\`\`\`\n${command}\n\`\`\``,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        })
    });
}

export async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<number | undefined> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown'
            })
        });
        
        const data = await response.json() as { ok: boolean; result?: { message_id: number } };
        return data.result?.message_id;
    } catch (err) {
        console.error('Failed to send Telegram message:', err);
        return undefined;
    }
}

export async function editMessageText(token: string, chatId: number, messageId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/editMessageText`;
    
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text: text,
                parse_mode: 'Markdown'
            })
        });
    } catch (err) {
        console.error('Failed to edit message:', err);
    }
}

export async function setBotCommands(token: string): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/setMyCommands`;
    
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                commands: [
                    { command: 'start', description: 'Start the bot' },
                    { command: 'status', description: 'Check cubicle status' },
                    { command: 'reset', description: 'Reset the cubicle' },
                    { command: 'budget', description: 'Check remaining budget' }
                ]
            })
        });
    } catch (err) {
        console.error('Failed to set bot commands:', err);
    }
}
