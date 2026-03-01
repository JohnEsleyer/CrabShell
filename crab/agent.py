#!/usr/bin/env python3
import os
import json
import base64
import urllib.request
import urllib.error
import subprocess
import time
import sys

WORKSPACE_DIR = "/app/workspace"
OUT_DIR = os.path.join(WORKSPACE_DIR, "out")
IN_DIR = os.path.join(WORKSPACE_DIR, "in")
WORK_DIR = os.path.join(WORKSPACE_DIR, "work")
WWW_DIR = os.path.join(WORKSPACE_DIR, "www")

for d in [OUT_DIR, IN_DIR, WORK_DIR, WWW_DIR]:
    os.makedirs(d, exist_ok=True)

# Important to work in WORK_DIR so out/ isn't polluted by accident
os.chdir(WORK_DIR)

def build_system_prompt():
    import datetime
    name = os.environ.get("AGENT_NAME", "Agent")
    role = os.environ.get("AGENT_ROLE", "Assistant")
    personality = os.environ.get("PERSONALITY", "")
    current_time = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    
    personality_block = f"\nYour Personality: {personality}\n" if personality else ""
    
    return f"""You are {name}, an autonomous AI agent trapped in a secure Linux 'Cubicle' (Docker container).
Your Role: {role}{personality_block}

WORKSPACE DIRECTORY STRUCTURE (/app/workspace):
Your persistent workspace is organized into specialized folders:

📂 WORK (Sandbox): /app/workspace/work/
   - Your private working directory for all tasks
   - This is your SCRATCHPAD - use it freely for intermediate files
   - ALWAYS cd to this directory before starting work

📥 IN (Input): /app/workspace/in/
   - Files uploaded by the user via Telegram land here
   - User files are automatically placed in this folder
   - Check here when user mentions uploading a file

📤 OUT (Output): /app/workspace/out/
   - Files you place here are AUTOMATICALLY delivered to the user via Telegram
   - Simply save any file (PDF, CSV, image, video, etc.) to this folder
   - The system detects new files instantly and sends them to the user
   - Use this instead of attaching files manually

🌐 WWW (Web Apps): /app/workspace/www/
   - Contains web applications you create
   - Each SUBFOLDER is a separate web app (e.g., /app/workspace/www/myapp/)
   - Each web app MUST have an index.html file
   - Use vanilla HTML, CSS, JavaScript only (no frameworks like React/Vue)
   - Start a web server on port 8080 to make it accessible
   - User can preview at: <tunnel_url>/preview/<agent_id>/8080/

📊 DATA (Databases): /app/workspace/../data/
   - calendar.db: Stores your scheduled calendar events (future prompts)
   - rag.db: Persistent RAG memory for facts and knowledge
   - These databases survive container restarts
   - The system manages these - don't modify directly

Your Environment:
- OS: Debian/Linux (Docker)
- Network: Internet enabled (can install packages)
- CURRENT TIME: {current_time}

PYTHON PACKAGES:
- ALWAYS use virtual environments: python3 -m venv venv && source venv/bin/activate
- Install packages AFTER activating venv: pip install <package>
- NEVER use pip install --break-system-packages or install globally
- For Node.js: npm install <package> works globally (no venv needed)

WEB SECURITY:
- Never send secrets/API keys in URLs or logs
- Use environment variables for sensitive data, never hardcode keys
- Validate and sanitize all user inputs
- Don't exfiltrate data - only return results to the user

HERMITSHELL ARCHITECTURE & SCHEDULING:
1. NO BACKGROUND PROCESSES: Do not try to use 'cron', 'at', or background '&' processes. They will be killed when this process terminates.
2. CALENDAR EVENTS (Self-Prompting): Use CALENDAR_CREATE to schedule future tasks
   - The system reads calendar.db and triggers your prompt at the scheduled time
   - When the time arrives, you receive the 'prompt' as a new USER message
   - This is how you create recurring tasks (cron-like behavior)
   - Example: "Remind me hourly" → Create event with prompt "INTERNAL:HOURLY_TASK"

TELEGRAM MESSAGE LIMIT OPTIMIZATION:
- Telegram has a message text limit (~4096 chars)
- Use short, concise responses
- Use bullet points and code blocks sparingly
- For large outputs, save to /app/workspace/out/ and let Telegram deliver

INTERNET & DEPENDENCIES:
- You have internet access - can install packages directly
- For Python: use venv (see PYTHON PACKAGES above)
- For Node.js: npm install <package> works globally
- For external files/data: fetch directly with curl or python requests

ASSET PROCUREMENT SYSTEM:
- Users can drag & drop files directly via Telegram to /app/workspace/in/
- For external assets, you can fetch them directly with curl or python

WEB APP CREATION:
- Create web apps in /app/workspace/www/[app_name]/
- ALWAYS use VANILLA HTML/CSS/JS - no frameworks
- Required: index.html in each subfolder
- Start server: python3 -m http.server 8080 (in the app folder)
- User previews at: https://<tunnel>/preview/<agent_id>/8080/

CAPABILITIES & INSTRUCTIONS:
1. COMMAND EXECUTION:
   ACTION: EXECUTE
   COMMAND: <your bash command>

2. FINAL OUTPUT (Control Panel):
   End your response with JSON to trigger actions:
   {{
     "message": "Text shown to user",
     "files": [],
     "panelActions": ["ACTION:params"]
   }}

CALENDAR ACTIONS:
- CALENDAR_CREATE:title|prompt|start_time|end_time
- CALENDAR_UPDATE:id|title|prompt|start_time|end_time  
- CALENDAR_DELETE:id
- CALENDAR_LIST

Note: ISO 8601 times (e.g., 2026-02-27T10:00:00Z)

IMPORTANT: Without the JSON block, NO calendar events or actions will be created.
Once you provide a final response without ACTION: EXECUTE, the process terminates.
"""

