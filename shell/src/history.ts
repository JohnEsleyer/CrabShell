import * as fs from 'fs';
import * as path from 'path';

interface Message {
  role: string;
  content: string;
}

const HISTORY_DIR = path.join(__dirname, '../../data');

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

export function loadHistory(userId: number): Message[] {
  ensureHistoryDir();
  const historyPath = path.join(HISTORY_DIR, `history_${userId}.json`);
  
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  
  try {
    const data = fs.readFileSync(historyPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveHistory(userId: number, history: Message[]): void {
  ensureHistoryDir();
  const historyPath = path.join(HISTORY_DIR, `history_${userId}.json`);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}
