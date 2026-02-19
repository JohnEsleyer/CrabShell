import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let db: Database | null = null;
const DB_PATH = path.join(__dirname, '../../data/db/hermit.db');

async function getDatabase(): Promise<Database> {
    if (db) return db;
    
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
        initTables(db);
    }
    
    return db;
}

function initTables(database: Database): void {
    database.run(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            role TEXT,
            telegram_token TEXT UNIQUE,
            system_prompt TEXT,
            docker_image TEXT DEFAULT 'hermit/base',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    database.run(`
        CREATE TABLE IF NOT EXISTS budgets (
            agent_id INTEGER PRIMARY KEY,
            daily_limit_usd REAL DEFAULT 1.00,
            current_spend_usd REAL DEFAULT 0.00,
            last_reset_date TEXT DEFAULT (date('now')),
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
    `);
    
    database.run(`
        CREATE TABLE IF NOT EXISTS allowlist (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    database.run(`
        CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            initiator_agent_id INTEGER,
            participant_agent_id INTEGER,
            topic TEXT,
            transcript TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    database.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);
    
    database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('default_provider', 'openrouter')`);
    database.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('default_model', 'anthropic/claude-3-haiku')`);
    
    saveDatabase();
}

function saveDatabase(): void {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

export interface Agent {
    id: number;
    name: string;
    role: string;
    telegram_token: string;
    system_prompt: string;
    docker_image: string;
    is_active: number;
    created_at: string;
}

export interface Budget {
    agent_id: number;
    daily_limit_usd: number;
    current_spend_usd: number;
    last_reset_date: string;
}

export interface AllowlistUser {
    user_id: number;
    username: string;
    first_name: string;
    added_at: string;
}

function rowToObject<T>(columns: string[], values: any[]): T {
    const obj: any = {};
    columns.forEach((col, i) => {
        obj[col] = values[i];
    });
    return obj as T;
}

export async function getAllAgents(): Promise<Agent[]> {
    const database = await getDatabase();
    const stmt = database.prepare('SELECT * FROM agents ORDER BY created_at DESC');
    const results: Agent[] = [];
    while (stmt.step()) {
        results.push(rowToObject<Agent>(stmt.getColumnNames(), stmt.get()));
    }
    stmt.free();
    return results;
}

export async function getAgentByToken(token: string): Promise<Agent | undefined> {
    const database = await getDatabase();
    const stmt = database.prepare('SELECT * FROM agents WHERE telegram_token = ? AND is_active = 1');
    stmt.bind([token]);
    if (stmt.step()) {
        const agent = rowToObject<Agent>(stmt.getColumnNames(), stmt.get());
        stmt.free();
        return agent;
    }
    stmt.free();
    return undefined;
}

export async function createAgent(agent: Omit<Agent, 'id' | 'created_at'>): Promise<number> {
    const database = await getDatabase();
    database.run(
        `INSERT INTO agents (name, role, telegram_token, system_prompt, docker_image, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
        [agent.name, agent.role, agent.telegram_token, agent.system_prompt, agent.docker_image, agent.is_active]
    );
    
    const lastId = database.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
    database.run('INSERT INTO budgets (agent_id, daily_limit_usd) VALUES (?, 1.00)', [lastId]);
    
    saveDatabase();
    return lastId;
}

export async function updateAgent(id: number, updates: Partial<Agent>): Promise<void> {
    const database = await getDatabase();
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.role !== undefined) { fields.push('role = ?'); values.push(updates.role); }
    if (updates.system_prompt !== undefined) { fields.push('system_prompt = ?'); values.push(updates.system_prompt); }
    if (updates.docker_image !== undefined) { fields.push('docker_image = ?'); values.push(updates.docker_image); }
    if (updates.is_active !== undefined) { fields.push('is_active = ?'); values.push(updates.is_active); }
    
    if (fields.length > 0) {
        values.push(id);
        database.run(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`, values);
        saveDatabase();
    }
}

export async function deleteAgent(id: number): Promise<void> {
    const database = await getDatabase();
    database.run('DELETE FROM budgets WHERE agent_id = ?', [id]);
    database.run('DELETE FROM agents WHERE id = ?', [id]);
    saveDatabase();
}

export async function getBudget(agentId: number): Promise<Budget | undefined> {
    const database = await getDatabase();
    const today = new Date().toISOString().split('T')[0];
    
    const stmt = database.prepare('SELECT * FROM budgets WHERE agent_id = ?');
    stmt.bind([agentId]);
    
    if (stmt.step()) {
        const budget = rowToObject<Budget>(stmt.getColumnNames(), stmt.get());
        stmt.free();
        
        if (budget.last_reset_date !== today) {
            database.run('UPDATE budgets SET current_spend_usd = 0, last_reset_date = ? WHERE agent_id = ?', [today, agentId]);
            budget.current_spend_usd = 0;
            budget.last_reset_date = today;
            saveDatabase();
        }
        
        return budget;
    }
    stmt.free();
    return undefined;
}

export async function updateSpend(agentId: number, amount: number): Promise<void> {
    const database = await getDatabase();
    database.run('UPDATE budgets SET current_spend_usd = current_spend_usd + ? WHERE agent_id = ?', [amount, agentId]);
    saveDatabase();
}

export async function canSpend(agentId: number): Promise<boolean> {
    const budget = await getBudget(agentId);
    if (!budget) return false;
    return budget.current_spend_usd < budget.daily_limit_usd;
}

export async function getAllowlist(): Promise<AllowlistUser[]> {
    const database = await getDatabase();
    const stmt = database.prepare('SELECT * FROM allowlist');
    const results: AllowlistUser[] = [];
    while (stmt.step()) {
        results.push(rowToObject<AllowlistUser>(stmt.getColumnNames(), stmt.get()));
    }
    stmt.free();
    return results;
}

export async function addToAllowlist(userId: number, username?: string, firstName?: string): Promise<void> {
    const database = await getDatabase();
    database.run('INSERT OR IGNORE INTO allowlist (user_id, username, first_name) VALUES (?, ?, ?)', 
        [userId, username || null, firstName || null]);
    saveDatabase();
}

export async function removeFromAllowlist(userId: number): Promise<void> {
    const database = await getDatabase();
    database.run('DELETE FROM allowlist WHERE user_id = ?', [userId]);
    saveDatabase();
}

export async function isAllowed(userId: number): Promise<boolean> {
    const database = await getDatabase();
    const stmt = database.prepare('SELECT 1 FROM allowlist WHERE user_id = ?');
    stmt.bind([userId]);
    const result = stmt.step();
    stmt.free();
    return result;
}

export async function getSetting(key: string): Promise<string | undefined> {
    const database = await getDatabase();
    const stmt = database.prepare('SELECT value FROM settings WHERE key = ?');
    stmt.bind([key]);
    if (stmt.step()) {
        const value = stmt.get()[0] as string;
        stmt.free();
        return value;
    }
    stmt.free();
    return undefined;
}

export async function setSetting(key: string, value: string): Promise<void> {
    const database = await getDatabase();
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    saveDatabase();
}

export async function getAllBudgets(): Promise<(Budget & { agent_name: string })[]> {
    const database = await getDatabase();
    const stmt = database.prepare(`
        SELECT b.*, a.name as agent_name 
        FROM budgets b 
        JOIN agents a ON b.agent_id = a.id
    `);
    const results: (Budget & { agent_name: string })[] = [];
    while (stmt.step()) {
        results.push(rowToObject<Budget & { agent_name: string }>(stmt.getColumnNames(), stmt.get()));
    }
    stmt.free();
    return results;
}

export async function initDb(): Promise<void> {
    await getDatabase();
}
