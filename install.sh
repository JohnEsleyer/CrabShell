#!/bin/bash
set -e

echo "🐚 HermitClaw OS - Installing Your Private Agent Workforce"

check_command() {
    if ! command -v $1 &> /dev/null; then
        echo "❌ $1 is required but not installed. Aborting."
        exit 1
    fi
}

echo "📋 Checking dependencies..."
check_command docker
check_command node
check_command npm
check_command sqlite3

echo "📁 Setting up directories..."
mkdir -p data/db data/history config/images
mkdir -p shell/uploads dashboard/dist

echo "📝 Creating environment file..."
if [ ! -f shell/.env ]; then
    cp shell/.env.example shell/.env
    echo "⚠️  Please edit shell/.env and add your API keys"
fi

echo "🔐 Setting up SQLite database..."
sqlite3 data/db/hermit.db << 'EOF'
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    telegram_token TEXT UNIQUE,
    system_prompt TEXT,
    docker_image TEXT DEFAULT 'hermit/base',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS budgets (
    agent_id INTEGER PRIMARY KEY,
    daily_limit_usd REAL DEFAULT 1.00,
    current_spend_usd REAL DEFAULT 0.00,
    last_reset_date TEXT DEFAULT (date('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS allowlist (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    initiator_agent_id INTEGER,
    participant_agent_id INTEGER,
    topic TEXT,
    transcript TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('default_provider', 'openrouter');
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_model', 'anthropic/claude-3-haiku');
EOF
echo "✅ Database initialized"

echo "🦀 Building base Docker images..."
docker build -t hermit/base:latest -f - . << 'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    sed \
    gawk \
    bash \
    coreutils \
    iputils-ping \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["/bin/bash"]
EOF

docker build -t hermit/python:latest -f - . << 'EOF'
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir requests pandas numpy
WORKDIR /workspace
CMD ["python"]
EOF

docker build -t hermit/netsec:latest -f - . << 'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    nmap \
    iputils-ping \
    dnsutils \
    net-tools \
    openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["/bin/bash"]
EOF

echo "🔨 Building HermitClaw Crab Agent..."
docker build -t hermit-crab:latest crab/

echo "📦 Installing Node.js dependencies..."
cd shell && npm install
npm run build

echo "🌐 Building Dashboard..."
cd ../dashboard && npm install
npm run build

echo ""
echo "✅ INSTALLATION COMPLETE!"
echo "========================================"
echo "🌍 Dashboard: http://localhost:3000"
echo "📱 Telegram Bots: Managed via Dashboard"
echo ""
echo "Next steps:"
echo "1. Edit shell/.env with your API keys"
echo "2. Add your Telegram ID to config/allowlist.json"
echo "3. Start: cd shell && npm start"
echo "========================================"