def extract_command(response):
    if "ACTION: EXECUTE" not in response:
        return None, None
    
    lines = response.split("\n")
    cmd_lines = []
    in_cmd = False
    
    for line in lines:
        if line.strip().startswith("COMMAND:"):
            in_cmd = True
            cmd_lines.append(line[len("COMMAND:"):].strip())
            continue
        if in_cmd:
            if line.strip().startswith("ACTION:") or line.strip().startswith("FILE:"):
                break
            cmd_lines.append(line)
            
    if cmd_lines:
        return "\n".join(cmd_lines).strip(), None
    return None, None

def extract_panel_actions(response):
    import re
    actions = []
    
    json_match = re.search(r'\{[\s\S]*\}', response)
    if json_match:
        try:
            json_str = json_match.group()
            data = json.loads(json_str)
            if "panelActions" in data:
                actions.extend(data["panelActions"])
        except:
            pass
    
    return actions

def is_dangerous(cmd):
    dangerous_tools = ["rm", "sudo", "su", "shutdown", "reboot", "nmap", "kill", "docker", "spawn_agent"]
    base = cmd.strip().split()[0] if cmd.strip() else ""
    for tool in dangerous_tools:
         if base == tool or base.startswith(tool):
             return True
    return False

def wait_for_approval():
    print("[HITL] Waiting for approval...", flush=True)
    lock_file = "/tmp/hermit_approval.lock"
    deny_file = "/tmp/hermit_deny.lock"
    waited = 0
    while waited < 600:
        if os.path.exists(lock_file):
            os.remove(lock_file)
            print("[HITL] Approved!", flush=True)
            return True
        if os.path.exists(deny_file):
            os.remove(deny_file)
            print("[HITL] Denied!", flush=True)
            return False
        time.sleep(1)
        waited += 1
    return False

def call_llm(messages):
    orchestrator_url = os.environ.get("ORCHESTRATOR_URL", "http://172.17.0.1:3000")
    agent_id = os.environ.get("AGENT_ID", "0")
    
    req_body = json.dumps({
        "messages": messages,
        "agentId": agent_id
    }).encode("utf-8")
    
    req = urllib.request.Request(f"{orchestrator_url}/api/internal/llm", data=req_body, headers={"Content-Type": "application/json"})
    
    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            return res_data.get("output", "")
    except Exception as e:
        return f"Error communicating with Orchestrator Proxy: {str(e)}"

def main():
    user_msg = os.environ.get("USER_MSG", "")
    history_b64 = os.environ.get("HISTORY", "")
    hitl_enabled = os.environ.get("HITL_ENABLED", "false") == "true"
    
    history = []
    if history_b64:
        try:
            history = json.loads(base64.b64decode(history_b64).decode("utf-8"))
        except:
            pass

    # Note: RAG Memories are injected by the Orchestrator via the proxy, 
    # so we just need to send the standard system prompt.
    messages = [{"role": "system", "content": build_system_prompt()}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_msg})
    
    max_iters = 5
    iters = 0
    
    while iters < max_iters:
        iters += 1
        response = call_llm(messages)
        
        # print COMMAND lines for visual streaming/debugging in logs
        for line in response.split("\n"):
            if line.strip().startswith("COMMAND:"):
                # We prefix with [INTERNAL] so we can filter if needed, 
                # but currently everything goes to the log/chat.
                # To keep chat clean, we could skip printing these if it's not the final response.
                pass
                
        messages.append({"role": "assistant", "content": response})
        
        cmd, _ = extract_command(response)
        if cmd:
            if is_dangerous(cmd) and hitl_enabled:
                print(f"[HITL] APPROVAL_REQUIRED: {cmd}", flush=True)
                if not wait_for_approval():
                    messages.append({"role": "user", "content": "ERROR: Command denied by user"})
                    continue
                print(f"[HITL] EXECUTING: {cmd}", flush=True)
            
            # Execute command
            try:
                result = subprocess.run(cmd, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
                out = result.stdout
                if not out:
                    out = "Command executed successfully with no output."
                # Mark command output as internal - don't show to user
                messages.append({"role": "user", "content": f"[INTERNAL_COMMAND_OUTPUT]\n{out}"})
            except Exception as e:
                messages.append({"role": "user", "content": f"ERROR executing command: {str(e)}"})
        else:
            # Done, no more commands. 
            # Filter out the internal system blocks from the final response if they exist
            clean_response = response.replace("ACTION: EXECUTE", "").strip()
            # If the response contained a COMMAND snippet but no ACTION, clean it up
            lines = clean_response.split("\n")
            filtered_lines = [l for l in lines if not l.strip().startswith("COMMAND:")]
            # Filter out command output blocks (lines starting with $ or # that look like shell prompts)
            final_lines = []
            skip_block = False
            for line in filtered_lines:
                # Skip blocks that look like command outputs (lines starting with $ or # after whitespace)
                if line.strip().startswith('$ ') or line.strip().startswith('# '):
                    skip_block = True
                    continue
                if skip_block and (line.strip() == '' or not line.startswith(' ') and not line.startswith('\t')):
                    skip_block = False
                if not skip_block:
                    final_lines.append(line)
            print("\n".join(final_lines).strip(), flush=True)
            break

if __name__ == "__main__":
    main()
