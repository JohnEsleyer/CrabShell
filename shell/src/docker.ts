import Docker from 'dockerode';
import * as fs from 'fs';
import * as path from 'path';
import { createAuditLog, getAgentById, getAllSettings } from './db';
import { sendApprovalRequest } from './telegram';

let docker: Docker;

try {
    docker = new Docker({ socketPath: '/var/run/docker.sock' });
} catch {
    docker = new Docker({ socketPath: '/var/run/docker.sock' });
}

interface Message {
    role: string;
    content: string;
}

interface AgentConfig {
    agentId: number;
    agentName: string;
    agentRole: string;
    dockerImage: string;
    userMessage: string;
    history: Message[];
    maxTokens: number;
    requireApproval?: boolean;
}

interface SpawnResult {
    containerId: string;
    output: string;
}

const HISTORY_DIR = path.join(__dirname, '../../data/history_buffer');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

export async function spawnAgent(config: AgentConfig): Promise<SpawnResult> {
    const imageName = config.dockerImage || 'hermit/base:latest';
    
    const historyFile = path.join(HISTORY_DIR, `${config.agentId}_${Date.now()}.json`);
    try {
        fs.writeFileSync(historyFile, JSON.stringify(config.history));
    } catch (err) {
        console.error('Failed to write history file:', err);
        throw new Error('Failed to create history buffer');
    }

    const settings = await getAllSettings();
    const provider = settings.default_provider || 'openrouter';
    const model = settings.default_model || 'auto';

    const envVars = [
        `AGENT_ID=${config.agentId}`,
        `USER_MSG=${config.userMessage}`,
        `MAX_TOKENS=${config.maxTokens}`,
        `AGENT_NAME=${config.agentName}`,
        `AGENT_ROLE=${config.agentRole}`,
        `DOCKER_IMAGE=${config.dockerImage}`,
        `HISTORY_FILE=/app/history.json`,
        `LLM_PROVIDER=${provider}`,
        `LLM_MODEL=${model}`,
    ];

    if (config.requireApproval) {
        envVars.push('HITL_ENABLED=true');
    }

    // Pass API keys from settings (prefer settings over env vars)
    const providerKeyMap: Record<string, { key: string; env: string }> = {
        'openai': { key: 'openai_api_key', env: 'OPENAI_API_KEY' },
        'anthropic': { key: 'anthropic_api_key', env: 'ANTHROPIC_API_KEY' },
        'google': { key: 'google_api_key', env: 'GOOGLE_API_KEY' },
        'groq': { key: 'groq_api_key', env: 'GROQ_API_KEY' },
        'openrouter': { key: 'openrouter_api_key', env: 'OPENROUTER_API_KEY' },
        'mistral': { key: 'mistral_api_key', env: 'MISTRAL_API_KEY' },
        'deepseek': { key: 'deepseek_api_key', env: 'DEEPSEEK_API_KEY' },
        'xai': { key: 'xai_api_key', env: 'XAI_API_KEY' },
    };

    // Pass all available API keys to the container
    for (const [prov, mapping] of Object.entries(providerKeyMap)) {
        const settingKey = settings[mapping.key];
        const envValue = settingKey || process.env[mapping.env];
        if (envValue) {
            envVars.push(`${mapping.env}=${envValue}`);
        }
    }

    // Legacy support for MODEL env var
    if (process.env.MODEL) {
        envVars.push(`MODEL=${process.env.MODEL}`);
    }

    let container: Docker.Container | undefined;
    let containerId = '';
    
    try {
        const createdContainer = await docker.createContainer({
            Image: imageName,
            Env: envVars,
            Cmd: ['crab'],
            HostConfig: {
                AutoRemove: true,
                Memory: 512 * 1024 * 1024,
                CpuQuota: 100000,
                PidsLimit: 100,
                NetworkMode: 'bridge',
                Binds: [`${historyFile}:/app/history.json:ro`],
            },
            AttachStdout: true,
            AttachStderr: true,
            Tty: false
        });

        container = createdContainer;
        const currentContainerId = container.id;
        containerId = currentContainerId;

        await container.start();

        return await new Promise((resolve, reject) => {
            let output = '';
            let approvalLogId: number | null = null;
            
            const timeout = setTimeout(async () => {
                try {
                    if (container) await container.stop();
                } catch {}
                const lines = output.split('\n').filter((l: string) => l.trim() && !l.startsWith('{'));
                resolve({
                    containerId: currentContainerId,
                    output: lines.join('\n').trim() || 'Timeout reached'
                });
            }, 120000);

            if (!container) {
                cleanup();
                resolve({ containerId: '', output: 'Container not created' });
                return;
            }

            container.logs({
                follow: true,
                stdout: true,
                stderr: true,
                tail: 500
            }, async (err, stream) => {
                if (err) {
                    clearTimeout(timeout);
                    cleanup();
                    reject(err);
                    return;
                }

                if (!stream) {
                    clearTimeout(timeout);
                    cleanup();
                    resolve({ containerId: currentContainerId, output: 'No stream available' });
                    return;
                }

                stream.on('data', async (chunk: Buffer) => {
                    const line = chunk.toString();
                    output += line;
                    
                    if (line.includes('[HITL] APPROVAL_REQUIRED:')) {
                        try {
                            const cmd = line.split('REQUIRED:')[1]?.trim() || 'Unknown command';
                            approvalLogId = await createAuditLog(config.agentId, currentContainerId, cmd, 'Pending approval');
                            
                            const agent = await getAgentById(config.agentId);
                            await sendApprovalRequest(
                                config.agentId,
                                currentContainerId,
                                cmd,
                                approvalLogId
                            );
                        } catch (err) {
                            console.error('Error sending approval request:', err);
                        }
                    }

                    if (line.includes('[HITL] APPROVED') || line.includes('[HITL] EXECUTED')) {
                        if (approvalLogId) {
                            const { updateAuditLog } = await import('./db');
                            updateAuditLog(approvalLogId, 'approved');
                        }
                    }
                });

                stream.on('end', () => {
                    clearTimeout(timeout);
                    cleanup();
                    const lines = output.split('\n').filter((l: string) => l.trim() && !l.startsWith('{'));
                    resolve({
                        containerId: currentContainerId,
                        output: lines.join('\n').trim() || 'No response from agent'
                    });
                });

                stream.on('error', (err: Error) => {
                    clearTimeout(timeout);
                    cleanup();
                    reject(err);
                });
            });

            function cleanup() {
                try {
                    fs.unlinkSync(historyFile);
                } catch {}
            }
        });
    } catch (error: any) {
        console.error('Docker Spawn Error:', error);
        try {
            if (container) await container.remove({ force: true });
        } catch {}
        try {
            fs.unlinkSync(historyFile);
        } catch {}
        throw new Error(`Failed to spawn cubicle: ${error.message}`);
    }
}

export async function listContainers(): Promise<Docker.ContainerInfo[]> {
    const containers = await docker.listContainers({ all: true });
    return containers;
}

export async function checkDocker(): Promise<boolean> {
    try {
        await docker.ping();
        return true;
    } catch {
        return false;
    }
}

export function getAvailableImages(): string[] {
    return [
        'hermit/base:latest',
        'hermit/python:latest',
        'hermit/netsec:latest',
        'hermit-crab:latest'
    ];
}

export async function getContainerExec(containerId: string): Promise<Docker.Exec> {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: ['/bin/bash']
    });
    return exec;
}

export { docker };
