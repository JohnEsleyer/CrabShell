# HermitClaw OS

"Intelligence in a Disposable Shell" - A secure, multi-agent AI orchestration platform where each agent lives in its own Docker "cubicle."

## Overview

HermitClaw OS is an evolution from a single Telegram bot to a **Secure Agentic Operating System**. Each AI agent runs in an ephemeral Docker container ("Cubicle") with its own Telegram bot identity, role, and budget.

### Key Features

- **Multi-Agent Support**: Create multiple AI agents with different personalities, roles, and Docker images
- **Per-Agent Budgeting**: Track and limit spending for each agent individually
- **Web Dashboard**: Manage agents, users, and settings via a built-in GUI
- **Cubicle Security**: Each agent is isolated in its own container - complete freedom inside, steel walls outside
- **Ephemeral Execution**: Agents only exist during task execution, then vanish
- **Tool-Ready**: Agents can execute commands (curl, python, nmap, etc.) and see real results

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     HermitClaw OS                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Web Dashboard (Port 3000)              │   │
│  │  - Agent Management  - Budget Tracking  - Settings  │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Node.js Shell (Orchestrator)            │   │
│  │  - SQLite DB  - Docker Management  - Webhooks       │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Agent A      │   │  Agent B      │   │  Agent C      │
│  "Sherlock"   │   │  "DevOps"    │   │  "Researcher" │
│  hermit/base  │   │ hermit/python │   │ hermit/netsec │
│  Container     │   │  Container    │   │  Container    │
└───────────────┘   └───────────────┘   └───────────────┘
```

## Directory Structure

```
hermitclaw/
├── install.sh              # Automated installer
├── shell/                  # Node.js orchestrator
│   ├── src/
│   │   ├── server.ts     # Fastify server + webhook handler
│   │   ├── db.ts         # SQLite database (sql.js)
│   │   ├── docker.ts     # Docker container orchestration
│   │   ├── telegram.ts   # Telegram bot handler
│   │   └── auth.ts       # User validation
│   ├── dashboard/         # Web GUI
│   └── package.json
├── crab/                   # Rust AI agent
│   ├── src/
│   │   ├── main.rs       # Entry point + agent loop
│   │   ├── llm.rs        # OpenAI/OpenRouter client
│   │   └── tools.rs      # Command execution
│   └── Dockerfile
├── data/db/               # SQLite database (created at runtime)
└── config/                # Configuration files
```

## Quick Start

### 1. Run the Installer

```bash
chmod +x install.sh
./install.sh
```

### 2. Configure Environment

Edit `shell/.env`:
```bash
OPENROUTER_API_KEY=your_openrouter_key_here
OPENAI_API_KEY=your_openai_key_here  # Optional
MODEL=anthropic/claude-3-haiku
```

### 3. Start the System

```bash
cd shell && npm start
```

### 4. Access the Dashboard

Open http://localhost:3000/dashboard/ in your browser

### 5. Create Your First Agent

1. Go to Dashboard → Agents
2. Click "+ New Agent"
3. Fill in:
   - **Name**: e.g., "Sherlock"
   - **Role**: e.g., "Security Researcher"
   - **Telegram Token**: Get from @BotFather
   - **Docker Image**: hermit/base, hermit/python, or hermit/netsec

### 6. Add Users to Allowlist

Dashboard → Allowlist → Add Telegram User ID

### 7. Set Up Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<AGENT_TOKEN>/setWebhook" \
  -d "url=https://your-public-url/webhook/<AGENT_TOKEN>"
```

## Agent Images

| Image | Tools | Use Case |
|-------|-------|----------|
| `hermit/base:latest` | curl, jq, sed, awk, bash | General tasks |
| `hermit/python:latest` | python3, pandas, numpy | Data analysis |
| `hermit/netsec:latest` | nmap, dig, openssl | Security research |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `OPENROUTER_API_KEY` | OpenRouter API key | Required |
| `OPENAI_API_KEY` | OpenAI API key (optional) | - |
| `MODEL` | Default model | anthropic/claude-3-haiku |

### Database Schema

- **agents**: id, name, role, telegram_token, system_prompt, docker_image, is_active
- **budgets**: agent_id, daily_limit_usd, current_spend_usd, last_reset_date
- **allowlist**: user_id, username, first_name
- **settings**: key, value
- **meetings**: id, initiator_agent_id, participant_agent_id, topic, transcript

## Agent Tool Loop

The Rust agent supports autonomous tool execution:

```
You: "Check if example.com is up"

Agent: I'll check that for you.
ACTION: EXECUTE
COMMAND: curl -s -o /dev/null -w "%{http_code}" https://example.com

[System returns: 200]

Agent: example.com is responding with HTTP 200 OK.
```

## Security

- **Cubicle Isolation**: Each agent runs in its own Docker container
- **Resource Limits**: 512MB RAM, 1 CPU, 100 process limit
- **Auto-Remove**: Containers deleted after task completion
- **Network Isolation**: Agents can access internet but not host system
- **Budget Guards**: Per-agent spending limits prevent runaway costs

## Future Features

### Agent Meetings (Planned)
Agents can collaborate by calling each other:
- Manager agent spawns Researcher agent
- Researcher completes sub-task and returns result
- Manager incorporates result and completes main task

### Dead-Drop History (Planned)
Encrypted conversation history that only the agent can decrypt in RAM.

## Troubleshooting

### Docker permission denied
```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Build errors
```bash
# Install build dependencies
sudo apt install build-essential python3
```

## License

MIT
