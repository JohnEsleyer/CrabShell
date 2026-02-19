import Docker from 'dockerode';
import * as fs from 'fs';
import * as path from 'path';
import { createAuditLog, getAgentById, getAllSettings, getSetting, getActiveMeetings } from './db';
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
    userId?: number;
}

interface SpawnResult {
    containerId: string;
    output: string;
}

interface CubicleInfo {
    id: string;
    state: string;
    labels: Record<string, string>;
    created: number;
}

const HISTORY_DIR = path.join(__dirname, '../../data/history_buffer');
const WORKSPACE_DIR = path.join(__dirname, '../../data/workspaces');
const CACHE_DIR = path.join(__dirname, '../../data/cache');

[HISTORY_DIR, WORKSPACE_DIR, CACHE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const LABEL_PREFIX = 'hermitclaw.';
const LABELS = {
    AGENT_ID: `${LABEL_PREFIX}agent_id`,
    USER_ID: `${LABEL_PREFIX}user_id`,
    LAST_ACTIVE: `${LABEL_PREFIX}last_active`,
    STATUS: `${LABEL_PREFIX}status`,
    CREATED_AT: `${LABEL_PREFIX}created_at`
};

async function findContainerByLabels(agentId: number, userId: number): Promise<CubicleInfo | null> {
    const containers = await docker.listContainers({ all: true });
    
    for (const container of containers) {
        const labels = container.Labels || {};
        if (labels[LABELS.AGENT_ID] === String(agentId) && labels[LABELS.USER_ID] === String(userId)) {
            return {
                id: container.Id,
                state: container.State,
                labels: labels as Record<string, string>,
                created: container.Created
            };
        }
    }
    return null;
}

export async function getOrCreateCubicle(config: AgentConfig): Promise<Docker.Container> {
    const userId = config.userId || 0;
    const existing = await findContainerByLabels(config.agentId, userId);
    
    if (existing) {
        const container = docker.getContainer(existing.id);
        
        if (existing.state === 'running') {
            await updateContainerLastActive(existing.id);
            console.log(`[Cubicle] Reusing running container ${existing.id.slice(0, 12)}`);
            return container;
        } else if (existing.state === 'exited' || existing.state === 'created') {
            console.log(`[Cubicle] Waking up hibernated container ${existing.id.slice(0, 12)}`);
            await container.start();
            await updateContainerLastActive(existing.id);
            return container;
        }
    }
    
    return await createNewCubicle(config);
}

async function updateContainerLastActive(containerId: string): Promise<void> {
    try {
        const container = docker.getContainer(containerId);
        const now = new Date().toISOString();
        
        const existingInfo = await container.inspect();
        const existingLabels = existingInfo.Config?.Labels || {};
        
        await container.update({
            Labels: {
                ...existingLabels,
                [LABELS.LAST_ACTIVE]: now,
                [LABELS.STATUS]: 'active'
            }
        });
    } catch (err) {
        console.error('Failed to update container last_active:', err);
    }
}

async function createNewCubicle(config: AgentConfig): Promise<Docker.Container> {
    const imageName = config.dockerImage || 'hermit/base:latest';
    const userId = config.userId || 0;
    const workspaceId = `${config.agentId}_${userId}`;
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    
    if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
    }
    
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

    for (const [prov, mapping] of Object.entries(providerKeyMap)) {
        const settingKey = settings[mapping.key];
        const envValue = settingKey || process.env[mapping.env];
        if (envValue) {
            envVars.push(`${mapping.env}=${envValue}`);
        }
    }

    if (process.env.MODEL) {
        envVars.push(`MODEL=${process.env.MODEL}`);
    }

    const now = new Date().toISOString();
    
    const meetings = await getActiveMeetings(config.agentId);
    if (meetings.length > 0) {
        const meetingContext = meetings.map(m => ({
            meeting_id: m.id,
            topic: m.topic,
            transcript: m.transcript || '',
            participant_role: `Agent ${m.initiator_id === config.agentId ? m.participant_id : m.initiator_id}`
        }));
        const meetingContextFile = path.join(workspacePath, `meeting_context_${config.agentId}.json`);
        fs.writeFileSync(meetingContextFile, JSON.stringify(meetingContext, null, 2));
    }
    
    const binds = [
        `${historyFile}:/app/history.json:ro`,
        `${workspacePath}:/app/workspace:rw`,
    ];
    
    const pipCachePath = path.join(CACHE_DIR, 'pip');
    const npmCachePath = path.join(CACHE_DIR, 'npm');
    
    if (!fs.existsSync(pipCachePath)) fs.mkdirSync(pipCachePath, { recursive: true });
    if (!fs.existsSync(npmCachePath)) fs.mkdirSync(npmCachePath, { recursive: true });
    
    binds.push(`${pipCachePath}:/root/.cache/pip:rw`);
    binds.push(`${npmCachePath}:/root/.npm:rw`);

    const createdContainer = await docker.createContainer({
        Image: imageName,
        Env: envVars,
        Cmd: ['crab'],
        HostConfig: {
            AutoRemove: false,
            Memory: 512 * 1024 * 1024,
            CpuQuota: 100000,
            PidsLimit: 100,
            NetworkMode: 'bridge',
            Binds: binds,
        },
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Labels: {
            [LABELS.AGENT_ID]: String(config.agentId),
            [LABELS.USER_ID]: String(userId),
            [LABELS.LAST_ACTIVE]: now,
            [LABELS.STATUS]: 'active',
            [LABELS.CREATED_AT]: now,
        }
    });

    console.log(`[Cubicle] Created new container ${createdContainer.id.slice(0, 12)} for agent ${config.agentId}`);
    
    await createdContainer.start();
    
    try {
        fs.unlinkSync(historyFile);
    } catch {}
    
    return createdContainer;
}

