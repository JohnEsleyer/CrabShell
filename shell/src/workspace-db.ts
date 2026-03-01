import { createClient, Client } from '@libsql/client';
import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE_DIR = path.join(__dirname, '../../data/workspaces');

function getWorkspacePath(agentId: number, userId: number): string {
    return path.join(WORKSPACE_DIR, `${agentId}_${userId}`, 'data');
}

function getCalendarDbPath(agentId: number, userId: number): string {
    return path.join(getWorkspacePath(agentId, userId), 'calendar.db');
}

function getRagDbPath(agentId: number, userId: number): string {
    return path.join(getWorkspacePath(agentId, userId), 'rag.db');
}

interface CalendarEvent {
    id: number;
    agent_id: number;
    title: string;
    prompt: string;
    start_time: string;
    end_time: string | null;
    target_user_id: number;
    color: string | null;
    symbol: string | null;
    status: string;
    last_error: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
}

interface RagMemory {
    id: number;
    agent_id: number;
    user_id: number;
    content: string;
    embedding: string;
    created_at: string;
}

function ensureDataDir(agentId: number, userId: number): void {
    const dataDir = getWorkspacePath(agentId, userId);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function getCalendarClient(agentId: number, userId: number): Client {
    ensureDataDir(agentId, userId);
    const dbPath = getCalendarDbPath(agentId, userId);
    return createClient({ url: `file:${dbPath}` });
}

function getRagClient(agentId: number, userId: number): Client {
    ensureDataDir(agentId, userId);
    const dbPath = getRagDbPath(agentId, userId);
    return createClient({ url: `file:${dbPath}` });
}

export async function initWorkspaceDatabases(agentId: number, userId: number = 0): Promise<void> {
    const calendarClient = getCalendarClient(agentId, userId);
    const ragClient = getRagClient(agentId, userId);

    await calendarClient.execute(`
        CREATE TABLE IF NOT EXISTS calendar_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            target_user_id INTEGER NOT NULL,
            color TEXT,
            symbol TEXT,
            status TEXT DEFAULT 'scheduled',
            last_error TEXT,
            started_at TEXT,
            completed_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await ragClient.execute(`
        CREATE TABLE IF NOT EXISTS rag_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            embedding TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

export async function createCalendarEvent(event: {
    agent_id: number;
    title: string;
    prompt: string;
    start_time: string;
    end_time?: string | null;
    target_user_id: number;
    color?: string | null;
    symbol?: string | null;
}, userId: number = 0): Promise<number> {
    const client = getCalendarClient(event.agent_id, userId);
    const rs = await client.execute({
        sql: `INSERT INTO calendar_events (agent_id, title, prompt, start_time, end_time, target_user_id, color, symbol, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
        args: [event.agent_id, event.title, event.prompt, event.start_time, event.end_time || null, event.target_user_id, event.color || null, event.symbol || null]
    });
    return Number(rs.lastInsertRowid);
}

export async function getCalendarEvents(agentId: number, userId: number = 0): Promise<CalendarEvent[]> {
    const client = getCalendarClient(agentId, userId);
    const rs = await client.execute({
        sql: 'SELECT * FROM calendar_events ORDER BY start_time ASC',
        args: []
    });
    return rs.rows as unknown as CalendarEvent[];
}

export async function getUpcomingCalendarEvents(agentId: number, userId: number = 0, limit: number = 10): Promise<CalendarEvent[]> {
    const client = getCalendarClient(agentId, userId);
    const now = new Date().toISOString();
    const rs = await client.execute({
        sql: `SELECT * FROM calendar_events 
              WHERE start_time >= ? 
              ORDER BY start_time ASC LIMIT ?`,
        args: [now, limit]
    });
    return rs.rows as unknown as CalendarEvent[];
}

export async function getCalendarEventById(id: number, agentId: number, userId: number = 0): Promise<CalendarEvent | undefined> {
    const client = getCalendarClient(agentId, userId);
    const rs = await client.execute({
        sql: 'SELECT * FROM calendar_events WHERE id = ?',
        args: [id]
    });
    if (rs.rows.length > 0) {
        return rs.rows[0] as unknown as CalendarEvent;
    }
    return undefined;
}

export async function updateCalendarEvent(id: number, agentId: number, updates: Partial<CalendarEvent>, userId: number = 0): Promise<void> {
    const client = getCalendarClient(agentId, userId);
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
    if (updates.start_time !== undefined) { fields.push('start_time = ?'); values.push(updates.start_time); }
    if (updates.end_time !== undefined) { fields.push('end_time = ?'); values.push(updates.end_time); }
    if (updates.target_user_id !== undefined) { fields.push('target_user_id = ?'); values.push(updates.target_user_id); }
    if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
    if (updates.symbol !== undefined) { fields.push('symbol = ?'); values.push(updates.symbol); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.last_error !== undefined) { fields.push('last_error = ?'); values.push(updates.last_error); }
    if (updates.started_at !== undefined) { fields.push('started_at = ?'); values.push(updates.started_at); }
    if (updates.completed_at !== undefined) { fields.push('completed_at = ?'); values.push(updates.completed_at); }

    if (!fields.length) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await client.execute({
        sql: `UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`,
        args: values
    });
}

export async function deleteCalendarEvent(id: number, agentId: number, userId: number = 0): Promise<void> {
    const client = getCalendarClient(agentId, userId);
    await client.execute({ sql: 'DELETE FROM calendar_events WHERE id = ?', args: [id] });
}

export async function claimDueCalendarEvents(agentId: number, userId: number = 0): Promise<CalendarEvent[]> {
    const client = getCalendarClient(agentId, userId);
    const now = new Date().toISOString();
    const rs = await client.execute({
        sql: `SELECT * FROM calendar_events
              WHERE status = 'scheduled'
                AND start_time <= ?
                AND (end_time IS NULL OR end_time >= ?)
              ORDER BY start_time ASC`,
        args: [now, now]
    });

    const due = rs.rows as unknown as CalendarEvent[];
    const claimed: CalendarEvent[] = [];

    for (const event of due) {
        const update = await client.execute({
            sql: `UPDATE calendar_events
                  SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ? AND status = 'scheduled'`,
            args: [event.id]
        });

        if (Number(update.rowsAffected || 0) > 0) {
            claimed.push({ ...event, status: 'running' });
        }
    }

    return claimed;
}

export async function storeRagMemory(memory: {
    agent_id: number;
    user_id: number;
    content: string;
    embedding?: string;
}): Promise<number> {
    const client = getRagClient(memory.agent_id, memory.user_id);
    const rs = await client.execute({
        sql: 'INSERT INTO rag_memories (agent_id, user_id, content, embedding) VALUES (?, ?, ?, ?)',
        args: [memory.agent_id, memory.user_id, memory.content, memory.embedding || null]
    });
    return Number(rs.lastInsertRowid);
}

export async function getRagMemories(agentId: number, userId: number, limit: number = 20): Promise<RagMemory[]> {
    const client = getRagClient(agentId, userId);
    const rs = await client.execute({
        sql: 'SELECT * FROM rag_memories WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
        args: [agentId, userId, limit]
    });
    return rs.rows as unknown as RagMemory[];
}

export async function searchRagMemories(agentId: number, userId: number, query: string, limit: number = 5): Promise<RagMemory[]> {
    const client = getRagClient(agentId, userId);
    const rs = await client.execute({
        sql: `SELECT * FROM rag_memories 
              WHERE agent_id = ? AND user_id = ?
              ORDER BY created_at DESC LIMIT ?`,
        args: [agentId, userId, limit]
    });
    return rs.rows as unknown as RagMemory[];
}

export async function deleteRagMemory(id: number, agentId: number, userId: number): Promise<void> {
    const client = getRagClient(agentId, userId);
    await client.execute({ sql: 'DELETE FROM rag_memories WHERE id = ?', args: [id] });
}

export async function clearRagMemories(agentId: number, userId: number): Promise<void> {
    const client = getRagClient(agentId, userId);
    await client.execute({ sql: 'DELETE FROM rag_memories WHERE agent_id = ? AND user_id = ?', args: [agentId, userId] });
}

export function getWorkspaceDataDir(agentId: number, userId: number): string {
    return getWorkspacePath(agentId, userId);
}

export function workspaceDataExists(agentId: number, userId: number): boolean {
    const dataDir = getWorkspacePath(agentId, userId);
    return fs.existsSync(dataDir);
}
