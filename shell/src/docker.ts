import Docker from 'dockerode';
import * as fs from 'fs';
import * as path from 'path';

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
}

interface SpawnResult {
    containerId: string;
    output: string;
}

export async function spawnAgent(config: AgentConfig): Promise<SpawnResult> {
    const imageName = config.dockerImage || 'hermit/base:latest';
    
    const historyJson = JSON.stringify(config.history);
    
    const envVars = [
        `USER_MSG=${config.userMessage}`,
        `HISTORY=${Buffer.from(historyJson).toString('base64')}`,
        `MAX_TOKENS=${config.maxTokens}`,
        `AGENT_NAME=${config.agentName}`,
        `AGENT_ROLE=${config.agentRole}`,
        `DOCKER_IMAGE=${config.dockerImage}`,
    ];

    if (process.env.OPENAI_API_KEY) {
        envVars.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
    }
    if (process.env.OPENROUTER_API_KEY) {
        envVars.push(`OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY}`);
    }

    const container = await docker.createContainer({
        Image: imageName,
        Env: envVars,
        Cmd: ['crab'],
        HostConfig: {
            AutoRemove: true,
            Memory: 512 * 1024 * 1024,
            CpuQuota: 100000,
            PidsLimit: 100,
            NetworkMode: 'bridge',
        },
        AttachStdout: true,
        AttachStderr: true,
        Tty: false
    });

    await container.start();

    const logs = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 500
    });

    return new Promise((resolve, reject) => {
        let output = '';
        
        const stream = typeof logs === 'string' ? null : logs;
        
        const timeout = setTimeout(async () => {
            try {
                await container.stop();
            } catch {}
        }, 60000);

        if (stream) {
            stream.on('data', (chunk: Buffer) => {
                output += chunk.toString();
            });
            
            stream.on('end', () => {
                clearTimeout(timeout);
                const lines = output.split('\n').filter((l: string) => l.trim() && !l.startsWith('{'));
                const result = lines.join('\n').trim();
                resolve({
                    containerId: container.id,
                    output: result || 'No response from agent'
                });
            });
            
            stream.on('error', (err: Error) => {
                clearTimeout(timeout);
                reject(err);
            });
        } else {
            clearTimeout(timeout);
            const lines = output.split('\n').filter((l: string) => l.trim() && !l.startsWith('{'));
            resolve({
                containerId: container.id,
                output: lines.join('\n').trim() || 'No response from agent'
            });
        }
    });
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