export async function spawnAgent(config: AgentConfig): Promise<SpawnResult> {
    let container: Docker.Container | undefined;
    let containerId = '';
    
    try {
        container = await getOrCreateCubicle(config);
        const currentContainerId = container.id;
        containerId = currentContainerId;

        return await new Promise((resolve, reject) => {
            let output = '';
            let approvalLogId: number | null = null;
            
            const timeout = setTimeout(async () => {
                try {
                    if (container) await container.stop();
                    await updateContainerLastActive(currentContainerId);
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

                stream.on('end', async () => {
                    clearTimeout(timeout);
                    cleanup();
                    await updateContainerLastActive(currentContainerId);
                    const lines = output.split('\n').filter((l: string) => l.trim() && !l.startsWith('{'));
                    resolve({
                        containerId: currentContainerId,
                        output: lines.join('\n').trim() || 'No response from agent'
                    });
                });

                stream.on('error', async (err: Error) => {
                    clearTimeout(timeout);
                    cleanup();
                    await updateContainerLastActive(currentContainerId);
                    reject(err);
                });
            });

            function cleanup() {}
        });
    } catch (error: any) {
        console.error('Docker Spawn Error:', error);
        throw new Error(`Failed to spawn cubicle: ${error.message}`);
    }
}

export async function stopCubicle(containerId: string): Promise<void> {
    try {
        const container = docker.getContainer(containerId);
        await container.stop();
        console.log(`[Cubicle] Stopped container ${containerId.slice(0, 12)}`);
    } catch (err) {
        console.error('Failed to stop container:', err);
    }
}

export async function removeCubicle(containerId: string): Promise<void> {
    try {
        const container = docker.getContainer(containerId);
        await container.remove({ force: true });
        console.log(`[Cubicle] Removed container ${containerId.slice(0, 12)}`);
    } catch (err) {
        console.error('Failed to remove container:', err);
    }
}

export async function hibernateIdleContainers(idleThresholdMinutes: number = 30): Promise<number> {
    const containers = await docker.listContainers({ all: false });
    const now = Date.now();
    let hibernatedCount = 0;
    
    for (const containerInfo of containers) {
        const labels = containerInfo.Labels || {};
        
        if (!labels[LABELS.AGENT_ID]) continue;
        
        const lastActive = labels[LABELS.LAST_ACTIVE];
        if (!lastActive) continue;
        
        const lastActiveTime = new Date(lastActive).getTime();
        const idleMinutes = (now - lastActiveTime) / (1000 * 60);
        
        if (idleMinutes > idleThresholdMinutes) {
            try {
                await stopCubicle(containerInfo.Id);
                hibernatedCount++;
            } catch (err) {
                console.error(`Failed to hibernate ${containerInfo.Id.slice(0, 12)}:`, err);
            }
        }
    }
    
    return hibernatedCount;
}

export async function cleanupOldContainers(maxAgeHours: number = 48): Promise<number> {
    const containers = await docker.listContainers({ all: true });
    const now = Date.now();
    let removedCount = 0;
    
    for (const containerInfo of containers) {
        const labels = containerInfo.Labels || {};
        
        if (!labels[LABELS.AGENT_ID]) continue;
        
        const createdAt = labels[LABELS.CREATED_AT];
        if (!createdAt) continue;
        
        const createdTime = new Date(createdAt).getTime();
        const ageHours = (now - createdTime) / (1000 * 60 * 60);
        
        if (ageHours > maxAgeHours) {
            try {
                await removeCubicle(containerInfo.Id);
                removedCount++;
            } catch (err) {
                console.error(`Failed to remove ${containerInfo.Id.slice(0, 12)}:`, err);
            }
        }
    }
    
    return removedCount;
}

export async function getCubicleStatus(agentId: number, userId: number): Promise<{ status: string; containerId?: string } | null> {
    const container = await findContainerByLabels(agentId, userId);
    if (!container) return null;
    
    return {
        status: container.state,
        containerId: container.id
    };
}

export async function listContainers(): Promise<Docker.ContainerInfo[]> {
    const containers = await docker.listContainers({ all: true });
    return containers.filter(c => 
        c.Image && (c.Image.startsWith('hermit/') || c.Image.startsWith('hermit-crab')) ||
        (c.Labels && c.Labels[LABELS.AGENT_ID])
    );
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
