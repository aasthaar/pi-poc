/**
 * pi Chat Bridge Server
 * Spawns `pi --mode rpc --no-session` and bridges its JSONL stdin/stdout
 * protocol over WebSockets so a browser UI can talk to it.
 *
 * Usage:
 *   node server.js
 *
 * Then open index.html in your browser.
 */

const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT });

console.log(`[bridge] WebSocket server listening on ws://localhost:${PORT}`);
console.log(`[bridge] Open index.html in your browser to start chatting.\n`);

wss.on("connection", (ws) => {
  console.log("[bridge] Browser connected — spawning pi RPC process");

  // Spawn pi in RPC mode. Adjust the command if your binary has a different name.
  const agent = spawn("pi", ["--mode", "rpc", "--no-session","--model","openrouter/free"], {
    env: { ...process.env },
  });

  let agentAlive = true;

  // ── stdout: JSONL reader ──────────────────────────────────────────────────
  // The RPC spec requires splitting ONLY on LF (\n), not on Unicode line seps.
  // Node's readline is NOT spec-compliant here, so we roll our own.
  const decoder = new StringDecoder("utf8");
  let buf = "";

  agent.stdout.on("data", (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      // Forward raw JSONL event to browser
      try {
        JSON.parse(line); // validate before forwarding
        if (ws.readyState === ws.OPEN) ws.send(line);
      } catch {
        console.error("[bridge] unparseable stdout line:", line);
      }
    }
  });

  // ── stderr: log to console only ───────────────────────────────────────────
  agent.stderr.on("data", (d) => {
    process.stderr.write(`[pi stderr] ${d}`);
  });

  // ── agent exit ────────────────────────────────────────────────────────────
  agent.on("close", (code) => {
    agentAlive = false;
    console.log(`[bridge] pi process exited (code ${code})`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "_bridge", event: "agent_exited", code }));
      ws.close();
    }
  });

  // ── browser → agent: forward commands ────────────────────────────────────
  ws.on("message", (raw) => {
    if (!agentAlive) return;
    const text = raw.toString();
    try {
      JSON.parse(text); // validate
      agent.stdin.write(text + "\n");
    } catch {
      console.error("[bridge] received invalid JSON from browser:", text);
    }
  });

  // ── browser disconnect → kill agent ──────────────────────────────────────
  ws.on("close", () => {
    console.log("[bridge] Browser disconnected — killing pi process");
    if (agentAlive) agent.kill();
  });

  ws.on("error", (err) => {
    console.error("[bridge] WebSocket error:", err.message);
    if (agentAlive) agent.kill();
  });
});
