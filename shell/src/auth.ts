import { isAllowed } from './db';
import * as fs from 'fs';
import * as path from 'path';

export async function validateUser(userId: number): Promise<boolean> {
    return await isAllowed(userId);
}

interface Limits {
    maxTokensPerRequest: number;
    maxTokensPerDay: number;
    maxHistoryMessages: number;
}

let limits: Limits | null = null;

export function getLimits(): Limits {
    if (limits) return limits;
    
    const configPath = path.join(__dirname, '../../config/limits.json');
    try {
        const data = fs.readFileSync(configPath, 'utf-8');
        limits = JSON.parse(data);
    } catch {
        limits = {
            maxTokensPerRequest: 1000,
            maxTokensPerDay: 10000,
            maxHistoryMessages: 10
        };
    }
    return limits!;
}
